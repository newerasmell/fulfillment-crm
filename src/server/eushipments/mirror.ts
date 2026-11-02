import type { Prisma } from "@/generated/prisma/client";
import { EU_OPS } from "@/integrations/eushipments/adapter";
import type { Role } from "@/generated/prisma/client";
import { assertCan, can } from "@/server/auth/rbac";
import { accountDb } from "@/server/db/client";

/**
 * Read models for the euShipments mirror screens (SPEC §6.7, DESIGN.md screen 5). Local mirror only — no vendor
 * call. Callers check access to the connection first (getEuConnection); every query here is account-scoped.
 */

export const PAGE_SIZE = 50;
const page = (p: number | undefined) => Math.max(0, Math.floor((p ?? 1) - 1)) * PAGE_SIZE;

export const MIRROR_TABS = [
  "products",
  "stock",
  "orders",
  "inbound",
  "cod",
  "couriers",
  "warehouses",
  "dryrun",
] as const;
export type MirrorTab = (typeof MIRROR_TABS)[number];

export type ProductFilter = "all" | "unmatched" | "archived";

export async function mirrorProducts(
  accountId: string,
  connectionId: string,
  opts: { q?: string; filter?: ProductFilter; page?: number } = {},
) {
  const db = accountDb(accountId);
  const filter = opts.filter ?? "all";
  const q = opts.q?.trim();
  const where: Prisma.VendorProductWhereInput = {
    connectionId,
    ...(filter === "archived" ? { archived: true } : { archived: false }),
    ...(filter === "unmatched" ? { productId: null } : {}),
    ...(q
      ? {
          OR: [
            { vendorId: { contains: q, mode: "insensitive" } },
            { vendorCode: { contains: q, mode: "insensitive" } },
            { product: { sku: { contains: q, mode: "insensitive" } } },
            { product: { name: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const [rows, total, counts] = await Promise.all([
    db.vendorProduct.findMany({
      where,
      include: { product: { select: { id: true, sku: true, name: true } }, stockLevel: true },
      orderBy: { vendorId: "asc" },
      skip: page(opts.page),
      take: PAGE_SIZE,
    }),
    db.vendorProduct.count({ where }),
    Promise.all([
      db.vendorProduct.count({ where: { connectionId, archived: false } }),
      db.vendorProduct.count({ where: { connectionId, archived: false, productId: null } }),
      db.vendorProduct.count({ where: { connectionId, archived: true } }),
    ]),
  ]);
  return {
    rows: rows.map((r) => ({
      ...r,
      vendorName: (r.raw as { name?: string | null } | null)?.name ?? null,
    })),
    total,
    counts: { all: counts[0], unmatched: counts[1], archived: counts[2] },
  };
}

export async function mirrorStock(
  accountId: string,
  connectionId: string,
  opts: { q?: string; page?: number } = {},
) {
  const db = accountDb(accountId);
  const q = opts.q?.trim();
  const where: Prisma.EushipmentsStockWhereInput = {
    connectionId,
    ...(q ? { refNumber: { contains: q, mode: "insensitive" } } : {}),
  };
  const [rows, total, snapshot] = await Promise.all([
    db.eushipmentsStock.findMany({
      where,
      orderBy: [{ refNumber: "asc" }, { warehouseName: "asc" }],
      skip: page(opts.page),
      take: PAGE_SIZE,
    }),
    db.eushipmentsStock.count({ where }),
    db.eushipmentsStock.aggregate({ where: { connectionId }, _max: { availDate: true, syncedAt: true } }),
  ]);
  const vpIds = rows.map((r) => r.vendorProductId).filter((v): v is string => !!v);
  const links = await db.vendorProduct.findMany({
    where: { id: { in: vpIds } },
    select: { id: true, product: { select: { sku: true, name: true } } },
  });
  const productOf = new Map(links.map((l) => [l.id, l.product]));
  return {
    rows: rows.map((r) => ({
      ...r,
      product: r.vendorProductId ? (productOf.get(r.vendorProductId) ?? null) : null,
    })),
    total,
    snapshotAt: snapshot._max.availDate,
    syncedAt: snapshot._max.syncedAt,
  };
}

export async function mirrorShipments(
  accountId: string,
  connectionId: string,
  opts: { q?: string; page?: number } = {},
) {
  const db = accountDb(accountId);
  const q = opts.q?.trim();
  const where: Prisma.FulfillmentWhereInput = {
    connectionId,
    ...(q
      ? {
          OR: [{ externalId: { contains: q, mode: "insensitive" } }, { trackingNumbers: { has: q } }],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    db.fulfillment.findMany({
      where,
      include: { order: { select: { id: true, number: true, customerName: true, countryCode: true } } },
      orderBy: { createdAt: "desc" },
      skip: page(opts.page),
      take: PAGE_SIZE,
    }),
    db.fulfillment.count({ where }),
  ]);
  const tracking = await db.eushipmentsTracking.findMany({
    where: { fulfillmentId: { in: rows.map((r) => r.id) } },
  });
  const tOf = new Map(tracking.map((t) => [t.fulfillmentId, t]));
  return { rows: rows.map((r) => ({ ...r, tracking: tOf.get(r.id) ?? null })), total };
}

export async function mirrorBookings(accountId: string, connectionId: string, opts: { page?: number } = {}) {
  const db = accountDb(accountId);
  const where = { connectionId };
  const [rows, total] = await Promise.all([
    db.inboundShipment.findMany({
      where,
      include: { lines: { include: { product: { select: { sku: true, name: true } } } } },
      orderBy: { createdAt: "desc" },
      skip: page(opts.page),
      take: PAGE_SIZE,
    }),
    db.inboundShipment.count({ where }),
  ]);
  return { rows, total };
}

export async function mirrorCod(accountId: string, connectionId: string, opts: { page?: number } = {}) {
  const db = accountDb(accountId);
  const where: Prisma.EushipmentsTrackingWhereInput = { connectionId, codCheckedAt: { not: null } };
  const [rows, total, paid, open] = await Promise.all([
    db.eushipmentsTracking.findMany({
      where,
      orderBy: [{ codPaidAt: { sort: "desc", nulls: "first" } }, { codCheckedAt: "desc" }],
      skip: page(opts.page),
      take: PAGE_SIZE,
    }),
    db.eushipmentsTracking.count({ where }),
    db.eushipmentsTracking.count({ where: { connectionId, codPaidAt: { not: null } } }),
    db.eushipmentsTracking.count({ where: { connectionId, codAmount: { not: null }, codPaidAt: null } }),
  ]);
  return { rows, total, paid, open };
}

export async function mirrorCouriers(accountId: string, connectionId: string, opts: { q?: string } = {}) {
  const db = accountDb(accountId);
  const q = opts.q?.trim();
  const [couriers, officeCounts, offices, countries, cityCounts] = await Promise.all([
    db.eushipmentsCourier.findMany({ where: { connectionId }, orderBy: { name: "asc" } }),
    db.eushipmentsOffice.groupBy({ by: ["courierId"], where: { connectionId }, _count: { _all: true } }),
    q
      ? db.eushipmentsOffice.findMany({
          where: {
            connectionId,
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { cityName: { contains: q, mode: "insensitive" } },
              { code: { contains: q, mode: "insensitive" } },
              { postCode: { startsWith: q } },
            ],
          },
          orderBy: [{ cityName: "asc" }, { name: "asc" }],
          take: PAGE_SIZE,
        })
      : Promise.resolve([]),
    db.eushipmentsCountry.findMany({ where: { connectionId }, orderBy: { name: "asc" } }),
    db.eushipmentsCity.groupBy({ by: ["countryId"], where: { connectionId }, _count: { _all: true } }),
  ]);
  const officesOf = new Map(officeCounts.map((o) => [o.courierId, o._count._all]));
  const citiesOf = new Map(cityCounts.map((c) => [c.countryId, c._count._all]));
  return {
    couriers: couriers.map((c) => ({ ...c, offices: officesOf.get(c.courierId) ?? 0 })),
    offices,
    countries: countries.map((c) => ({ ...c, cities: citiesOf.get(c.countryId) ?? 0 })),
  };
}

export async function mirrorWarehouses(accountId: string, connectionId: string) {
  return accountDb(accountId).eushipmentsWarehouse.findMany({
    where: { connectionId },
    orderBy: { name: "asc" },
  });
}

/** Operations euShipments can validate without persisting (`testMode: true`) — the rest is only recorded. */
export const TEST_MODE_OPERATIONS: readonly string[] = [EU_OPS.createOrder, EU_OPS.createTransfer];

/**
 * DRY_RUN preview: every request evaluated in DRY_RUN — the exact body that would be sent, whether it went to
 * euShipments with `testMode: true` (create-order, create-transfer) or was only recorded, and the vendor's
 * validation answer. The bodies carry customer data (recipient name, phone, e-mail, address), so only members
 * who may review orders see them (orders.review); only `payload.body` is returned — never our ctx (which may
 * hold the invoice PDF).
 */
export const canSeeDryRuns = (role: Role) => can(role, "orders.review");

export async function mirrorDryRuns(
  accountId: string,
  connectionId: string,
  role: Role,
  opts: { page?: number } = {},
) {
  assertCan(role, "orders.review");
  const db = accountDb(accountId);
  const where: Prisma.OutboundRequestWhereInput = { connectionId, evaluatedMode: "DRY_RUN" };
  const [rows, total] = await Promise.all([
    db.outboundRequest.findMany({
      where,
      select: {
        id: true,
        operation: true,
        idempotencyKey: true,
        status: true,
        payload: true,
        lastResponse: true,
        lastError: true,
        attempts: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
      skip: page(opts.page),
      take: PAGE_SIZE,
    }),
    db.outboundRequest.count({ where }),
  ]);
  return {
    rows: rows.map((r) => {
      const testMode = TEST_MODE_OPERATIONS.includes(r.operation);
      const verdict =
        r.status === "FAILED"
          ? "rejected"
          : r.status === "DRY_RUN_RECORDED"
            ? testMode && r.lastResponse != null
              ? "validated"
              : "recorded"
            : "pending";
      const { payload, ...rest } = r;
      return { ...rest, body: (payload as { body?: unknown } | null)?.body ?? null, testMode, verdict };
    }),
    total,
  };
}
