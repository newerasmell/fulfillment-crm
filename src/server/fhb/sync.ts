import type { Prisma } from "@/generated/prisma/client";
import { FhbError, type FhbClient, type FhbClientOptions } from "@/integrations/fhb-v3/client";
import { mapFhbProductView } from "@/integrations/fhb-v3/mapper";
import {
  crmSkuFromFhbId,
  isoDate,
  mapFhbCod,
  mapFhbMovement,
  mapFhbOrderMirror,
  mapFhbReturn,
} from "@/integrations/fhb-v3/read-mapper";
import type { FhbOrderView, FhbProductView } from "@/integrations/fhb-v3/schemas";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { applyFhbOrderView, raiseAlertOnce } from "./apply";
import { fhbClientForConnection } from "./connection";

/**
 * FHB read side (P2-02): GET/list calls only, so they run in every liveMode including READ_ONLY (the mode gates
 * writes; reads change nothing at FHB). Every run writes the local mirror that the screens read:
 *  - products (paged 250) → VendorProduct + StockLevel (physical + free), auto-matched to the master Product by
 *    SKU after stripping the connection prefix — never by EAN;
 *  - stock/all → physical quantity; stock/movements (500/page) → StockMovement;
 *  - order/history (100/page) → FhbOrderMirror (+ the CRM shipment when we know the order);
 *  - rma/list → FhbOrderMirror with inRma; return/list → FhbReturnMirror; cod/list → FhbCodMirror
 *    (+ Fulfillment.codStatus); parcel-service → FhbCarrier; delivery-point → FhbPickupPoint.
 * Windows overlap the previous run so items that moved between pages during a run are caught next time.
 * Re-running any sync is harmless (upserts keyed by vendor ids).
 */

export const FHB_SYNC_RESOURCES = [
  "products",
  "stock",
  "movements",
  "orders",
  "rma",
  "returns",
  "cod",
  "carriers",
  "pickupPoints",
] as const;
export type FhbSyncResource = (typeof FHB_SYNC_RESOURCES)[number];
/** What the 30-minute reconcile runs (pick-up points are loaded per service/country on request). */
export const FHB_PERIODIC_RESOURCES: FhbSyncResource[] = [
  "products",
  "stock",
  "movements",
  "orders",
  "rma",
  "returns",
  "cod",
  "carriers",
];

export const PAGE_SIZE = { products: 250, orders: 100, rma: 100, returns: 100, cod: 100, movements: 500 };
const MAX_PAGES = 2000;
const DAY = 86_400_000;
export const WINDOWS = {
  /** order/history: created in the last N days (status changes of older orders come via callbacks/order read). */
  ordersDays: 30,
  ordersFirstDays: 90,
  /** rma/list and return/list: overlap of the previous good run; first run looks this far back. */
  overlapDays: 3,
  returnsFirstDays: 90,
  /** cod/list: payouts happen weeks after creation, so a wide window every run. */
  codDays: 120,
  movementsFirstDays: 30,
  movementsOverlapMs: 60 * 60_000,
  /** Carriers and loaded pick-up point lists are refreshed at most this often by the reconcile. */
  carriersMaxAgeMs: DAY,
};

const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

/** Walks a paged list until FHB says there is nothing more (short page, empty page or `total` reached). */
async function eachPage<T>(
  fetchPage: (page: number) => Promise<{ total: number; items: T[] }>,
  pageSize: number,
  onPage: (items: T[]) => Promise<void>,
) {
  let seen = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { total, items } = await fetchPage(page);
    if (items.length === 0) break;
    await onPage(items);
    seen += items.length;
    if (items.length < pageSize || seen >= total) break;
  }
  return seen;
}

export interface SyncContext {
  accountId: string;
  connectionId: string;
  client: FhbClient;
  now: Date;
}

// ───────────── products and stock ─────────────

/** Upserts one page of products in one transaction and links unlinked ones to the master by SKU. */
async function upsertProducts(ctx: SyncContext, views: FhbProductView[], skuPrefixRule: unknown) {
  const { accountId, connectionId, now } = ctx;
  await withAccountTransaction(accountId, async (tx) => {
    const skus = [
      ...new Set(views.map((v) => crmSkuFromFhbId(v.id, skuPrefixRule)).filter((s): s is string => !!s)),
    ];
    const masters = await tx.product.findMany({
      where: { accountId, sku: { in: skus }, archived: false },
      select: { id: true, sku: true },
    });
    const productBySku = new Map(masters.map((p) => [p.sku, p.id]));
    for (const view of views) {
      const p = mapFhbProductView(view);
      const sku = crmSkuFromFhbId(p.vendorId, skuPrefixRule);
      const match = sku ? (productBySku.get(sku) ?? null) : null;
      const existing = await tx.vendorProduct.findUnique({
        where: { connectionId_vendorId: { connectionId, vendorId: p.vendorId } },
        select: { id: true, productId: true },
      });
      const data = {
        vendorCode: p.vendorCode,
        // Read-only mirror of FHB's EAN; never sent back, never a key.
        vendorEan: p.vendorEan,
        archived: p.archived,
        lastSyncAt: now,
        raw: json(view),
      };
      const vp = existing
        ? await tx.vendorProduct.update({
            where: { id: existing.id },
            data: { ...data, ...(!existing.productId && match ? { productId: match } : {}) },
            select: { id: true },
          })
        : await tx.vendorProduct.create({
            data: { accountId, connectionId, vendorId: p.vendorId, productId: match, ...data },
            select: { id: true },
          });
      if (p.physical === null && p.free === null) continue;
      const level = await tx.stockLevel.findUnique({ where: { vendorProductId: vp.id } });
      const physical = p.physical ?? level?.physical ?? 0;
      const free = p.free ?? level?.free ?? 0;
      const reserved = level?.reserved ?? 0;
      const sellable = Math.max(0, Math.min(free, physical - reserved));
      await tx.stockLevel.upsert({
        where: { vendorProductId: vp.id },
        create: {
          accountId,
          vendorProductId: vp.id,
          physical,
          free,
          reserved,
          sellable,
          snapshotAt: now,
          source: "POLL",
        },
        update: { physical, free, sellable, snapshotAt: now, source: "POLL" },
      });
    }
  });
}

export async function syncFhbProducts(ctx: SyncContext) {
  const connection = await accountDb(ctx.accountId).fulfillmentConnection.findUniqueOrThrow({
    where: { id: ctx.connectionId },
    select: { skuPrefixRule: true },
  });
  const count = await eachPage(
    async (page) => {
      const r = await ctx.client.listProducts(page);
      return { total: r.total, items: r.products };
    },
    PAGE_SIZE.products,
    (items) => upsertProducts(ctx, items, connection.skuPrefixRule),
  );
  return { count };
}

/** GET /stock/all: physical quantity only (`free` stays what the product list said). */
export async function syncFhbStock(ctx: SyncContext) {
  const { accountId, connectionId, now } = ctx;
  const levels = await ctx.client.stockAll();
  let count = 0;
  for (let i = 0; i < levels.length; i += 250) {
    const chunk = levels.slice(i, i + 250);
    count += await withAccountTransaction(accountId, async (tx) => {
      const vps = await tx.vendorProduct.findMany({
        where: { accountId, connectionId, vendorId: { in: chunk.map((l) => l.id) } },
        select: { id: true, vendorId: true, stockLevel: true },
      });
      const byId = new Map(vps.map((v) => [v.vendorId, v]));
      let n = 0;
      for (const l of chunk) {
        const vp = byId.get(l.id);
        // Products not mirrored yet arrive with the next product sync (it carries free stock too).
        if (!vp || typeof l.quantity !== "number") continue;
        const physical = Math.trunc(l.quantity);
        const free = vp.stockLevel?.free ?? 0;
        const reserved = vp.stockLevel?.reserved ?? 0;
        const sellable = Math.max(0, Math.min(free, physical - reserved));
        await tx.stockLevel.upsert({
          where: { vendorProductId: vp.id },
          create: {
            accountId,
            vendorProductId: vp.id,
            physical,
            free,
            reserved,
            sellable,
            snapshotAt: now,
            source: "POLL",
          },
          update: { physical, sellable, snapshotAt: now, source: "POLL" },
        });
        n++;
      }
      return n;
    });
  }
  return { count };
}

export async function syncFhbMovements(ctx: SyncContext, cursor: { lastDate?: string }) {
  const { accountId, connectionId, now } = ctx;
  const last = cursor.lastDate ? Date.parse(cursor.lastDate) : NaN;
  const from = Number.isFinite(last)
    ? new Date(last - WINDOWS.movementsOverlapMs)
    : new Date(now.getTime() - WINDOWS.movementsFirstDays * DAY);
  let maxDate = Number.isFinite(last) ? last : 0;
  const count = await eachPage(
    async (page) => {
      const r = await ctx.client.stockMovements({ from: from.toISOString(), page });
      return { total: r.total, items: r.movements };
    },
    PAGE_SIZE.movements,
    async (items) => {
      const rows = items.map(mapFhbMovement);
      const vps = await accountDb(accountId).vendorProduct.findMany({
        where: {
          connectionId,
          vendorId: { in: [...new Set(rows.map((r) => r.productId).filter((x): x is string => !!x))] },
        },
        select: { id: true, vendorId: true },
      });
      const vpOf = new Map(vps.map((v) => [v.vendorId, v.id]));
      await accountDb(accountId).stockMovement.createMany({
        skipDuplicates: true,
        data: rows.map((r, i) => ({
          accountId,
          connectionId,
          vendorProductId: (r.productId && vpOf.get(r.productId)) || null,
          externalId: r.externalId,
          kind: r.kind,
          quantity: r.quantity,
          occurredAt: r.occurredAt ?? now,
          raw: json(items[i]),
        })),
      });
      for (const r of rows) if (r.occurredAt) maxDate = Math.max(maxDate, r.occurredAt.getTime());
    },
  );
  return { count, cursor: maxDate ? { lastDate: new Date(maxDate).toISOString() } : cursor };
}

// ───────────── orders, RMA ─────────────

async function alertUnknownOrderStatus(accountId: string, connectionId: string, raw: string | null) {
  await raiseAlertOnce(accountId, {
    kind: "fhb_unknown_status",
    severity: "WARNING",
    title: `Unknown FHB order status "${raw ?? ""}" — extend the status map`,
    entityType: "FhbStatus",
    entityId: `${connectionId}:${raw ?? ""}`,
  });
}

/** Mirrors FHB order views and moves the CRM shipments we know (only when something changed). */
export async function upsertFhbOrders(
  ctx: Omit<SyncContext, "client">,
  views: FhbOrderView[],
  opts: { fromRma?: boolean; source: string },
) {
  const { accountId, connectionId, now } = ctx;
  const rows = views.map((v) => mapFhbOrderMirror(v, opts));
  await withAccountTransaction(accountId, async (tx) => {
    for (let i = 0; i < rows.length; i++) {
      const { alert: _alert, inRma, ...r } = rows[i]!;
      const data = { ...r, raw: json(views[i]), lastSyncAt: now };
      await tx.fhbOrderMirror.upsert({
        where: { connectionId_externalId: { connectionId, externalId: r.externalId } },
        create: { accountId, connectionId, ...data, inRma },
        // Once seen in rma/list an order stays flagged; order/history does not know about RMA.
        update: { ...data, ...(inRma ? { inRma: true } : {}) },
      });
    }
  });
  const unknown = new Set(rows.filter((r) => r.alert === "unknown_status").map((r) => r.rawStatus));
  for (const raw of unknown) await alertUnknownOrderStatus(accountId, connectionId, raw);

  // CRM shipments: re-apply only when the warehouse says something new (applyFhbOrderView is idempotent).
  const known = await accountDb(accountId).fulfillment.findMany({
    where: { connectionId, externalId: { in: rows.map((r) => r.externalId) } },
    select: { externalId: true, rawStatus: true, trackingNumbers: true, returnInfo: true },
  });
  const byId = new Map(known.map((f) => [f.externalId, f]));
  let applied = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const f = byId.get(r.externalId);
    if (!f) continue;
    const changed =
      f.rawStatus !== r.rawStatus ||
      f.trackingNumbers.join("|") !== r.trackingNumbers.join("|") ||
      (!!r.returnedAt && !f.returnInfo);
    if (!changed) continue;
    await applyFhbOrderView(accountId, connectionId, views[i]!, opts.source, now);
    applied++;
  }
  return { applied };
}

export async function syncFhbOrders(ctx: SyncContext, hasRunBefore: boolean) {
  const days = hasRunBefore ? WINDOWS.ordersDays : WINDOWS.ordersFirstDays;
  const from = new Date(ctx.now.getTime() - days * DAY).toISOString();
  const count = await eachPage(
    async (page) => {
      const r = await ctx.client.orderHistory({ from, page });
      return { total: r.total, items: r.orders };
    },
    PAGE_SIZE.orders,
    async (items) => {
      await upsertFhbOrders(ctx, items, { source: "sync.orders" });
    },
  );
  return { count };
}

export async function syncFhbRma(ctx: SyncContext, lastOkAt: Date | null) {
  const from = isoDate(
    lastOkAt
      ? new Date(lastOkAt.getTime() - WINDOWS.overlapDays * DAY)
      : new Date(ctx.now.getTime() - WINDOWS.returnsFirstDays * DAY),
  );
  const count = await eachPage(
    async (page) => {
      const r = await ctx.client.rmaList({ from, page });
      return { total: r.total, items: r.items };
    },
    PAGE_SIZE.rma,
    async (items) => {
      await upsertFhbOrders(ctx, items, { fromRma: true, source: "sync.rma" });
    },
  );
  return { count };
}

/** GET /order?id= — refresh one order in the mirror (and its CRM shipment). null when FHB does not know it. */
export async function refreshFhbOrder(ctx: SyncContext, externalId: string) {
  const view = await ctx.client.getOrder(externalId);
  if (!view) return null;
  await upsertFhbOrders(ctx, [view], { source: "sync.order" });
  return view.id;
}

// ───────────── local returns, COD ─────────────

export async function syncFhbReturns(ctx: SyncContext, lastOkAt: Date | null) {
  const { accountId, connectionId, now } = ctx;
  const from = isoDate(
    lastOkAt
      ? new Date(lastOkAt.getTime() - WINDOWS.overlapDays * DAY)
      : new Date(now.getTime() - WINDOWS.returnsFirstDays * DAY),
  );
  const count = await eachPage(
    async (page) => {
      const r = await ctx.client.returnList({ from, page });
      return { total: r.total, items: r.items };
    },
    PAGE_SIZE.returns,
    async (items) => {
      await withAccountTransaction(accountId, async (tx) => {
        for (const item of items) {
          const r = mapFhbReturn(item);
          const data = {
            vendorId: r.vendorId,
            depotId: r.depotId,
            type: r.type,
            status: r.status,
            weight: r.weight,
            barcodes: r.barcodes,
            items: json(r.items),
            photos: json(r.photos),
            vendorCreatedAt: r.vendorCreatedAt,
            raw: json(item),
            lastSyncAt: now,
          };
          await tx.fhbReturnMirror.upsert({
            where: { connectionId_uid: { connectionId, uid: r.uid } },
            create: { accountId, connectionId, uid: r.uid, ...data },
            update: data,
          });
        }
      });
    },
  );
  return { count };
}

export async function syncFhbCod(ctx: SyncContext) {
  const { accountId, connectionId, now } = ctx;
  const from = isoDate(new Date(now.getTime() - WINDOWS.codDays * DAY));
  const unknown = new Set<string>();
  const count = await eachPage(
    async (page) => {
      const r = await ctx.client.codList({ from, page });
      return { total: r.total, items: r.items };
    },
    PAGE_SIZE.cod,
    async (items) => {
      const rows = items.map(mapFhbCod);
      await withAccountTransaction(accountId, async (tx) => {
        for (let i = 0; i < rows.length; i++) {
          const { unknownStatus, ...r } = rows[i]!;
          if (unknownStatus && r.status) unknown.add(r.status);
          const data = { ...r, raw: json(items[i]), lastSyncAt: now };
          await tx.fhbCodMirror.upsert({
            where: { connectionId_externalId: { connectionId, externalId: r.externalId } },
            create: { accountId, connectionId, ...data },
            update: data,
          });
          // The CRM shipment shows the raw COD status (waiting / received / paid) as FHB reports it.
          await tx.fulfillment.updateMany({
            where: { accountId, connectionId, externalId: r.externalId, NOT: { codStatus: r.status } },
            data: { codStatus: r.status },
          });
        }
      });
    },
  );
  for (const raw of unknown) {
    await raiseAlertOnce(accountId, {
      kind: "fhb_unknown_cod_status",
      severity: "WARNING",
      title: `Unknown FHB COD status "${raw}"`,
      entityType: "FhbStatus",
      entityId: `${connectionId}:cod:${raw}`,
    });
  }
  return { count };
}

// ───────────── carriers and pick-up points ─────────────

export async function syncFhbCarriers(ctx: SyncContext) {
  const { accountId, connectionId, now } = ctx;
  const services = await ctx.client.parcelServices();
  await withAccountTransaction(accountId, async (tx) => {
    for (const s of services) {
      await tx.fhbCarrier.upsert({
        where: { connectionId_code: { connectionId, code: s.code } },
        create: { accountId, connectionId, code: s.code, name: s.name ?? null, lastSyncAt: now },
        update: { name: s.name ?? null, lastSyncAt: now },
      });
    }
    // A carrier FHB no longer offers on this account disappears (codes are resolved at runtime, §2.5).
    await tx.fhbCarrier.deleteMany({
      where: { accountId, connectionId, code: { notIn: services.map((s) => s.code) } },
    });
  });
  return { count: services.length };
}

/** GET /delivery-point/{service}?country= — replaces exactly that (service, country) list. 404 = none. */
export async function syncFhbPickupPoints(ctx: SyncContext, service: string, country: string | null) {
  const { accountId, connectionId, now } = ctx;
  const queryCountry = country?.trim().toUpperCase() ?? "";
  const points = await ctx.client.deliveryPoints(service, queryCountry || undefined);
  await withAccountTransaction(
    accountId,
    async (tx) => {
      await tx.fhbPickupPoint.deleteMany({ where: { accountId, connectionId, service, queryCountry } });
      for (let i = 0; i < points.length; i += 1000) {
        await tx.fhbPickupPoint.createMany({
          skipDuplicates: true,
          data: points.slice(i, i + 1000).map((p) => ({
            accountId,
            connectionId,
            service,
            queryCountry,
            vendorId: p.id,
            externalCode: p.external_code ?? null,
            name: p.name ?? null,
            street: p.street ?? null,
            city: p.city ?? null,
            zip: p.zip ?? null,
            country: p.country?.toUpperCase() ?? null,
            lastSyncAt: now,
          })),
        });
      }
    },
    { timeout: 60_000 },
  );
  return { count: points.length };
}

/** The (service, country) lists loaded so far, for the daily refresh. */
async function loadedPickupLists(accountId: string, connectionId: string) {
  const rows = await accountDb(accountId).fhbPickupPoint.groupBy({
    by: ["service", "queryCountry"],
    where: { connectionId },
    _min: { lastSyncAt: true },
  });
  return rows.map((r) => ({ service: r.service, country: r.queryCountry, at: r._min.lastSyncAt }));
}

// ───────────── runner ─────────────

export interface FhbSyncRequest {
  resource: FhbSyncResource;
  service?: string;
  country?: string;
  /** Carriers: refresh even if fresh. */
  force?: boolean;
}

/**
 * Runs one read resource for one connection and records the outcome in FhbSyncState (screens show freshness
 * and the last error). Failures are recorded and re-thrown so the job is retried.
 */
export async function runFhbSync(
  accountId: string,
  connectionId: string,
  req: FhbSyncRequest,
  opts: { clientOptions?: FhbClientOptions; now?: Date } = {},
) {
  const db = accountDb(accountId);
  const connection = await db.fulfillmentConnection.findUnique({
    where: { id: connectionId },
    select: { type: true, enabled: true, credentialId: true },
  });
  if (!connection || connection.type !== "FHB_V3" || !connection.enabled || !connection.credentialId) {
    return { skipped: true as const };
  }
  const now = opts.now ?? new Date();
  const stateKey = { connectionId_resource: { connectionId, resource: req.resource } };
  const state = await db.fhbSyncState.findUnique({ where: stateKey });
  if (
    req.resource === "carriers" &&
    !req.force &&
    state?.lastOkAt &&
    now.getTime() - state.lastOkAt.getTime() < WINDOWS.carriersMaxAgeMs
  ) {
    return { skipped: true as const };
  }
  await db.fhbSyncState.upsert({
    where: stateKey,
    create: { accountId, connectionId, resource: req.resource, lastRunAt: now },
    update: { lastRunAt: now },
  });
  const client = await fhbClientForConnection(accountId, connectionId, opts.clientOptions ?? {});
  const ctx: SyncContext = { accountId, connectionId, client, now };
  try {
    let count = 0;
    let cursor = (state?.cursor ?? {}) as Record<string, unknown>;
    switch (req.resource) {
      case "products":
        ({ count } = await syncFhbProducts(ctx));
        break;
      case "stock":
        ({ count } = await syncFhbStock(ctx));
        break;
      case "movements": {
        const r = await syncFhbMovements(ctx, cursor as { lastDate?: string });
        count = r.count;
        cursor = r.cursor;
        break;
      }
      case "orders":
        ({ count } = await syncFhbOrders(ctx, !!state?.lastOkAt));
        break;
      case "rma":
        ({ count } = await syncFhbRma(ctx, state?.lastOkAt ?? null));
        break;
      case "returns":
        ({ count } = await syncFhbReturns(ctx, state?.lastOkAt ?? null));
        break;
      case "cod":
        ({ count } = await syncFhbCod(ctx));
        break;
      case "carriers": {
        ({ count } = await syncFhbCarriers(ctx));
        // Loaded pick-up point lists are refreshed with the carriers (at most daily).
        for (const l of await loadedPickupLists(accountId, connectionId)) {
          await syncFhbPickupPoints(ctx, l.service, l.country || null);
        }
        break;
      }
      case "pickupPoints": {
        if (!req.service) throw new Error("pickupPoints needs a service");
        ({ count } = await syncFhbPickupPoints(ctx, req.service, req.country ?? null));
        break;
      }
    }
    await db.fhbSyncState.update({
      where: stateKey,
      data: { lastOkAt: now, lastError: null, lastCount: count, cursor: json(cursor) },
    });
    return { skipped: false as const, count };
  } catch (err) {
    const message =
      err instanceof FhbError ? `${err.code}: ${err.message}` : scrubText((err as Error).message ?? "error");
    await db.fhbSyncState.update({ where: stateKey, data: { lastError: scrubText(message) } });
    logger.warn({ connectionId, resource: req.resource, code: (err as FhbError).code }, "fhb sync failed");
    throw err;
  }
}

/** Operator link of an unmatched FHB product to a master product (EAN is never used). */
export async function linkVendorProductToSku(
  accountId: string,
  vendorProductId: string,
  sku: string,
): Promise<"linked" | "no_product" | "not_found"> {
  return withAccountTransaction(accountId, async (tx) => {
    const vp = await tx.vendorProduct.findFirst({ where: { accountId, id: vendorProductId } });
    if (!vp) return "not_found";
    const product = await tx.product.findFirst({
      where: { accountId, sku: sku.trim(), archived: false },
      select: { id: true },
    });
    if (!product) return "no_product";
    await tx.vendorProduct.update({ where: { id: vp.id }, data: { productId: product.id } });
    return "linked";
  });
}
