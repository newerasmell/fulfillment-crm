import { z } from "zod";
import type { LiveMode, Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan, can } from "@/server/auth/rbac";
import { companyFilter, type CompanyScope } from "@/server/companies";
import { accountDb } from "@/server/db/client";
import { setConnectionMode } from "@/server/outbox/outbox";
import { assertConnectionInScope, type ScopedActor } from "./connection";
import { linkVendorProductToSku } from "./sync";

/**
 * FHB mirror screens (P2-08, SPEC §6.7): read from the local mirror only — never from FHB. Actions that change
 * something at FHB go through the existing services → outbox; the actions here only change CRM settings, queue
 * read syncs, or link mirror rows to master products.
 */

export const MIRROR_PAGE_SIZE = 50;

/** The FHB connection a person may open (restricted members: only their companies' connections). */
export async function getFhbConnection(actor: ScopedActor, connectionId: string) {
  const c = await accountDb(actor.accountId).fulfillmentConnection.findUnique({
    where: { id: connectionId },
    select: {
      id: true,
      name: true,
      type: true,
      liveMode: true,
      enabled: true,
      companyId: true,
      credentialId: true,
      skuPrefixRule: true,
      canaryDailyCap: true,
      company: { select: { name: true } },
      credential: { select: { hint: true, updatedAt: true } },
      fhbSyncStates: { orderBy: { resource: "asc" } },
    },
  });
  if (!c || c.type !== "FHB_V3") throw new DomainError("not_found");
  assertConnectionInScope(actor, c.companyId);
  return c;
}

/** FHB connection cards for Складове и връзки (company filter of the sidebar applies). */
export async function listFhbConnections(ctx: {
  accountId: string;
  companyScope: CompanyScope;
  activeCompanyId: string | null;
}) {
  const db = accountDb(ctx.accountId);
  const connections = await db.fulfillmentConnection.findMany({
    where: { type: "FHB_V3", ...companyFilter(ctx) },
    select: {
      id: true,
      name: true,
      liveMode: true,
      enabled: true,
      credentialId: true,
      company: { select: { name: true } },
      fhbSyncStates: { select: { resource: true, lastOkAt: true, lastError: true } },
      _count: { select: { vendorProducts: true, fhbOrders: true } },
    },
    orderBy: { name: "asc" },
  });
  return connections;
}

const SettingsInput = z.object({
  name: z.string().trim().min(2).max(100),
  skuPrefix: z
    .string()
    .trim()
    .max(20)
    .regex(/^[^#&%\s]*$/),
  enabled: z.boolean(),
});

export async function updateFhbConnectionSettings(
  actor: ScopedActor,
  connectionId: string,
  raw: z.input<typeof SettingsInput>,
) {
  assertCan(actor.role, "connections.manage");
  const input = SettingsInput.parse(raw);
  const before = await getFhbConnection(actor, connectionId);
  await accountDb(actor.accountId).fulfillmentConnection.update({
    where: { id: connectionId },
    data: {
      name: input.name,
      skuPrefixRule: input.skuPrefix ? { prefix: input.skuPrefix } : {},
      enabled: input.enabled,
    },
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "fhb.connection.settings",
    entityType: "FulfillmentConnection",
    entityId: connectionId,
    before: { name: before.name, skuPrefixRule: before.skuPrefixRule, enabled: before.enabled } as never,
    after: { name: input.name, skuPrefix: input.skuPrefix || null, enabled: input.enabled },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}

/** Mode change through the outbox rules (raise = OWNER only, audited); restricted members never reach it. */
export async function setFhbConnectionMode(actor: ScopedActor, connectionId: string, mode: LiveMode) {
  await getFhbConnection(actor, connectionId);
  return setConnectionMode(actor, connectionId, mode);
}

/** Operator links an FHB product the SKU rule could not match to a master product (never by EAN). */
export async function linkFhbVendorProduct(actor: ScopedActor, vendorProductId: string, sku: string) {
  assertCan(actor.role, "products.match");
  const vp = await accountDb(actor.accountId).vendorProduct.findUnique({
    where: { id: vendorProductId },
    select: { id: true, productId: true, connection: { select: { companyId: true, type: true } } },
  });
  if (!vp || vp.connection.type !== "FHB_V3") throw new DomainError("not_found");
  assertConnectionInScope(actor, vp.connection.companyId);
  const result = await linkVendorProductToSku(
    actor.accountId,
    vendorProductId,
    z.string().trim().min(1).max(100).parse(sku),
  );
  if (result === "not_found") throw new DomainError("not_found");
  if (result === "no_product") throw new DomainError("no_product");
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "fhb.vendorProduct.link",
    entityType: "VendorProduct",
    entityId: vendorProductId,
    before: { productId: vp.productId },
    after: { sku },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}

// ───────────── tab queries (local mirror only) ─────────────

const skip = (page: number) => (Math.max(1, page) - 1) * MIRROR_PAGE_SIZE;
const contains = (q: string) => ({ contains: q, mode: "insensitive" as const });

export type StockFilter = "all" | "inStock" | "zero" | "testers" | "unmatched" | "bundles" | "archived";
export const STOCK_FILTERS: StockFilter[] = [
  "all",
  "inStock",
  "zero",
  "testers",
  "unmatched",
  "bundles",
  "archived",
];

function stockWhere(filter: StockFilter): Prisma.VendorProductWhereInput {
  switch (filter) {
    case "inStock":
      return { archived: false, stockLevel: { is: { free: { gt: 0 } } } };
    case "zero":
      return { archived: false, OR: [{ stockLevel: { is: { physical: 0 } } }, { stockLevel: { is: null } }] };
    case "testers":
      return { archived: false, product: { is: { isTester: true } } };
    case "unmatched":
      return { archived: false, productId: null };
    case "bundles":
      return { archived: false, raw: { path: ["type"], equals: "multi" } };
    case "archived":
      return { archived: true };
    default:
      return { archived: false };
  }
}

function searchWhere(q: string): Prisma.VendorProductWhereInput {
  if (!q) return {};
  return {
    OR: [
      { vendorId: contains(q) },
      { vendorCode: contains(q) },
      { vendorEan: contains(q) },
      { product: { is: { sku: contains(q) } } },
      { product: { is: { name: contains(q) } } },
      { product: { is: { eans: { some: { ean: contains(q) } } } } },
      { raw: { path: ["name"], string_contains: q } },
    ],
  };
}

/** Products and stock of FHB connections (screen 4). `connectionIds` already limited to what the actor sees. */
export async function fhbStockBoard(
  accountId: string,
  connectionIds: string[],
  opts: { q?: string; filter?: StockFilter; page?: number },
) {
  const db = accountDb(accountId);
  const q = opts.q?.trim() ?? "";
  const base: Prisma.VendorProductWhereInput = { connectionId: { in: connectionIds }, ...searchWhere(q) };
  const filter = opts.filter ?? "all";
  const [rows, total, counts] = await Promise.all([
    db.vendorProduct.findMany({
      where: { ...base, ...stockWhere(filter) },
      include: {
        stockLevel: true,
        connection: { select: { id: true, name: true } },
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
            isTester: true,
            parentProductId: true,
            eans: { select: { ean: true }, orderBy: { createdAt: "asc" } },
          },
        },
      },
      // Stable order by FHB id ("testers under the original" grouping is a listed gap, see PROGRESS).
      orderBy: [{ vendorId: "asc" }],
      skip: skip(opts.page ?? 1),
      take: MIRROR_PAGE_SIZE,
    }),
    db.vendorProduct.count({ where: { ...base, ...stockWhere(filter) } }),
    Promise.all(
      STOCK_FILTERS.map(
        async (f) => [f, await db.vendorProduct.count({ where: { ...base, ...stockWhere(f) } })] as const,
      ),
    ),
  ]);
  return { rows, total, counts: Object.fromEntries(counts) as Record<StockFilter, number> };
}

export async function fhbVendorProductDetail(
  accountId: string,
  connectionIds: string[],
  vendorProductId: string,
) {
  const db = accountDb(accountId);
  const vp = await db.vendorProduct.findFirst({
    where: { id: vendorProductId, connectionId: { in: connectionIds } },
    include: {
      stockLevel: true,
      connection: { select: { name: true } },
      product: { select: { sku: true, name: true, eans: { orderBy: { createdAt: "asc" } } } },
      movements: { orderBy: { occurredAt: "desc" }, take: 10 },
    },
  });
  return vp;
}

export async function fhbMovements(
  accountId: string,
  connectionIds: string[],
  opts: { q?: string; page?: number },
) {
  const db = accountDb(accountId);
  const q = opts.q?.trim() ?? "";
  const where: Prisma.StockMovementWhereInput = {
    connectionId: { in: connectionIds },
    ...(q ? { OR: [{ vendorProduct: { is: { vendorId: contains(q) } } }, { externalId: q }] } : {}),
  };
  const [rows, total] = await Promise.all([
    db.stockMovement.findMany({
      where,
      include: {
        vendorProduct: { select: { vendorId: true, product: { select: { sku: true, name: true } } } },
      },
      orderBy: { occurredAt: "desc" },
      skip: skip(opts.page ?? 1),
      take: MIRROR_PAGE_SIZE,
    }),
    db.stockMovement.count({ where }),
  ]);
  return { rows, total };
}

export async function fhbOrders(
  accountId: string,
  connectionId: string,
  opts: { q?: string; rawStatus?: string; rma?: boolean; page?: number },
) {
  const db = accountDb(accountId);
  const q = opts.q?.trim() ?? "";
  const where: Prisma.FhbOrderMirrorWhereInput = {
    connectionId,
    ...(opts.rma ? { inRma: true } : {}),
    ...(opts.rawStatus ? { rawStatus: opts.rawStatus } : {}),
    ...(q
      ? {
          OR: [
            { externalId: contains(q) },
            { uid: contains(q) },
            { variableSymbol: q },
            { trackingNumbers: { has: q } },
            { recipientName: contains(q) },
          ],
        }
      : {}),
  };
  const [rows, total, statuses] = await Promise.all([
    db.fhbOrderMirror.findMany({
      where,
      orderBy: opts.rma ? [{ returnedAt: "desc" }] : [{ vendorCreatedAt: "desc" }],
      skip: skip(opts.page ?? 1),
      take: MIRROR_PAGE_SIZE,
      omit: { raw: true },
    }),
    db.fhbOrderMirror.count({ where }),
    db.fhbOrderMirror.groupBy({
      by: ["rawStatus"],
      where: { connectionId, ...(opts.rma ? { inRma: true } : {}) },
      _count: { _all: true },
      orderBy: { rawStatus: "asc" },
    }),
  ]);
  return {
    rows,
    total,
    statuses: statuses.map((s) => ({ raw: s.rawStatus, count: s._count._all })),
  };
}

export async function fhbOrderDetail(accountId: string, connectionId: string, externalId: string) {
  return accountDb(accountId).fhbOrderMirror.findUnique({
    where: { connectionId_externalId: { connectionId, externalId } },
  });
}

export async function fhbReturns(
  accountId: string,
  connectionId: string,
  opts: { q?: string; page?: number },
) {
  const db = accountDb(accountId);
  const q = opts.q?.trim() ?? "";
  const where: Prisma.FhbReturnMirrorWhereInput = {
    connectionId,
    ...(q ? { OR: [{ uid: contains(q) }, { barcodes: { has: q } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    db.fhbReturnMirror.findMany({
      where,
      orderBy: { vendorCreatedAt: "desc" },
      skip: skip(opts.page ?? 1),
      take: MIRROR_PAGE_SIZE,
      omit: { raw: true },
    }),
    db.fhbReturnMirror.count({ where }),
  ]);
  return { rows, total };
}

export async function fhbCod(
  accountId: string,
  connectionId: string,
  opts: { status?: string; q?: string; page?: number },
) {
  const db = accountDb(accountId);
  const q = opts.q?.trim() ?? "";
  const where: Prisma.FhbCodMirrorWhereInput = {
    connectionId,
    ...(opts.status ? { status: opts.status } : {}),
    ...(q ? { OR: [{ externalId: contains(q) }, { variableSymbol: q }, { uid: contains(q) }] } : {}),
  };
  const [rows, total, totals] = await Promise.all([
    db.fhbCodMirror.findMany({
      where,
      orderBy: { vendorCreatedAt: "desc" },
      skip: skip(opts.page ?? 1),
      take: MIRROR_PAGE_SIZE,
      omit: { raw: true },
    }),
    db.fhbCodMirror.count({ where }),
    db.fhbCodMirror.groupBy({
      by: ["status"],
      where: { connectionId },
      _count: { _all: true },
      _sum: { cod: true },
      orderBy: { status: "asc" },
    }),
  ]);
  return {
    rows,
    total,
    totals: totals.map((t) => ({ status: t.status, count: t._count._all, sum: Number(t._sum.cod ?? 0) })),
  };
}

export async function fhbCarriers(
  accountId: string,
  connectionId: string,
  opts: { service?: string; country?: string; q?: string; page?: number },
) {
  const db = accountDb(accountId);
  const [carriers, lists] = await Promise.all([
    db.fhbCarrier.findMany({ where: { connectionId }, orderBy: { code: "asc" } }),
    db.fhbPickupPoint.groupBy({
      by: ["service", "queryCountry"],
      where: { connectionId },
      _count: { _all: true },
      _max: { lastSyncAt: true },
      orderBy: [{ service: "asc" }, { queryCountry: "asc" }],
    }),
  ]);
  let points: Awaited<ReturnType<typeof db.fhbPickupPoint.findMany>> = [];
  let pointsTotal = 0;
  if (opts.service) {
    const q = opts.q?.trim() ?? "";
    const where: Prisma.FhbPickupPointWhereInput = {
      connectionId,
      service: opts.service,
      queryCountry: (opts.country ?? "").toUpperCase(),
      ...(q
        ? { OR: [{ name: contains(q) }, { city: contains(q) }, { zip: contains(q) }, { externalCode: q }] }
        : {}),
    };
    [points, pointsTotal] = await Promise.all([
      db.fhbPickupPoint.findMany({
        where,
        orderBy: [{ city: "asc" }, { name: "asc" }],
        skip: skip(opts.page ?? 1),
        take: MIRROR_PAGE_SIZE,
      }),
      db.fhbPickupPoint.count({ where }),
    ]);
  }
  return {
    carriers,
    lists: lists.map((l) => ({
      service: l.service,
      country: l.queryCountry,
      count: l._count._all,
      at: l._max.lastSyncAt,
    })),
    points,
    pointsTotal,
  };
}

export async function fhbInbound(accountId: string, connectionId: string, opts: { page?: number }) {
  const db = accountDb(accountId);
  const where = { connectionId };
  const [rows, total] = await Promise.all([
    db.inboundShipment.findMany({
      where,
      include: { lines: { include: { product: { select: { sku: true, name: true } } } } },
      orderBy: { createdAt: "desc" },
      skip: skip(opts.page ?? 1),
      take: MIRROR_PAGE_SIZE,
    }),
    db.inboundShipment.count({ where }),
  ]);
  return { rows, total };
}

/**
 * Outbox rows of one connection — in DRY_RUN this is the payload preview: exactly what would have been sent.
 * Payloads carry customer addresses, so only roles with `outbox.payloads` get them.
 */
export async function fhbOutbox(
  accountId: string,
  connectionId: string,
  role: Parameters<typeof can>[0],
  opts: { status?: string; page?: number },
) {
  const db = accountDb(accountId);
  const where: Prisma.OutboundRequestWhereInput = {
    connectionId,
    ...(opts.status ? { status: opts.status as never } : {}),
  };
  const withPayload = can(role, "outbox.payloads");
  const [rows, total, statuses] = await Promise.all([
    db.outboundRequest.findMany({
      where,
      select: {
        id: true,
        operation: true,
        idempotencyKey: true,
        status: true,
        evaluatedMode: true,
        attempts: true,
        lastError: true,
        createdAt: true,
        sentAt: true,
        payload: withPayload,
      },
      orderBy: { createdAt: "desc" },
      skip: skip(opts.page ?? 1),
      take: MIRROR_PAGE_SIZE,
    }),
    db.outboundRequest.count({ where }),
    db.outboundRequest.groupBy({
      by: ["status"],
      where: { connectionId },
      _count: { _all: true },
      orderBy: { status: "asc" },
    }),
  ]);
  return {
    rows: rows.map((r) => ({
      ...r,
      // Only the vendor body is shown: `meta` is CRM-internal and never sent.
      body: withPayload ? ((r.payload as { body?: unknown } | null)?.body ?? null) : undefined,
      target: withPayload ? ((r.payload as { id?: string } | null)?.id ?? null) : undefined,
    })),
    total,
    withPayload,
    statuses: statuses.map((s) => ({ status: s.status, count: s._count._all })),
  };
}
