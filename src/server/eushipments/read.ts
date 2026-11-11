import type { CrmOrderStatus, Prisma } from "@/generated/prisma/client";
import { lineProductWhere } from "@/server/lines/lines";
import type { EuShipmentsClient, EuShipmentsClientOptions } from "@/integrations/eushipments/client";
import { classifyHistoryItem, historyItemFor } from "@/integrations/eushipments/client";
import { ORDERS_HISTORY_BATCH } from "@/integrations/eushipments/config";
import { EuShipmentsError } from "@/integrations/eushipments/errors";
import type { ProdAvail } from "@/integrations/eushipments/schemas";
import { parseVendorDate } from "@/integrations/eushipments/status-map";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import { DomainError } from "@/server/accounts";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { euReadClientFor } from "./connection";
import { advanceOrderStatus, applyOrderHistory, EU_EVENT_SOURCE, markGoneAtVendor } from "./statuses";
import { refreshSuspiciousLinksSafe } from "@/server/products/suspicious";

/**
 * euShipments read side (P3-02). Only GET/list calls (plus the documented read-only POSTs
 * fulfilment/warehouses, orders-history and booking-request-status) — allowed in every liveMode, including
 * READ_ONLY. Each sync mirrors one vendor list into the CRM for one connection and records its freshness in
 * EushipmentsSync. Products land in VendorProduct (vendorId = REFERENCE_NUMBER, the join key the vendor
 * uses in orders and bookings) and are matched to the group's master Product by SKU with the connection's
 * prefix stripped — never by EAN (get-products does not even return the barcode).
 */

export type SyncKind =
  "connection" | "reference" | "cities" | "products" | "stock" | "orders" | "bookings" | "cod";

export interface ReadDeps {
  clientOptions?: EuShipmentsClientOptions;
  now?: Date;
}

type Tx = Prisma.TransactionClient;
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;
/** A whole number that fits the database's 32-bit columns; anything else (text, out of range) is null. */
const int = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  if (!Number.isFinite(n)) return null;
  const t = Math.trunc(n);
  return t >= -2147483648 && t <= 2147483647 ? t : null;
};
/** Mirror writes of many rows: Prisma's 5 s default is too short for a slow database moment. */
const MIRROR_TX = { timeout: 60_000, maxWait: 15_000 };
const text = (v: unknown, max = 300) =>
  v === null || v === undefined || v === "" ? null : String(v).slice(0, max);

/** Runs one sync and records start / success / scrubbed error. The error is re-thrown for the job's retry. */
/** Rows per transaction when a mirror list is replaced (offices, cities). */
const SYNC_BATCH = 500;

async function tracked<T extends Record<string, unknown>>(
  accountId: string,
  connectionId: string,
  kind: SyncKind,
  fn: () => Promise<T>,
): Promise<T> {
  const db = accountDb(accountId);
  const own = await db.fulfillmentConnection.findUnique({
    where: { id: connectionId },
    select: { type: true },
  });
  if (!own || own.type !== "EUSHIPMENTS") throw new DomainError("not_found");
  const key = { connectionId_kind: { connectionId, kind } };
  await db.eushipmentsSync.upsert({
    where: key,
    create: { accountId, connectionId, kind, lastStartedAt: new Date() },
    update: { lastStartedAt: new Date() },
  });
  try {
    const info = await fn();
    await db.eushipmentsSync.update({
      where: key,
      data: { lastOkAt: new Date(), lastError: null, info: json(info) },
    });
    return info;
  } catch (err) {
    // Database errors carry internals (queries, timeouts) that mean nothing on the screen: log them, show a code.
    const dbError = /^PrismaClient/.test((err as Error)?.constructor?.name ?? "");
    if (dbError)
      logger.error({ connectionId, kind, err: (err as Error).message }, "euShipments sync: database error");
    // The Prisma error code and table (e.g. "db_error:P2028:EushipmentsCountry") say what failed without internals.
    const pe = err as { code?: unknown; meta?: { modelName?: unknown } };
    const dbCode = [pe.code, pe.meta?.modelName]
      .filter((x): x is string => typeof x === "string" && /^[A-Za-z0-9_]{1,40}$/.test(x))
      .join(":");
    const message =
      err instanceof DomainError
        ? err.code
        : dbError
          ? `db_error${dbCode ? `:${dbCode}` : ""}`
          : scrubText(String((err as Error)?.message ?? err), 500);
    await db.eushipmentsSync.update({ where: key, data: { lastError: message } });
    throw err;
  }
}

async function needCompany(accountId: string, connectionId: string, deps: ReadDeps) {
  const c = await euReadClientFor(accountId, connectionId, deps.clientOptions);
  if (!c.companyId) throw new DomainError("no_company_id");
  return c as typeof c & { companyId: number };
}

// ───────────────────────── connection test / companies ─────────────────────────

/** GET /get-user-companies: proves the token works and mirrors the companies it can see. */
export async function testEuConnection(accountId: string, connectionId: string, deps: ReadDeps = {}) {
  return tracked(accountId, connectionId, "connection", async () => {
    const { client, companyId } = await euReadClientFor(accountId, connectionId, deps.clientOptions);
    const companies = await client.getUserCompanies();
    const now = deps.now ?? new Date();
    const ids = companies.map((c) => int(c.ID)).filter((n): n is number => !!n && n > 0);
    await withAccountTransaction(accountId, async (tx) => {
      await tx.eushipmentsVendorCompany.deleteMany({
        where: { connectionId, vendorCompanyId: { notIn: ids } },
      });
      for (const c of companies) {
        const vendorCompanyId = int(c.ID);
        if (!vendorCompanyId || vendorCompanyId <= 0) continue;
        // Only what the CRM needs to pick and label the company (no address / representative).
        const data = { name: c.NAME.slice(0, 200), bulstat: text(c.BULSTAT, 30), syncedAt: now };
        await tx.eushipmentsVendorCompany.upsert({
          where: { connectionId_vendorCompanyId: { connectionId, vendorCompanyId } },
          create: { accountId, connectionId, vendorCompanyId, ...data },
          update: data,
        });
      }
    });
    if (companyId && !ids.includes(companyId)) throw new DomainError("company_not_visible");
    return { companies: ids.length, companyVisible: companyId ? true : null };
  });
}

// ───────────────────────── couriers, warehouses, countries, offices ─────────────────────────

const OFFICES_PER_PAGE = 1000;
const MAX_PAGES = 200;

export async function syncEuReference(accountId: string, connectionId: string, deps: ReadDeps = {}) {
  return tracked(accountId, connectionId, "reference", async () => {
    const { client, companyId } = await needCompany(accountId, connectionId, deps);
    const now = deps.now ?? new Date();
    const couriers = await client.getCouriers(companyId);
    const warehouses = await client.getWarehouses(companyId);
    const countries = await client.getCountries();

    await withAccountTransaction(
      accountId,
      async (tx) => {
        const courierIds = couriers.map((c) => int(c.ID)).filter((n): n is number => !!n);
        await tx.eushipmentsCourier.deleteMany({ where: { connectionId, courierId: { notIn: courierIds } } });
        for (const c of couriers) {
          const courierId = int(c.ID);
          if (!courierId) continue;
          const data = {
            name: c.NAME.slice(0, 200),
            toOffice: c.TO_OFFICE,
            toAddress: c.TO_ADDRESS,
            country: text(c.COUNTRY, 100),
            currency: text(c.CURRENCY, 10),
            syncedAt: now,
          };
          await tx.eushipmentsCourier.upsert({
            where: { connectionId_courierId: { connectionId, courierId } },
            create: { accountId, connectionId, courierId, ...data },
            update: data,
          });
        }
      },
      MIRROR_TX,
    );
    await withAccountTransaction(
      accountId,
      async (tx) => {
        const warehouseIds = warehouses.map((w) => int(w.id)).filter((n): n is number => !!n);
        await tx.eushipmentsWarehouse.deleteMany({
          where: { connectionId, warehouseId: { notIn: warehouseIds } },
        });
        for (const w of warehouses) {
          const warehouseId = int(w.id);
          if (!warehouseId) continue;
          const data = {
            name: w.name.slice(0, 200),
            countryId: int(w.country?.id),
            countryIso: text(w.country?.iso, 2),
            countryName: text(w.country?.name, 100),
            syncedAt: now,
          };
          await tx.eushipmentsWarehouse.upsert({
            where: { connectionId_warehouseId: { connectionId, warehouseId } },
            create: { accountId, connectionId, warehouseId, ...data },
            update: data,
          });
        }
        await tx.fulfillmentConnection.update({
          where: { id: connectionId },
          data: { warehouseIds: warehouseIds.map(String) },
        });
      },
      MIRROR_TX,
    );
    await withAccountTransaction(
      accountId,
      async (tx) => {
        const countryIds = countries.map((c) => int(c.ID)).filter((n): n is number => !!n);
        await tx.eushipmentsCountry.deleteMany({ where: { connectionId, countryId: { notIn: countryIds } } });
        for (const c of countries) {
          const countryId = int(c.ID);
          if (!countryId) continue;
          const data = {
            name: c.NAME.slice(0, 100),
            cyrillicName: text(c.CYRILLIC_NAME, 100),
            isoCode: text(c.ISO_CODE, 2)?.toUpperCase() ?? null,
            syncedAt: now,
          };
          await tx.eushipmentsCountry.upsert({
            where: { connectionId_countryId: { connectionId, countryId } },
            create: { accountId, connectionId, countryId, ...data },
            update: data,
          });
        }
      },
      MIRROR_TX,
    );

    // Offices / parcel lockers only for couriers that deliver to an office (recipient.officeId comes from here).
    let offices = 0;
    const officeCouriers = couriers.filter((c) => c.TO_OFFICE).map((c) => int(c.ID)!);
    for (const courierId of officeCouriers.filter(Boolean)) {
      offices += await syncOfficesOfCourier(accountId, connectionId, client, courierId, now);
    }
    await accountDb(accountId).eushipmentsOffice.deleteMany({
      where: { connectionId, courierId: { notIn: officeCouriers } },
    });
    return { couriers: couriers.length, warehouses: warehouses.length, countries: countries.length, offices };
  });
}

async function syncOfficesOfCourier(
  accountId: string,
  connectionId: string,
  client: EuShipmentsClient,
  courierId: number,
  now: Date,
) {
  // Written page by page (never the whole courier list in memory or in one transaction: the worker has
  // little memory and a large courier has tens of thousands of offices). Rows this run did not see are
  // removed at the end, so the list is never empty while it is being refreshed.
  let count = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await client.getOfficesPage(courierId, page, OFFICES_PER_PAGE);
    const rows: Prisma.EushipmentsOfficeCreateManyInput[] = [];
    for (const o of res.offices) {
      const officeId = int(o.ID);
      if (!officeId) continue;
      rows.push({
        accountId,
        connectionId,
        officeId,
        courierId,
        name: o.OFFICE_NAME.slice(0, 200),
        code: text(o.COURIER_OFFICE_CODE, 50),
        // Missing = null (never 0).
        courierOfficeId:
          o.COURIER_OFFICE_ID == null || o.COURIER_OFFICE_ID === "" ? null : int(o.COURIER_OFFICE_ID),
        cityId: int(o.GROUP_CITY_ID ?? o.CITY_ID),
        cityName: text(o.CITY_NAME, 100),
        address: text(o.ADDRESS, 300),
        postCode: text(o.POST_CODE, 20),
        region: text(o.REGION, 100),
        isStation: o.IS_STATION,
        codSupport: o.COD_SUPPORT,
        latitude: text(o.LATITUDE, 30),
        longitude: text(o.LONGITUDE, 30),
        workHours: json({
          weekday: [o.WORK_BEGIN ?? null, o.WORK_END ?? null],
          saturday: [o.WORK_BEGIN_SATURDAY ?? null, o.WORK_END_SATURDAY ?? null],
        }),
        syncedAt: now,
      });
    }
    for (let i = 0; i < rows.length; i += SYNC_BATCH) {
      const batch = rows.slice(i, i + SYNC_BATCH);
      await withAccountTransaction(
        accountId,
        async (tx) => {
          await tx.eushipmentsOffice.deleteMany({
            where: { connectionId, officeId: { in: batch.map((r) => r.officeId) } },
          });
          await tx.eushipmentsOffice.createMany({ data: batch, skipDuplicates: true });
        },
        MIRROR_TX,
      );
    }
    count += rows.length;
    if (page >= res.pagination.last_page || res.offices.length === 0) break;
  }
  await accountDb(accountId).eushipmentsOffice.deleteMany({
    where: { connectionId, courierId, syncedAt: { lt: now } },
  });
  return count;
}

// ───────────────────────── cities (on demand, per country) ─────────────────────────

const CITIES_PAGE = 1000;
/** Cities_Web_Service: not available for Great Britain (countryId 23) — the spec points to suggestions instead. */
export const CITIES_UNSUPPORTED = new Set([23]);

export async function syncEuCities(
  accountId: string,
  connectionId: string,
  countryId: number,
  deps: ReadDeps = {},
) {
  return tracked(accountId, connectionId, "cities", async () => {
    if (CITIES_UNSUPPORTED.has(countryId)) throw new DomainError("cities_unsupported");
    const { client } = await euReadClientFor(accountId, connectionId, deps.clientOptions);
    const now = deps.now ?? new Date();
    const rows: Prisma.EushipmentsCityCreateManyInput[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const chunk = await client.getCities(countryId, CITIES_PAGE, page * CITIES_PAGE);
      for (const c of chunk) {
        const cityId = int(c.ID);
        if (!cityId) continue;
        rows.push({
          accountId,
          connectionId,
          countryId,
          cityId,
          postalCode: text(c.POSTAL_CODE, 20),
          nameLocal: c.CITY_NAME_LOCAL.slice(0, 150),
          nameEn: text(c.CITY_NAME_EN, 150),
          county: text(c.COUNTY, 150),
          countyEn: text(c.COUNTY_EN, 150),
          syncedAt: now,
        });
      }
      if (chunk.length < CITIES_PAGE) break;
    }
    // Same batching as the offices (a country can have tens of thousands of cities).
    for (let i = 0; i < rows.length; i += SYNC_BATCH) {
      const batch = rows.slice(i, i + SYNC_BATCH);
      await withAccountTransaction(
        accountId,
        async (tx) => {
          await tx.eushipmentsCity.deleteMany({
            where: { connectionId, cityId: { in: batch.map((r) => r.cityId) } },
          });
          await tx.eushipmentsCity.createMany({ data: batch, skipDuplicates: true });
        },
        MIRROR_TX,
      );
    }
    await accountDb(accountId).eushipmentsCity.deleteMany({
      where: { connectionId, countryId, syncedAt: { lt: now } },
    });
    return { countryId, cities: rows.length };
  });
}

// ───────────────────────── products ─────────────────────────

/** The connection's SKU prefix rule ({"prefix":"SK-"}). */
export function prefixOf(rule: unknown): string {
  return rule && typeof rule === "object" && typeof (rule as { prefix?: unknown }).prefix === "string"
    ? (rule as { prefix: string }).prefix.trim()
    : "";
}

/** refNumber → master SKU candidate: the connection's prefix stripped (case-insensitive). */
export function masterSkuFor(refNumber: string, rule: unknown): string {
  const ref = refNumber.trim();
  const p = prefixOf(rule);
  return p && ref.toLowerCase().startsWith(p.toLowerCase()) && ref.length > p.length
    ? ref.slice(p.length)
    : ref;
}

/** A product missing from get-products is archived only after this grace (a just-created one may lag). */
const ARCHIVE_GRACE_MS = 60 * 60_000;

/**
 * GET /fulfilment/get-products → VendorProduct. New rows are auto-matched to exactly one master Product by SKU
 * (prefix stripped, case-insensitive); an existing link — automatic or manual — is never changed here. The
 * vendor's EAN is not in this answer, so vendorEan is left as it is (never written from our data).
 */
export async function syncEuProducts(accountId: string, connectionId: string, deps: ReadDeps = {}) {
  return tracked(accountId, connectionId, "products", async () => {
    const { client, companyId, connection } = await needCompany(accountId, connectionId, deps);
    const now = deps.now ?? new Date();
    const rows = await client.getProducts(companyId);
    // Automatic matching stays inside the connection's product line (P5-00).
    const lineId = await lineOfConnection(accountId, connectionId);
    let created = 0;
    let matched = 0;
    const seen = new Set<string>();
    // What euShipments returned vs what is kept (owner report 2026-11-09: 318 of 3000+ products shown). A row
    // without a refNumber cannot be stored; rows sharing a refNumber are one product here (the first one).
    let emptyRef = 0;
    const dupCount = new Map<string, number>();
    for (const r of rows) {
      const vendorId = r.REFERENCE_NUMBER.trim();
      if (!vendorId) {
        emptyRef++;
        continue;
      }
      if (seen.has(vendorId)) {
        dupCount.set(vendorId, (dupCount.get(vendorId) ?? 1) + 1);
        continue;
      }
      seen.add(vendorId);
      const raw = json({
        name: r.NAME ?? null,
        description: r.DESCRIPTION ?? null,
        length: r.LENGTH_ITEM ?? null,
        width: r.WIDTH ?? null,
        height: r.HEIGHT ?? null,
        weight: r.WEIGHT ?? null,
      });
      const res = await withAccountTransaction(accountId, async (tx) => {
        const existing = await tx.vendorProduct.findUnique({
          where: { connectionId_vendorId: { connectionId, vendorId } },
          select: { id: true, productId: true, unlinkedAt: true },
        });
        // Linked already, or unlinked by a person (suspicious link): never matched by SKU again.
        const link =
          existing?.productId || existing?.unlinkedAt
            ? null
            : await matchMaster(tx, masterSkuFor(vendorId, connection.skuPrefixRule), lineId);
        const data = {
          vendorCode: String(r.ID),
          archived: false,
          lastSyncAt: now,
          raw,
          ...(link ? { productId: link } : {}),
        };
        if (existing) await tx.vendorProduct.update({ where: { id: existing.id }, data });
        else await tx.vendorProduct.create({ data: { accountId, connectionId, vendorId, ...data } });
        return { created: !existing, matched: !!link };
      });
      if (res.created) created++;
      if (res.matched) matched++;
    }
    const archived = await accountDb(accountId).vendorProduct.updateMany({
      where: {
        connectionId,
        archived: false,
        vendorId: { notIn: [...seen] },
        OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: new Date(now.getTime() - ARCHIVE_GRACE_MS) } }],
      },
      data: { archived: true },
    });
    const unmatched = await accountDb(accountId).vendorProduct.count({
      where: { connectionId, archived: false, productId: null },
    });
    await refreshSuspiciousLinksSafe(accountId, { vendors: { connectionId } }, "eushipments_products");
    if (emptyRef || dupCount.size)
      logger.warn(
        { connectionId, returned: rows.length, emptyRef, duplicateRefs: dupCount.size },
        "euShipments products: rows without or with a repeated refNumber",
      );
    return {
      rows: seen.size,
      returned: rows.length,
      emptyRef,
      duplicateRefs: dupCount.size,
      duplicateRows: [...dupCount.values()].reduce((a, n) => a + n - 1, 0),
      duplicateSamples: [...dupCount.keys()].slice(0, 5).map((k) => k.slice(0, 60)),
      created,
      matched,
      unmatched,
      archived: archived.count,
    };
  });
}

async function lineOfConnection(accountId: string, connectionId: string) {
  const c = await accountDb(accountId).fulfillmentConnection.findUnique({
    where: { id: connectionId },
    select: { company: { select: { lineId: true } } },
  });
  return c?.company?.lineId ?? null;
}

async function matchMaster(tx: Tx, sku: string, lineId: string | null) {
  if (!sku) return null;
  const products = await tx.product.findMany({
    where: { sku: { equals: sku, mode: "insensitive" }, archived: false, ...lineProductWhere(lineId) },
    select: { id: true },
    take: 2,
  });
  // Two masters differing only by case are ambiguous: leave it to a person.
  return products.length === 1 ? products[0]!.id : null;
}

// ───────────────────────── stock ─────────────────────────

const norm = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Which get-prod-avails rows belong to this connection. The call has no parameters and returns the rows of
 * EVERY company of the token; a row only names its company by CUST_NAME. With one company on the token all
 * rows are ours; otherwise only rows whose CUST_NAME equals our company's name (from get-user-companies).
 * `unattributed` counts rows whose CUST_NAME matches none of the token's companies; `ambiguous` is set when
 * another company of the token has the same (normalised) name, so no row can be attributed safely.
 */
export function rowsForCompany(
  rows: ProdAvail[],
  companies: { vendorCompanyId: number; name: string }[],
  companyId: number,
): { rows: ProdAvail[]; unattributed: number; ambiguous?: boolean } {
  if (companies.length === 0) return { rows: [], unattributed: rows.length };
  if (companies.length === 1)
    return companies[0]!.vendorCompanyId === companyId
      ? { rows, unattributed: 0 }
      : { rows: [], unattributed: rows.length };
  const ours = companies.find((c) => c.vendorCompanyId === companyId);
  if (!ours) return { rows: [], unattributed: rows.length };
  const name = norm(ours.name);
  const known = new Set(companies.map((c) => norm(c.name)));
  const unattributed = rows.filter((r) => !known.has(norm(r.CUST_NAME))).length;
  if (companies.filter((c) => norm(c.name) === name).length > 1)
    return { rows: [], unattributed, ambiguous: true };
  return { rows: rows.filter((r) => norm(r.CUST_NAME) === name), unattributed };
}

/**
 * GET /fulfilment/get-prod-avails → EushipmentsStock (per warehouse) and StockLevel (per product: sum over
 * warehouses, source POLL, snapshotAt = the vendor's AVAIL_DATE). The snapshot replaces the previous one; a
 * linked product missing from it has 0 available. The vendor gives one "available" number: it is stored as
 * physical and free; CRM reservations stay as they are.
 */
export async function syncEuStock(accountId: string, connectionId: string, deps: ReadDeps = {}) {
  return tracked(accountId, connectionId, "stock", async () => {
    const { client, companyId } = await needCompany(accountId, connectionId, deps);
    const now = deps.now ?? new Date();
    const companies = await accountDb(accountId).eushipmentsVendorCompany.findMany({
      where: { connectionId },
      select: { vendorCompanyId: true, name: true },
    });
    if (companies.length === 0) throw new DomainError("companies_not_synced");
    const all = await client.getProdAvails();
    const { rows, unattributed, ambiguous } = rowsForCompany(all, companies, companyId);
    // Never zero a catalogue on an attribution problem: with several companies on the token, rows that exist
    // but none of them is ours (a CUST_NAME that differs from get-user-companies) fail the sync visibly.
    if (companies.length > 1 && (ambiguous || (rows.length === 0 && all.length > 0)))
      throw new DomainError(ambiguous ? "stock_company_ambiguous" : "stock_unattributed");

    const vps = await accountDb(accountId).vendorProduct.findMany({
      where: { connectionId },
      select: { id: true, vendorId: true },
    });
    const byRef = new Map(vps.map((v) => [v.vendorId, v.id]));
    const merged = new Map<string, Prisma.EushipmentsStockCreateManyInput>();
    let latest: Date | null = null;
    for (const r of rows) {
      const refNumber = r.REFERENCE_NUMBER.trim();
      const warehouseName = r.STORE_NAME.trim().slice(0, 200);
      if (!refNumber || !warehouseName) continue;
      const availDate = parseVendorDate(r.AVAIL_DATE);
      if (availDate && (!latest || availDate > latest)) latest = availDate;
      const key = `${refNumber}\u0000${warehouseName}`;
      const qty = Math.max(0, int(r.AVAIL_QTY) ?? 0);
      const prev = merged.get(key);
      merged.set(key, {
        accountId,
        connectionId,
        refNumber,
        warehouseName,
        vendorProductId: byRef.get(refNumber) ?? null,
        availQty: (prev?.availQty ?? 0) + qty,
        courierItemCode: text(r.COURIER_ITEM_CODE, 50),
        availDate,
        syncedAt: now,
      });
    }
    const list = [...merged.values()];
    const totals = new Map<string, number>();
    for (const s of list)
      if (s.vendorProductId) totals.set(s.vendorProductId, (totals.get(s.vendorProductId) ?? 0) + s.availQty);
    const snapshotAt = latest ?? now;

    await withAccountTransaction(
      accountId,
      async (tx, { lockKey }) => {
        await lockKey(`eushipments:stock:${connectionId}`);
        await tx.eushipmentsStock.deleteMany({ where: { connectionId } });
        for (let i = 0; i < list.length; i += 1000)
          await tx.eushipmentsStock.createMany({ data: list.slice(i, i + 1000) });
        for (const vp of vps) {
          const free = totals.get(vp.id) ?? 0;
          const existing = await tx.stockLevel.findUnique({
            where: { vendorProductId: vp.id },
            select: { reserved: true },
          });
          // A product missing from get-prod-avails has 0 at the warehouse: record the 0 (with a fresh snapshot) so
          // the stock board and the Shopify push show it as sold out instead of "no data" (which kept Shopify's old
          // positive number and could oversell).
          const reserved = existing?.reserved ?? 0;
          const data = {
            physical: free,
            free,
            sellable: Math.max(0, Math.min(free, free - reserved)),
            snapshotAt,
            source: "POLL" as const,
          };
          if (existing) await tx.stockLevel.update({ where: { vendorProductId: vp.id }, data });
          else
            await tx.stockLevel.create({ data: { accountId, vendorProductId: vp.id, reserved: 0, ...data } });
        }
      },
      { timeout: 60_000 },
    );
    const unknownRefs = list.filter((s) => !s.vendorProductId).length;
    return {
      rows: list.length,
      products: totals.size,
      unknownRefs,
      unattributed,
      snapshotAt: snapshotAt.toISOString(),
    };
  });
}

// ───────────────────────── orders-history polling ─────────────────────────

/** Shipments that exist at the vendor and are not final yet (DELIVERED / CANCELLED / RETURN_RECEIVED stop). */
export const POLLED_STATUSES: CrmOrderStatus[] = [
  "ACCEPTED",
  "PROCESSING",
  "SHIPPED",
  "RETURNING",
  "EXCEPTION",
  "BLOCKED",
  "UNKNOWN",
];
const MAX_POLL_PER_RUN = 5000;
const NOT_FOUND_ALERT = "eushipments_not_found";
const NOT_FOUND_TEXT = "not found at euShipments";
/** A freshly created shipment may not be in orders-history yet: never call it removed before this. */
const GONE_AFTER_MS = 30 * 60_000;

/**
 * orders-history in batches of 100 for every open shipment of the connection. Per-item errors inside HTTP 200
 * are handled one by one: a shipment we believe exists but the vendor does not know becomes an alert; other
 * errors are recorded on its tracking row. One failing batch does not stop the others.
 */
export async function pollEuOrders(accountId: string, connectionId: string, deps: ReadDeps = {}) {
  return tracked(accountId, connectionId, "orders", async () => {
    const { client } = await euReadClientFor(accountId, connectionId, deps.clientOptions);
    const db = accountDb(accountId);
    const now = deps.now ?? new Date();
    const stopped = new Set(
      (
        await db.eushipmentsTracking.findMany({
          where: { connectionId, stopPolling: true },
          select: { fulfillmentId: true },
        })
      ).map((t) => t.fulfillmentId),
    );
    const open = (
      await db.fulfillment.findMany({
        where: { connectionId, status: { in: POLLED_STATUSES } },
        select: { id: true, externalId: true },
        orderBy: { updatedAt: "asc" },
        take: MAX_POLL_PER_RUN + stopped.size,
      })
    )
      .filter((f) => !stopped.has(f.id))
      .slice(0, MAX_POLL_PER_RUN);

    const track = (
      fulfillmentId: string,
      referenceNumber: string,
      data: Prisma.EushipmentsTrackingUpdateInput,
    ) =>
      db.eushipmentsTracking.upsert({
        where: { fulfillmentId },
        create: { accountId, connectionId, fulfillmentId, referenceNumber, ...(data as object) },
        update: data,
      });

    let updated = 0;
    let notFound = 0;
    let errors = 0;
    let failedBatches = 0;
    let lastError: unknown = null;
    for (let i = 0; i < open.length; i += ORDERS_HISTORY_BATCH) {
      const batch = open.slice(i, i + ORDERS_HISTORY_BATCH);
      let items;
      try {
        items = await client.ordersHistory(batch.map((f) => f.externalId));
      } catch (err) {
        if (err instanceof EuShipmentsError && err.code === "auth_failed") throw err;
        failedBatches++;
        lastError = err;
        logger.warn(
          { connectionId, err: scrubText(String((err as Error).message)) },
          "orders-history batch failed",
        );
        continue;
      }
      for (const f of batch) {
        const lookup = classifyHistoryItem(historyItemFor(items, f.externalId));
        if (lookup.kind === "found") {
          try {
            const r = await applyOrderHistory(accountId, f.id, lookup.item, now);
            await track(f.id, f.externalId, { polledAt: now, stopPolling: r.stopPolling, lastError: null });
            updated++;
          } catch (err) {
            errors++;
            await track(f.id, f.externalId, {
              polledAt: now,
              lastError: scrubText(String((err as Error).message), 300),
            });
          }
        } else if (lookup.kind === "not_found") {
          notFound++;
          // Second "not found" in a row (≥ GONE_AFTER_MS after it was sent) for a shipment the vendor provably had:
          // we recorded its history, or euShipments confirmed the create (vendor order id / request SENT).
          // Then it was removed in the cabinet.
          const prior = await db.eushipmentsTracking.findUnique({
            where: { fulfillmentId: f.id },
            select: { lastError: true },
          });
          const shipment = await db.fulfillment.findUniqueOrThrow({
            where: { id: f.id },
            select: { vendorOrderId: true, submittedAt: true, createdAt: true },
          });
          const sentAt = shipment.submittedAt ?? shipment.createdAt;
          const confirmed =
            !!shipment.vendorOrderId ||
            (await db.fulfillmentEvent.count({ where: { fulfillmentId: f.id, source: EU_EVENT_SOURCE } })) >
              0 ||
            (await db.outboundRequest.count({
              where: { fulfillmentId: f.id, operation: "eushipments.createOrder", status: "SENT" },
            })) > 0;
          const existedBefore =
            prior?.lastError === NOT_FOUND_TEXT &&
            confirmed &&
            now.getTime() - sentAt.getTime() >= GONE_AFTER_MS;
          await track(f.id, f.externalId, { polledAt: now, lastError: NOT_FOUND_TEXT });
          if (existedBefore && (await markGoneAtVendor(accountId, f.id))) continue;
          await openNotFoundAlert(accountId, f.id, f.externalId);
        } else {
          errors++;
          await track(f.id, f.externalId, { polledAt: now, lastError: lookup.error.slice(0, 300) });
        }
      }
    }
    const batches = Math.ceil(open.length / ORDERS_HISTORY_BATCH);
    if (batches > 0 && failedBatches === batches) throw lastError;
    return { shipments: open.length, batches, failedBatches, updated, notFound, errors };
  });
}

async function openNotFoundAlert(accountId: string, fulfillmentId: string, reference: string) {
  await withAccountTransaction(accountId, async (tx, { lockKey }) => {
    await lockKey(`eushipments:alert:${NOT_FOUND_ALERT}:${fulfillmentId}`);
    const open = await tx.alert.findFirst({
      where: {
        kind: NOT_FOUND_ALERT,
        entityType: "Fulfillment",
        entityId: fulfillmentId,
        status: { not: "RESOLVED" },
      },
      select: { id: true },
    });
    if (open) return;
    await tx.alert.create({
      data: {
        accountId,
        kind: NOT_FOUND_ALERT,
        severity: "CRITICAL",
        isTask: true,
        title: "euShipments: shipment not found at the vendor",
        body: `orders-history answers "not found" for ${reference}, which the CRM records as created. Check the euShipments cabinet.`,
        entityType: "Fulfillment",
        entityId: fulfillmentId,
      },
    });
  });
}

// ───────────────────────── booking requests ─────────────────────────

const OPEN_BOOKINGS = ["CREATED", "RECEIVED"];
const DISCREPANCY_ALERT = "eushipments_inbound_discrepancy";

/** booking-request-status lifecycle → our InboundShipment.status. */
export function bookingStage(s: {
  created?: string | null;
  received?: string | null;
  closed?: string | null;
  deleted?: string | null;
}) {
  if (s.deleted) return "DELETED";
  if (s.closed) return "CLOSED";
  if (s.received) return "RECEIVED";
  return "CREATED";
}

/**
 * Booking requests we created (vendorId = requestId) and that are not closed/deleted yet: lifecycle and
 * accepted quantities. Once closed, accepted ≠ booked (or a warehouse comment, or a product we did not book)
 * opens one discrepancy task with the warehouse comments.
 */
export async function pollEuBookings(accountId: string, connectionId: string, deps: ReadDeps = {}) {
  return tracked(accountId, connectionId, "bookings", async () => {
    const { client, companyId } = await needCompany(accountId, connectionId, deps);
    const db = accountDb(accountId);
    const inbounds = await db.inboundShipment.findMany({
      where: { connectionId, vendorId: { not: null }, status: { in: OPEN_BOOKINGS } },
      include: { lines: true },
      take: 500,
    });
    let checked = 0;
    let closed = 0;
    let discrepancies = 0;
    let errors = 0;
    for (const inbound of inbounds) {
      const bookingId = int(inbound.vendorId);
      if (!bookingId || bookingId <= 0) continue;
      let res;
      try {
        res = await client.bookingRequestStatus(companyId, bookingId);
      } catch (err) {
        if (err instanceof EuShipmentsError && err.code === "auth_failed") throw err;
        errors++;
        await db.inboundShipment.update({
          where: { id: inbound.id },
          data: {
            raw: json({
              ...(inbound.raw as object | null),
              lastError: scrubText(String((err as Error).message), 300),
            }),
          },
        });
        continue;
      }
      checked++;
      const stage = bookingStage(res.statuses);
      const refs = res.products.map((p) => p.referenceNumber);
      const vps = await db.vendorProduct.findMany({
        where: { connectionId, vendorId: { in: refs } },
        select: { vendorId: true, productId: true },
      });
      const productOf = new Map(vps.map((v) => [v.vendorId, v.productId]));
      const problems: string[] = [];
      await withAccountTransaction(accountId, async (tx) => {
        await tx.inboundShipment.update({
          where: { id: inbound.id },
          data: { status: stage, raw: json(res) },
        });
        if (stage !== "CLOSED") return;
        const lineOf = new Map(inbound.lines.map((l) => [l.productId, l]));
        const seen = new Set<string>();
        for (const p of res.products) {
          const productId = productOf.get(p.referenceNumber);
          const line = productId ? lineOf.get(productId) : undefined;
          const booked = int(p.booked) ?? 0;
          const accepted = int(p.accepted);
          if (!line) {
            problems.push(
              `${p.referenceNumber}: not in our booking (booked ${booked}, accepted ${accepted ?? "?"})`,
            );
            continue;
          }
          seen.add(line.id);
          await tx.inboundLine.update({
            where: { id: line.id },
            data: { receivedQty: accepted, comment: text(p.comment, 500) },
          });
          if (accepted !== line.expectedQty || booked !== line.expectedQty || p.comment)
            problems.push(
              `${p.referenceNumber}: expected ${line.expectedQty}, booked ${booked}, accepted ${accepted ?? "?"}` +
                (p.comment ? ` — ${scrubText(String(p.comment), 200)}` : ""),
            );
        }
        for (const l of inbound.lines)
          if (!seen.has(l.id))
            problems.push(`product ${l.productId}: expected ${l.expectedQty}, not in the warehouse answer`);
        if (problems.length) {
          const open = await tx.alert.findFirst({
            where: {
              kind: DISCREPANCY_ALERT,
              entityType: "InboundShipment",
              entityId: inbound.id,
              status: { not: "RESOLVED" },
            },
            select: { id: true },
          });
          if (!open)
            await tx.alert.create({
              data: {
                accountId,
                kind: DISCREPANCY_ALERT,
                severity: "WARNING",
                isTask: true,
                title: `euShipments: booking ${inbound.externalRef} accepted with differences`,
                body: problems.join("\n").slice(0, 2000),
                entityType: "InboundShipment",
                entityId: inbound.id,
              },
            });
        }
      });
      if (stage === "CLOSED") closed++;
      if (problems.length) discrepancies++;
    }
    return { open: inbounds.length, checked, closed, discrepancies, errors };
  });
}

// ───────────────────────── COD by reference ─────────────────────────

const COD_RECHECK_MS = 12 * 3600_000;
const COD_LOOKBACK_MS = 180 * 24 * 3600_000;

/**
 * check-cod-by-order for delivered COD shipments whose payout is not known yet (at most every 12 h each).
 * Paid → Fulfillment.codStatus PAID and status COD_PAID; registered but unpaid → REGISTERED.
 * "Nothing found" (HTTP 200, null body) only records the check time.
 */
export async function pollEuCod(accountId: string, connectionId: string, deps: ReadDeps = {}) {
  return tracked(accountId, connectionId, "cod", async () => {
    const { client } = await euReadClientFor(accountId, connectionId, deps.clientOptions);
    const db = accountDb(accountId);
    const now = deps.now ?? new Date();
    const candidates = await db.fulfillment.findMany({
      where: {
        connectionId,
        status: "DELIVERED",
        deliveredAt: { gte: new Date(now.getTime() - COD_LOOKBACK_MS) },
        order: { paymentMethod: "COD" },
      },
      select: { id: true, externalId: true },
      take: 2000,
    });
    const tracking = new Map(
      (
        await db.eushipmentsTracking.findMany({
          where: { fulfillmentId: { in: candidates.map((c) => c.id) } },
          select: { fulfillmentId: true, codPaidAt: true, codCheckedAt: true },
        })
      ).map((t) => [t.fulfillmentId, t]),
    );
    const due = candidates
      .filter((c) => {
        const t = tracking.get(c.id);
        return (
          !t?.codPaidAt && (!t?.codCheckedAt || now.getTime() - t.codCheckedAt.getTime() >= COD_RECHECK_MS)
        );
      })
      .slice(0, 500);
    let paid = 0;
    let registered = 0;
    let missing = 0;
    let errors = 0;
    let lastError: unknown = null;
    for (const f of due) {
      let info;
      try {
        info = await client.checkCodByOrder(f.externalId, false);
      } catch (err) {
        if (err instanceof EuShipmentsError && err.code === "auth_failed") throw err;
        // One bad reference must not stop the run (and then every next run) for all the others.
        errors++;
        lastError = err;
        const failed = { codCheckedAt: now, lastError: scrubText(String((err as Error).message), 300) };
        await db.eushipmentsTracking.upsert({
          where: { fulfillmentId: f.id },
          create: { accountId, connectionId, fulfillmentId: f.id, referenceNumber: f.externalId, ...failed },
          update: failed,
        });
        continue;
      }
      const base = { codCheckedAt: now };
      if (!info) {
        missing++;
        await db.eushipmentsTracking.upsert({
          where: { fulfillmentId: f.id },
          create: { accountId, connectionId, fulfillmentId: f.id, referenceNumber: f.externalId, ...base },
          update: base,
        });
        continue;
      }
      const paidAt = info.payedDate ? parseVendorDate(info.payedDate) : null;
      const isPaid = info.payedNumber != null || !!paidAt;
      const data = {
        ...base,
        codAmount: text(info.COD, 30),
        codAwb: text(info.awbNumber, 50),
        codPaidNumber: text(info.payedNumber, 50),
        codPaidAt: isPaid ? (paidAt ?? now) : null,
      };
      await withAccountTransaction(accountId, async (tx) => {
        await tx.eushipmentsTracking.upsert({
          where: { fulfillmentId: f.id },
          create: { accountId, connectionId, fulfillmentId: f.id, referenceNumber: f.externalId, ...data },
          update: data,
        });
        const updated = await tx.fulfillment.update({
          where: { id: f.id },
          data: { codStatus: isPaid ? "PAID" : "REGISTERED", ...(isPaid ? { status: "COD_PAID" } : {}) },
          select: { orderId: true },
        });
        if (isPaid) await advanceOrderStatus(tx, updated.orderId, "COD_PAID", "eushipments.cod");
        if (isPaid)
          await tx.fulfillmentEvent.create({
            data: {
              accountId,
              fulfillmentId: f.id,
              occurredAt: data.codPaidAt ?? now,
              source: "eushipments_cod",
              rawStatus: "COD paid out",
              status: "COD_PAID",
              payload: json({ amount: data.codAmount, protocol: data.codPaidNumber }),
            },
          });
      });
      if (isPaid) paid++;
      else registered++;
    }
    if (due.length > 0 && errors === due.length) throw lastError;
    return { checked: due.length, paid, registered, missing, errors };
  });
}
