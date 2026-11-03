import type { PgBoss } from "pg-boss";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { assertCan, can } from "@/server/auth/rbac";
import { companyFilter } from "@/server/companies";
import { accountDb } from "@/server/db/client";
import { EuVendorIds } from "@/server/eushipments/connection";
import { enqueueEu, enqueueManualSync } from "@/server/eushipments/jobs";
import { enqueueFhb } from "@/server/fhb/jobs";
import type { ScopedActor } from "@/server/stores";

/**
 * Офиси, PUDO, потребители (P10-03): one searchable directory over what the read syncs already mirrored —
 * euShipments offices / parcel lockers (GET /offices-by-courier), cities (GET /get-cities), couriers
 * (GET /couriers), vendor companies (GET /get-user-companies) and warehouses; FHB carriers (GET /parcel-service)
 * and pick-up points (GET /delivery-point/{service}). Reads local tables only, never a vendor. The "Обнови"
 * buttons queue the EXISTING read jobs (eushipments.syncReference / syncCities / testConnection, fhb.sync).
 * Every row is owned by a connection, so every query is limited to the connections in the member's company /
 * product-line scope (companyFilter on FulfillmentConnection.companyId) and to the header warehouse scope.
 */

export type DirectoryCtx = ScopedActor & {
  activeCompanyId?: string | null;
  lineCompanyIds?: string[] | null;
};

export const DIRECTORY_TABS = ["offices", "couriers", "cities", "senders"] as const;
export type DirectoryTab = (typeof DIRECTORY_TABS)[number];
export const OFFICE_TYPES = ["office", "locker", "pudo"] as const;
export type OfficeType = (typeof OFFICE_TYPES)[number];
export const DIRECTORY_PAGE_SIZE = 50;

const DIRECTORY_TYPES = ["FHB_V3", "EUSHIPMENTS"] as const;
type DirType = (typeof DIRECTORY_TYPES)[number];

/** Zod at the screen boundary: everything comes from the URL. */
export const OfficeFilter = z.object({
  vendor: z.enum(["eu", "fhb"]).optional().catch(undefined),
  /** "eu:<courierId>" | "fhb:<service code>" */
  courier: z
    .string()
    .trim()
    .regex(/^(eu:\d{1,9}|fhb:[A-Za-z0-9_.-]{1,60})$/)
    .optional()
    .catch(undefined),
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((s) => s.toUpperCase())
    .optional()
    .catch(undefined),
  city: z.string().trim().max(80).optional().catch(undefined),
  type: z.enum(OFFICE_TYPES).optional().catch(undefined),
  q: z.string().trim().max(80).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).catch(1).default(1),
});
export type OfficeFilter = z.infer<typeof OfficeFilter>;

export const CityFilter = z.object({
  country: OfficeFilter.shape.country,
  q: OfficeFilter.shape.q,
  page: OfficeFilter.shape.page,
});
export type CityFilter = z.infer<typeof CityFilter>;

const blank = (s: string | undefined) => (s && s.length ? s : undefined);

/** Connections whose mirrors this member may read (company + line scope, header warehouse scope). */
export async function directoryConnections(ctx: DirectoryCtx, connectionTypes?: readonly string[]) {
  assertCan(ctx.role, "account.read");
  const types = DIRECTORY_TYPES.filter((t) => !connectionTypes || connectionTypes.includes(t));
  if (types.length === 0) return [];
  return accountDb(ctx.accountId).fulfillmentConnection.findMany({
    where: {
      type: { in: [...types] },
      ...companyFilter({
        companyScope: ctx.companyScope ?? null,
        activeCompanyId: ctx.activeCompanyId ?? null,
        lineCompanyIds: ctx.lineCompanyIds ?? null,
      }),
    },
    select: {
      id: true,
      name: true,
      type: true,
      enabled: true,
      liveMode: true,
      credentialId: true,
      vendorIds: true,
      companyId: true,
      company: { select: { name: true } },
      credential: { select: { hint: true } },
      eushipmentsSyncs: { select: { kind: true, lastOkAt: true, lastError: true, lastStartedAt: true } },
      fhbSyncStates: { select: { resource: true, lastOkAt: true, lastError: true, lastRunAt: true } },
    },
    orderBy: { name: "asc" },
  });
}
export type DirectoryConnection = Awaited<ReturnType<typeof directoryConnections>>[number];

const split = (conns: DirectoryConnection[]) => ({
  eu: conns.filter((c) => c.type === "EUSHIPMENTS"),
  fhb: conns.filter((c) => c.type === "FHB_V3"),
});

/** Which sync feeds which tab (shown as "последно обновяване" next to the Обнови button). */
const SYNC_OF: Record<DirectoryTab, { eu: string | null; fhb: string | null }> = {
  offices: { eu: "reference", fhb: "carriers" },
  couriers: { eu: "reference", fhb: "carriers" },
  cities: { eu: "cities", fhb: null },
  senders: { eu: "connection", fhb: null },
};

export function syncInfo(conns: DirectoryConnection[], tab: DirectoryTab) {
  const kinds = SYNC_OF[tab];
  return conns.flatMap((c) => {
    if (c.type === "EUSHIPMENTS" && kinds.eu) {
      const s = c.eushipmentsSyncs.find((x) => x.kind === kinds.eu);
      return [
        {
          connectionId: c.id,
          name: c.name,
          type: c.type as DirType,
          kind: kinds.eu,
          lastOkAt: s?.lastOkAt ?? null,
          lastError: s?.lastError ?? null,
        },
      ];
    }
    if (c.type === "FHB_V3" && kinds.fhb) {
      const s = c.fhbSyncStates.find((x) => x.resource === kinds.fhb);
      return [
        {
          connectionId: c.id,
          name: c.name,
          type: c.type as DirType,
          kind: kinds.fhb,
          lastOkAt: s?.lastOkAt ?? null,
          lastError: s?.lastError ?? null,
        },
      ];
    }
    return [];
  });
}

// ───────────────────────── offices and pick-up points ─────────────────────────

export interface OfficeRow {
  /** "eu.<row id>" | "fhb.<row id>" — the detail panel key. */
  key: string;
  vendor: "eu" | "fhb";
  connection: { id: string; name: string };
  /** What an operator pastes into an order: euShipments recipient.officeId / FHB delivery point id. */
  code: string;
  /** The courier's own office code (euShipments COURIER_OFFICE_CODE / FHB external_code). */
  courierCode: string | null;
  name: string;
  courier: string;
  city: string | null;
  postCode: string | null;
  address: string | null;
  country: string | null;
  type: OfficeType;
  codSupport: boolean | null;
  lastSyncAt: Date;
}

/** euShipments couriers report their country by name ("Hungary"); offices inherit it via the courier. */
async function euCourierCountries(accountId: string, connectionIds: string[]) {
  if (connectionIds.length === 0) return { couriers: [], countries: [] };
  const db = accountDb(accountId);
  const [couriers, countries] = await Promise.all([
    db.eushipmentsCourier.findMany({
      where: { connectionId: { in: connectionIds } },
      select: { connectionId: true, courierId: true, name: true, country: true, toOffice: true },
      orderBy: { name: "asc" },
    }),
    db.eushipmentsCountry.findMany({
      where: { connectionId: { in: connectionIds } },
      select: { connectionId: true, name: true, isoCode: true },
    }),
  ]);
  const iso = new Map(countries.map((c) => [`${c.connectionId}:${c.name.toLowerCase()}`, c.isoCode]));
  return {
    couriers: couriers.map((c) => ({
      ...c,
      iso: c.country ? (iso.get(`${c.connectionId}:${c.country.toLowerCase()}`) ?? null) : null,
    })),
    countries,
  };
}

const contains = (q: string) => ({ contains: q, mode: "insensitive" as const });

function euOfficeWhere(
  connectionIds: string[],
  f: OfficeFilter,
  couriers: { connectionId: string; courierId: number; iso: string | null }[],
): Prisma.EushipmentsOfficeWhereInput | null {
  if (f.vendor === "fhb" || f.type === "pudo" || f.courier?.startsWith("fhb:")) return null;
  if (connectionIds.length === 0) return null;
  const and: Prisma.EushipmentsOfficeWhereInput[] = [{ connectionId: { in: connectionIds } }];
  if (f.courier) and.push({ courierId: Number(f.courier.slice(3)) });
  if (f.country) {
    const pairs = couriers.filter((c) => c.iso === f.country);
    if (pairs.length === 0) return null;
    and.push({
      OR: pairs.map((p) => ({ connectionId: p.connectionId, courierId: p.courierId })),
    });
  }
  if (f.type) and.push({ isStation: f.type === "locker" });
  const city = blank(f.city);
  if (city) and.push({ OR: [{ cityName: contains(city) }, { postCode: { startsWith: city } }] });
  const q = blank(f.q);
  if (q) {
    const or: Prisma.EushipmentsOfficeWhereInput[] = [
      { name: contains(q) },
      { code: contains(q) },
      { address: contains(q) },
    ];
    if (/^\d{1,9}$/.test(q)) or.push({ officeId: Number(q) });
    and.push({ OR: or });
  }
  return { AND: and };
}

function fhbPointWhere(connectionIds: string[], f: OfficeFilter): Prisma.FhbPickupPointWhereInput | null {
  if (f.vendor === "eu" || f.courier?.startsWith("eu:")) return null;
  if (f.type && f.type !== "pudo") return null;
  if (connectionIds.length === 0) return null;
  const and: Prisma.FhbPickupPointWhereInput[] = [{ connectionId: { in: connectionIds } }];
  if (f.courier) and.push({ service: f.courier.slice(4) });
  if (f.country) and.push({ country: f.country });
  const city = blank(f.city);
  if (city) and.push({ OR: [{ city: contains(city) }, { zip: { startsWith: city } }] });
  const q = blank(f.q);
  if (q)
    and.push({
      OR: [
        { name: contains(q) },
        { vendorId: contains(q) },
        { externalCode: contains(q) },
        { street: contains(q) },
      ],
    });
  return { AND: and };
}

/**
 * One page of offices + pick-up points. Never loads a whole list: counts and one page per table, served as one
 * list (euShipments rows first, then FHB), so paging stays exact across both vendors.
 */
export async function listOffices(ctx: DirectoryCtx, raw: unknown, connectionTypes?: readonly string[]) {
  const f = OfficeFilter.parse(raw ?? {});
  const conns = await directoryConnections(ctx, connectionTypes);
  const { eu, fhb } = split(conns);
  const db = accountDb(ctx.accountId);
  const euIds = eu.map((c) => c.id);
  const fhbIds = fhb.map((c) => c.id);
  const { couriers, countries } = await euCourierCountries(ctx.accountId, euIds);
  const carriers = fhbIds.length
    ? await db.fhbCarrier.findMany({
        where: { connectionId: { in: fhbIds } },
        select: { connectionId: true, code: true, name: true },
        orderBy: { code: "asc" },
      })
    : [];
  const euWhere = euOfficeWhere(euIds, f, couriers);
  const fhbWhere = fhbPointWhere(fhbIds, f);
  const [euTotal, fhbTotal] = await Promise.all([
    euWhere ? db.eushipmentsOffice.count({ where: euWhere }) : 0,
    fhbWhere ? db.fhbPickupPoint.count({ where: fhbWhere }) : 0,
  ]);
  const total = euTotal + fhbTotal;
  const pages = Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE));
  const page = Math.min(f.page, pages);
  const offset = (page - 1) * DIRECTORY_PAGE_SIZE;
  const euSkip = Math.min(offset, euTotal);
  const euTake = Math.max(0, Math.min(DIRECTORY_PAGE_SIZE, euTotal - offset));
  const fhbSkip = Math.max(0, offset - euTotal);
  const fhbTake = DIRECTORY_PAGE_SIZE - euTake;
  const [euRows, fhbRows] = await Promise.all([
    euWhere && euTake > 0
      ? db.eushipmentsOffice.findMany({
          where: euWhere,
          orderBy: [{ cityName: { sort: "asc", nulls: "last" } }, { name: "asc" }, { id: "asc" }],
          skip: euSkip,
          take: euTake,
        })
      : [],
    fhbWhere && fhbTake > 0 && fhbSkip < fhbTotal
      ? db.fhbPickupPoint.findMany({
          where: fhbWhere,
          orderBy: [{ city: { sort: "asc", nulls: "last" } }, { name: "asc" }, { id: "asc" }],
          skip: fhbSkip,
          take: fhbTake,
        })
      : [],
  ]);
  const connName = new Map(conns.map((c) => [c.id, c.name]));
  const courierOf = new Map(couriers.map((c) => [`${c.connectionId}:${c.courierId}`, c]));
  const carrierOf = new Map(carriers.map((c) => [`${c.connectionId}:${c.code}`, c]));
  const rows: OfficeRow[] = [
    ...euRows.map((o): OfficeRow => {
      const c = courierOf.get(`${o.connectionId}:${o.courierId}`);
      return {
        key: `eu.${o.id}`,
        vendor: "eu",
        connection: { id: o.connectionId, name: connName.get(o.connectionId) ?? "—" },
        code: String(o.officeId),
        courierCode: o.code,
        name: o.name,
        courier: c?.name ?? String(o.courierId),
        city: o.cityName,
        postCode: o.postCode,
        address: o.address,
        country: c?.iso ?? c?.country ?? null,
        type: o.isStation ? "locker" : "office",
        codSupport: o.codSupport,
        lastSyncAt: o.syncedAt,
      };
    }),
    ...fhbRows.map((p): OfficeRow => {
      const c = carrierOf.get(`${p.connectionId}:${p.service}`);
      return {
        key: `fhb.${p.id}`,
        vendor: "fhb",
        connection: { id: p.connectionId, name: connName.get(p.connectionId) ?? "—" },
        code: p.vendorId,
        courierCode: p.externalCode,
        name: p.name ?? p.vendorId,
        courier: c?.name ? `${c.name}` : p.service,
        city: p.city,
        postCode: p.zip,
        address: p.street,
        country: p.country,
        type: "pudo",
        codSupport: null,
        lastSyncAt: p.lastSyncAt,
      };
    }),
  ];
  // Filter options: couriers that can have offices, FHB carriers with loaded lists, countries seen.
  const loadedServices = fhbIds.length
    ? await db.fhbPickupPoint.groupBy({
        by: ["service", "country"],
        where: { connectionId: { in: fhbIds } },
      })
    : [];
  const courierOptions = [
    ...uniqBy(
      couriers.filter((c) => c.toOffice),
      (c) => String(c.courierId),
    ).map((c) => ({ value: `eu:${c.courierId}`, label: c.name, vendor: "eu" as const })),
    ...uniqBy(carriers, (c) => c.code).map((c) => ({
      value: `fhb:${c.code}`,
      label: c.name ? `${c.name} (${c.code})` : c.code,
      vendor: "fhb" as const,
    })),
  ];
  const countryOptions = [
    ...new Set(
      [
        ...couriers.filter((c) => c.toOffice).map((c) => c.iso),
        ...loadedServices.map((s) => s.country),
        ...countries.map((c) => c.isoCode),
      ].filter((x): x is string => !!x && /^[A-Z]{2}$/.test(x)),
    ),
  ].sort();
  return {
    filter: { ...f, page },
    rows,
    total,
    totals: { eu: euTotal, fhb: fhbTotal },
    page,
    pages,
    options: { couriers: courierOptions, countries: countryOptions },
    connections: conns,
  };
}

function uniqBy<T>(xs: T[], key: (x: T) => string) {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
}

const OfficeKey = z.string().regex(/^(eu|fhb)\.[A-Za-z0-9_-]{1,40}$/);

/** All mirrored fields of one office / pick-up point, or null when it is outside the member's scope. */
export async function getOffice(ctx: DirectoryCtx, key: string, connectionTypes?: readonly string[]) {
  const k = OfficeKey.safeParse(key);
  if (!k.success) return null;
  const [vendor, id] = k.data.split(".") as ["eu" | "fhb", string];
  const conns = await directoryConnections(ctx, connectionTypes);
  const db = accountDb(ctx.accountId);
  if (vendor === "eu") {
    const ids = conns.filter((c) => c.type === "EUSHIPMENTS").map((c) => c.id);
    const o = await db.eushipmentsOffice.findFirst({ where: { id, connectionId: { in: ids } } });
    if (!o) return null;
    const { couriers } = await euCourierCountries(ctx.accountId, [o.connectionId]);
    const courier = couriers.find((c) => c.courierId === o.courierId) ?? null;
    const hours = z
      .object({
        weekday: z.array(z.string().nullable()).optional(),
        saturday: z.array(z.string().nullable()).optional(),
      })
      .safeParse(o.workHours);
    return {
      vendor: "eu" as const,
      key: k.data,
      connection: conns.find((c) => c.id === o.connectionId)!,
      code: String(o.officeId),
      office: o,
      courier,
      workHours: hours.success ? hours.data : null,
    };
  }
  const ids = conns.filter((c) => c.type === "FHB_V3").map((c) => c.id);
  const p = await db.fhbPickupPoint.findFirst({ where: { id, connectionId: { in: ids } } });
  if (!p) return null;
  const carrier = await db.fhbCarrier.findFirst({
    where: { connectionId: p.connectionId, code: p.service },
    select: { code: true, name: true },
  });
  return {
    vendor: "fhb" as const,
    key: k.data,
    connection: conns.find((c) => c.id === p.connectionId)!,
    code: p.vendorId,
    point: p,
    carrier,
  };
}

// ───────────────────────── couriers ─────────────────────────

export async function listCouriers(ctx: DirectoryCtx, connectionTypes?: readonly string[]) {
  const conns = await directoryConnections(ctx, connectionTypes);
  const { eu, fhb } = split(conns);
  const db = accountDb(ctx.accountId);
  const euIds = eu.map((c) => c.id);
  const fhbIds = fhb.map((c) => c.id);
  const [{ couriers }, officeCounts, carriers, pointCounts] = await Promise.all([
    euCourierCountries(ctx.accountId, euIds),
    euIds.length
      ? db.eushipmentsOffice.groupBy({
          by: ["connectionId", "courierId"],
          where: { connectionId: { in: euIds } },
          _count: { _all: true },
        })
      : [],
    fhbIds.length
      ? db.fhbCarrier.findMany({ where: { connectionId: { in: fhbIds } }, orderBy: { code: "asc" } })
      : [],
    fhbIds.length
      ? db.fhbPickupPoint.groupBy({
          by: ["connectionId", "service"],
          where: { connectionId: { in: fhbIds } },
          _count: { _all: true },
        })
      : [],
  ]);
  const euFull = euIds.length
    ? await db.eushipmentsCourier.findMany({
        where: { connectionId: { in: euIds } },
        orderBy: [{ name: "asc" }, { courierId: "asc" }],
      })
    : [];
  const isoOf = new Map(couriers.map((c) => [`${c.connectionId}:${c.courierId}`, c.iso]));
  const offices = new Map(officeCounts.map((o) => [`${o.connectionId}:${o.courierId}`, o._count._all]));
  const points = new Map(pointCounts.map((p) => [`${p.connectionId}:${p.service}`, p._count._all]));
  const name = new Map(conns.map((c) => [c.id, c.name]));
  return {
    connections: conns,
    eu: euFull.map((c) => ({
      id: c.id,
      connection: { id: c.connectionId, name: name.get(c.connectionId) ?? "—" },
      courierId: c.courierId,
      name: c.name,
      country: c.country,
      iso: isoOf.get(`${c.connectionId}:${c.courierId}`) ?? null,
      currency: c.currency,
      toOffice: c.toOffice,
      toAddress: c.toAddress,
      offices: offices.get(`${c.connectionId}:${c.courierId}`) ?? 0,
      syncedAt: c.syncedAt,
    })),
    fhb: carriers.map((c) => ({
      id: c.id,
      connection: { id: c.connectionId, name: name.get(c.connectionId) ?? "—" },
      code: c.code,
      name: c.name,
      points: points.get(`${c.connectionId}:${c.code}`) ?? 0,
      syncedAt: c.lastSyncAt,
    })),
  };
}

// ───────────────────────── cities ─────────────────────────

export async function listCities(ctx: DirectoryCtx, raw: unknown, connectionTypes?: readonly string[]) {
  const f = CityFilter.parse(raw ?? {});
  const conns = (await directoryConnections(ctx, connectionTypes)).filter((c) => c.type === "EUSHIPMENTS");
  const ids = conns.map((c) => c.id);
  const db = accountDb(ctx.accountId);
  const countries = ids.length
    ? await db.eushipmentsCountry.findMany({
        where: { connectionId: { in: ids } },
        select: { connectionId: true, countryId: true, name: true, isoCode: true },
        orderBy: { name: "asc" },
      })
    : [];
  const loaded = ids.length
    ? await db.eushipmentsCity.groupBy({
        by: ["connectionId", "countryId"],
        where: { connectionId: { in: ids } },
        _count: { _all: true },
      })
    : [];
  const and: Prisma.EushipmentsCityWhereInput[] = [{ connectionId: { in: ids } }];
  if (f.country) {
    const pairs = countries.filter((c) => c.isoCode === f.country);
    and.push(
      pairs.length
        ? { OR: pairs.map((p) => ({ connectionId: p.connectionId, countryId: p.countryId })) }
        : { id: "__none__" },
    );
  }
  const q = blank(f.q);
  if (q) {
    const or: Prisma.EushipmentsCityWhereInput[] = [
      { nameLocal: contains(q) },
      { nameEn: contains(q) },
      { postalCode: { startsWith: q } },
      { county: contains(q) },
    ];
    if (/^\d{1,9}$/.test(q)) or.push({ cityId: Number(q) });
    and.push({ OR: or });
  }
  const where = { AND: and };
  const total = ids.length ? await db.eushipmentsCity.count({ where }) : 0;
  const pages = Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE));
  const page = Math.min(f.page, pages);
  const rows = ids.length
    ? await db.eushipmentsCity.findMany({
        where,
        orderBy: [{ nameLocal: "asc" }, { id: "asc" }],
        skip: (page - 1) * DIRECTORY_PAGE_SIZE,
        take: DIRECTORY_PAGE_SIZE,
      })
    : [];
  const countryOf = new Map(countries.map((c) => [`${c.connectionId}:${c.countryId}`, c]));
  const name = new Map(conns.map((c) => [c.id, c.name]));
  return {
    filter: { ...f, page },
    total,
    page,
    pages,
    connections: conns,
    countries: [...new Set(countries.map((c) => c.isoCode).filter((x): x is string => !!x))].sort(),
    loaded: loaded.map((l) => ({
      connectionId: l.connectionId,
      connection: name.get(l.connectionId) ?? "—",
      country: countryOf.get(`${l.connectionId}:${l.countryId}`)?.name ?? String(l.countryId),
      iso: countryOf.get(`${l.connectionId}:${l.countryId}`)?.isoCode ?? null,
      count: l._count._all,
    })),
    rows: rows.map((c) => ({
      ...c,
      connection: name.get(c.connectionId) ?? "—",
      country: countryOf.get(`${c.connectionId}:${c.countryId}`) ?? null,
    })),
  };
}

// ───────────────────────── users / sender ─────────────────────────

/**
 * Потребители / подател: per euShipments connection the vendor companies the token sees (one of them is this
 * connection's sender = vendorIds.companyId) and its warehouses; per FHB connection the account it uses
 * (CRM company, masked app id hint — never the credential itself), mode and freshness.
 */
export async function listSenders(ctx: DirectoryCtx, connectionTypes?: readonly string[]) {
  const conns = await directoryConnections(ctx, connectionTypes);
  const { eu, fhb } = split(conns);
  const db = accountDb(ctx.accountId);
  const euIds = eu.map((c) => c.id);
  const [companies, warehouses] = euIds.length
    ? await Promise.all([
        db.eushipmentsVendorCompany.findMany({
          where: { connectionId: { in: euIds } },
          orderBy: [{ name: "asc" }, { vendorCompanyId: "asc" }],
        }),
        db.eushipmentsWarehouse.findMany({
          where: { connectionId: { in: euIds } },
          orderBy: [{ name: "asc" }],
        }),
      ])
    : [[], []];
  return {
    connections: conns,
    eu: eu.map((c) => {
      const ids = EuVendorIds.safeParse(c.vendorIds);
      const senderId = ids.success ? ids.data.companyId : null;
      return {
        connection: c,
        senderId,
        companies: companies
          .filter((x) => x.connectionId === c.id)
          .map((x) => ({ ...x, isSender: x.vendorCompanyId === senderId })),
        warehouses: warehouses.filter((w) => w.connectionId === c.id),
        test: c.eushipmentsSyncs.find((s) => s.kind === "connection") ?? null,
      };
    }),
    fhb: fhb.map((c) => ({
      connection: c,
      lastOk:
        c.fhbSyncStates
          .map((s) => s.lastOkAt)
          .filter((d): d is Date => !!d)
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
      errors: c.fhbSyncStates.filter((s) => s.lastError).map((s) => s.resource),
    })),
  };
}

// ───────────────────────── "Обнови" ─────────────────────────

/**
 * Queues the existing read jobs that fill a tab, for every connection in scope that can be read. Read calls
 * only (GET/list); stately queues keep one queued + one running per key, so repeated clicks add nothing.
 */
export async function refreshDirectory(
  ctx: DirectoryCtx,
  tab: DirectoryTab,
  boss: PgBoss,
  connectionTypes?: readonly string[],
) {
  if (!DIRECTORY_TABS.includes(tab)) throw new DomainError("invalid");
  const mayEu = can(ctx.role, "eushipments.sync");
  const mayFhb = can(ctx.role, "connections.sync");
  if (!mayEu && !mayFhb) assertCan(ctx.role, "connections.sync");
  const conns = (await directoryConnections(ctx, connectionTypes)).filter(
    (c) => c.enabled && !!c.credentialId,
  );
  let queued = 0;
  let already = 0;
  const count = (id: string | null) => (id ? queued++ : already++);
  for (const c of conns) {
    const data = { accountId: ctx.accountId, connectionId: c.id };
    if (c.type === "EUSHIPMENTS" && mayEu) {
      if (tab === "senders") count(await enqueueManualSync(boss, "test", data));
      else if (tab === "cities") {
        const loaded = await accountDb(ctx.accountId).eushipmentsCity.groupBy({
          by: ["countryId"],
          where: { connectionId: c.id },
        });
        for (const l of loaded) count(await enqueueEu.syncCities(boss, { ...data, countryId: l.countryId }));
      } else if (EuVendorIds.safeParse(c.vendorIds).success) {
        count(await enqueueEu.syncReference(boss, data));
      }
    }
    if (c.type === "FHB_V3" && mayFhb && (tab === "offices" || tab === "couriers")) {
      // Carriers refresh also re-reads every pick-up point list loaded so far (fhb/sync.ts).
      count(await enqueueFhb.sync(boss, { ...data, resource: "carriers", force: true }));
    }
  }
  return { queued, already };
}
