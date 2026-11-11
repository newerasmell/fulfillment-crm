import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, systemDb, withAccountTransaction, withSystemTransaction } from "@/server/db/client";
import { sameTag } from "@/integrations/shopify/order-tags";
import { shopifyTagsOf } from "@/server/shopify/order-tag-match";
import { queueTagChange } from "@/server/shopify/tag-queue";
import type { ScopedActor } from "@/server/stores";
import { CLOSED_INBOUND } from "./board";
import { crmReservations, isStale, reservationKey, sellableOf } from "./levels";
import { getStockSettings, staleHoursFor } from "./settings";

/**
 * "Липсващи артикули" (owner request 2026-11-10). A person tags a Shopify order `out_of_stock` when an item is not
 * there. The import notices the tag (syncStockWait) and the order is followed here until it can be shipped:
 *  - out_of_stock: every missing line is in an open inbound request of the CRM ("Приемане на стока", not fully
 *    received yet) → "expected", and the page offers "Чака зареждане" (the tag becomes waiting_for_stock);
 *  - waiting_for_stock: WAITING → PARTIAL (some of the lines missing when it started waiting are back; a task) →
 *    READY (every line in ONE warehouse, the parcel leaves one warehouse; a task) → "Потвърди" sets the store's
 *    confirmation tag (default "Confirmed") and the order enters review like any confirmed order.
 * Units back in stock go to the waiting orders oldest first (allocateStockWaits): two orders are never both READY
 * for the same unit. These orders already reserve their units (AWAITING_TAG and the pre-approval statuses do), so
 * the stores never sell what came back for them; the shares are computed from the warehouse numbers minus every
 * OTHER order's reservations. Tag changes go to Shopify through the ShopifyTagWrite outbox (store writeBackMode).
 */

export const OUT_OF_STOCK_TAG = "out_of_stock";
export const WAITING_TAG = "waiting_for_stock";

export type StockWaitStage = typeof OUT_OF_STOCK_TAG | typeof WAITING_TAG;
export type StockWaitState = "OUT_OF_STOCK" | "WAITING" | "PARTIAL" | "READY";
export const STOCK_WAIT_TABS = ["out", "waiting", "partial", "ready"] as const;
export type StockWaitTab = (typeof STOCK_WAIT_TABS)[number];
const TAB_STATE: Record<StockWaitTab, StockWaitState> = {
  out: "OUT_OF_STOCK",
  waiting: "WAITING",
  partial: "PARTIAL",
  ready: "READY",
};

/** Orders not with a warehouse yet: the only ones this flow follows. */
export const STOCK_WAIT_STATUSES = [
  "IMPORTED",
  "CHECKING",
  "NEEDS_REVIEW",
  "READY",
  "ON_HOLD",
  "AWAITING_TAG",
] as const;

const PARTIAL_TASK = "order_stock_partial";
const READY_TASK = "order_stock_ready";

/** Pure: the flow's tag on an order (case-insensitive); waiting_for_stock wins when both are there. */
export function stockWaitStage(tags: readonly string[]): StockWaitStage | null {
  // "Waiting for stock" typed by a person is the same tag as waiting_for_stock (sameTag).
  if (tags.some((t) => sameTag(t, WAITING_TAG))) return WAITING_TAG;
  if (tags.some((t) => sameTag(t, OUT_OF_STOCK_TAG))) return OUT_OF_STOCK_TAG;
  return null;
}

type Tx = Prisma.TransactionClient;

async function resolveTasks(tx: Tx, accountId: string, orderId: string, kinds: string[]) {
  await tx.alert.updateMany({
    where: {
      accountId,
      kind: { in: kinds },
      entityType: "Order",
      entityId: orderId,
      status: { not: "RESOLVED" },
    },
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });
}

/**
 * Starts, updates or ends following one order from its current tags and status (the import and the tag sender call
 * it in their transaction). A new row is evaluated by the next cron run (within two minutes).
 */
export async function syncStockWait(tx: Tx, accountId: string, orderId: string) {
  const order = await tx.order.findFirst({
    where: { id: orderId, accountId },
    select: { status: true, tags: true, raw: true, source: true },
  });
  const stage =
    order && order.source === "SHOPIFY" && (STOCK_WAIT_STATUSES as readonly string[]).includes(order.status)
      ? stockWaitStage(shopifyTagsOf(order.raw, order.tags))
      : null;
  const row = await tx.orderStockWait.findUnique({
    where: { accountId_orderId: { accountId, orderId } },
    select: { id: true, stage: true },
  });
  if (!stage) {
    if (row) {
      // deleteMany / updateMany: another caller (cron, import, a click) may have got there first.
      await tx.orderStockWait.deleteMany({ where: { accountId, orderId } });
      await resolveTasks(tx, accountId, orderId, [PARTIAL_TASK, READY_TASK]);
    }
    return null;
  }
  if (!row) {
    // Concurrent callers (import, tag sender, cron) may both get here: the second one changes nothing.
    await tx.orderStockWait.createMany({
      data: [{ accountId, orderId, stage, state: stage === WAITING_TAG ? "WAITING" : "OUT_OF_STOCK" }],
      skipDuplicates: true,
    });
  } else if (row.stage !== stage) {
    // Turned waiting_for_stock: what is missing NOW is what "Частично налични" follows from here.
    await tx.orderStockWait.updateMany({
      where: { accountId, orderId, stage: row.stage },
      data: {
        stage,
        state: stage === WAITING_TAG ? "WAITING" : "OUT_OF_STOCK",
        missingLineIds: [],
        notifiedState: null,
      },
    });
  }
  return stage;
}

// ───────────── allocation (pure) ─────────────

export interface WaitLine {
  lineId: string;
  productId: string | null;
  quantity: number;
}
export interface WaitOrder {
  orderId: string;
  placedAt: Date;
  lines: WaitLine[];
  /** Warehouses that may ship it (its product line's), in a stable order. */
  connectionIds: string[];
}
export interface WaitAllocation {
  orderId: string;
  /** The warehouse holding most of its lines (null: none holds any). */
  connectionId: string | null;
  /** Every line can leave from connectionId. */
  full: boolean;
  covered: string[];
}

/**
 * Pure: shares the free units (`pool`, per reservationKey) among the waiting orders, oldest first. Each order takes
 * its lines from the ONE warehouse that covers most of them (a parcel leaves one warehouse); covered lines take
 * their units from the pool, so a later order only gets what is left. Lines without a master product are never
 * covered.
 */
export function allocateStockWaits(orders: WaitOrder[], pool: Map<string, number>): WaitAllocation[] {
  const left = new Map(pool);
  const sorted = [...orders].sort(
    (a, b) => a.placedAt.getTime() - b.placedAt.getTime() || a.orderId.localeCompare(b.orderId),
  );
  const out: WaitAllocation[] = [];
  for (const o of sorted) {
    let best: { connectionId: string; covered: WaitLine[] } | null = null;
    for (const c of o.connectionIds) {
      // Units per product within this order (two lines of one product share the warehouse's units).
      const need = new Map<string, number>();
      const covered: WaitLine[] = [];
      for (const l of o.lines) {
        if (!l.productId) continue;
        const k = reservationKey(c, l.productId);
        const want = (need.get(k) ?? 0) + l.quantity;
        if ((left.get(k) ?? 0) >= want) {
          need.set(k, want);
          covered.push(l);
        }
      }
      if (!best || covered.length > best.covered.length) best = { connectionId: c, covered };
    }
    if (!best || best.covered.length === 0) {
      out.push({ orderId: o.orderId, connectionId: null, full: false, covered: [] });
      continue;
    }
    for (const l of best.covered) {
      const k = reservationKey(best.connectionId, l.productId!);
      left.set(k, (left.get(k) ?? 0) - l.quantity);
    }
    out.push({
      orderId: o.orderId,
      connectionId: best.connectionId,
      full: o.lines.length > 0 && best.covered.length === o.lines.length,
      covered: best.covered.map((l) => l.lineId),
    });
  }
  return out;
}

/** Pure: the state of a followed order from its stage and allocation. */
export function stockWaitState(
  stage: StockWaitStage,
  a: Pick<WaitAllocation, "full" | "covered">,
  missingAtStart: readonly string[],
): StockWaitState {
  // Everything is in one warehouse: ready to confirm, whichever tag it carries (an out_of_stock order whose items
  // came back before anyone switched it to waiting must not stay stuck under "Липсват").
  if (a.full) return "READY";
  if (stage === OUT_OF_STOCK_TAG) return "OUT_OF_STOCK";
  return missingAtStart.some((id) => a.covered.includes(id)) ? "PARTIAL" : "WAITING";
}

// ───────────── evaluation (cron) ─────────────

export interface WaitLineDetail {
  lineId: string;
  title: string;
  sku: string | null;
  quantity: number;
  unlinked: boolean;
  available: boolean;
  /** Missing when the order started waiting (null while out_of_stock). */
  wasMissing: boolean | null;
  expected: { connectionId: string; remaining: number; expectedAt: string | null; inboundId: string }[];
}

/** Open inbound requests: sent (or about to be) and not closed, with units still to arrive. */
const OPEN_INBOUND_EXCLUDED = [...CLOSED_INBOUND, "FAILED", "SUBMIT_FAILED"];

/** Re-evaluates every followed order of one account; opens a task when an order turns PARTIAL or READY. */
export async function evaluateStockWaits(accountId: string, now: Date = new Date()) {
  const db = accountDb(accountId);
  const rows = await db.orderStockWait.findMany({
    select: {
      id: true,
      orderId: true,
      stage: true,
      state: true,
      missingLineIds: true,
      notifiedState: true,
      updatedAt: true,
      order: {
        select: {
          number: true,
          placedAt: true,
          status: true,
          company: { select: { lineId: true } },
          lines: {
            select: { id: true, productId: true, quantity: true, title: true, sku: true },
            orderBy: { id: "asc" },
          },
        },
      },
    },
  });
  // Cancelled, sent or fulfilled meanwhile (not through an import): no longer followed — and never given units.
  const followed = rows.filter((r) => (STOCK_WAIT_STATUSES as readonly string[]).includes(r.order.status));
  for (const r of rows)
    if (!followed.includes(r))
      await withAccountTransaction(accountId, (tx) => syncStockWait(tx, accountId, r.orderId));
  rows.splice(0, rows.length, ...followed);
  const candidates = await autoTagCandidates(accountId, now);
  if (!rows.length && !candidates.length) return { evaluated: 0, notified: 0, tagged: 0 };
  const productIds = [
    ...new Set(
      [...rows.map((r) => r.order), ...candidates]
        .flatMap((o) => o.lines.map((l) => l.productId))
        .filter((x): x is string => !!x),
    ),
  ];
  const [reservations, vps, inbound] = await Promise.all([
    // Only the followed orders are left out: a new order keeps its own reservation (its units are never handed to
    // an older waiting order), so the waiting orders see exactly what they saw before the automatic tag existed.
    crmReservations(accountId, productIds, { excludeOrderIds: rows.map((r) => r.orderId) }),
    db.vendorProduct.findMany({
      where: { productId: { in: productIds }, archived: false, connection: { enabled: true } },
      select: {
        connectionId: true,
        productId: true,
        stockLevel: { select: { physical: true, free: true, snapshotAt: true } },
        connection: { select: { type: true, company: { select: { lineId: true } } } },
      },
      orderBy: { id: "asc" },
    }),
    db.inboundLine.findMany({
      where: { productId: { in: productIds }, inbound: { status: { notIn: OPEN_INBOUND_EXCLUDED } } },
      select: {
        productId: true,
        expectedQty: true,
        receivedQty: true,
        inbound: { select: { id: true, connectionId: true, expectedAt: true } },
      },
    }),
  ]);
  // Free units per (warehouse, product) after every other order's reservations.
  const pool = new Map<string, number>();
  const lineOfConnection = new Map<string, string | null>();
  for (const v of vps) {
    lineOfConnection.set(v.connectionId, v.connection.company?.lineId ?? null);
    const k = reservationKey(v.connectionId, v.productId!);
    if (pool.has(k) || !v.stockLevel) continue;
    pool.set(k, sellableOf(v.stockLevel, reservations.get(k) ?? 0));
  }
  const connections = [...lineOfConnection.keys()].sort();
  const connectionsFor = (lineId: string | null | undefined) =>
    lineId ? connections.filter((c) => lineOfConnection.get(c) === lineId) : connections;
  const allocations = new Map(
    allocateStockWaits(
      rows.map((r) => ({
        orderId: r.orderId,
        placedAt: r.order.placedAt,
        lines: r.order.lines.map((l) => ({ lineId: l.id, productId: l.productId, quantity: l.quantity })),
        connectionIds: connectionsFor(r.order.company?.lineId),
      })),
      pool,
    ).map((a) => [a.orderId, a]),
  );
  const tagged = candidates.length
    ? await autoTag(accountId, now, candidates, {
        vps,
        rowOrderIds: rows.map((r) => r.orderId),
        rows,
        allocations,
        connectionsFor,
      })
    : 0;
  let notified = 0;
  for (const r of rows) {
    const a = allocations.get(r.orderId)!;
    const stage = r.stage as StockWaitStage;
    const missingNow = r.order.lines.filter((l) => !a.covered.includes(l.id)).map((l) => l.id);
    // What was missing when it started waiting (taken at its first evaluation as waiting_for_stock).
    const missingAtStart =
      stage === WAITING_TAG ? (r.missingLineIds.length ? r.missingLineIds : missingNow) : [];
    const candidates = new Set(connectionsFor(r.order.company?.lineId));
    const lines: WaitLineDetail[] = r.order.lines.map((l) => {
      const available = a.covered.includes(l.id);
      return {
        lineId: l.id,
        title: l.title,
        sku: l.sku,
        quantity: l.quantity,
        unlinked: !l.productId,
        available,
        wasMissing: stage === WAITING_TAG ? missingAtStart.includes(l.id) : null,
        expected:
          available || !l.productId
            ? []
            : inbound
                .filter(
                  (i) =>
                    i.productId === l.productId &&
                    candidates.has(i.inbound.connectionId) &&
                    i.expectedQty - (i.receivedQty ?? 0) > 0,
                )
                .map((i) => ({
                  connectionId: i.inbound.connectionId,
                  remaining: i.expectedQty - (i.receivedQty ?? 0),
                  expectedAt: i.inbound.expectedAt?.toISOString() ?? null,
                  inboundId: i.inbound.id,
                })),
      };
    });
    const missing = lines.filter((l) => !l.available);
    const expected = missing.length > 0 && missing.every((l) => l.expected.length > 0);
    const state = stockWaitState(stage, a, missingAtStart);
    // Notified once per stage: READY once; PARTIAL again only when MORE of its lines are back than ever before.
    // The marker only goes up (a unit taken back for one run and returned does not notify again); a stage change
    // (syncStockWait) starts it over.
    const backCount = missingAtStart.filter((id) => a.covered.includes(id)).length;
    const was = r.notifiedState ?? "";
    const wasPartial = was.startsWith("PARTIAL:") ? Number(was.slice(8)) || 0 : 0;
    const notify =
      (state === "READY" && was !== "READY") ||
      (state === "PARTIAL" && was !== "READY" && backCount > wasPartial);
    const mark = notify ? (state === "READY" ? "READY" : `PARTIAL:${backCount}`) : r.notifiedState;
    await withAccountTransaction(accountId, async (tx) => {
      const res = await tx.orderStockWait.updateMany({
        // Unchanged since it was read (a tag change meanwhile is evaluated by the next run).
        where: { id: r.id, stage: r.stage, updatedAt: r.updatedAt },
        data: {
          state,
          expected,
          readyConnectionId: a.full ? a.connectionId : null,
          missingLineIds: missingAtStart,
          detail: { connectionId: a.connectionId, lines } as unknown as Prisma.InputJsonValue,
          evaluatedAt: now,
          notifiedState: mark,
        },
      });
      if (res.count !== 1) return;
      // Dropped below READY (a unit went to an older order): its "confirm it" task no longer applies; the marker
      // stays, so coming back does not notify again.
      if (state !== "READY") await resolveTasks(tx, accountId, r.orderId, [READY_TASK]);
      if (!notify) return;
      const kind = state === "READY" ? READY_TASK : PARTIAL_TASK;
      await resolveTasks(tx, accountId, r.orderId, [PARTIAL_TASK, READY_TASK]);
      await tx.alert.create({
        data: {
          accountId,
          kind,
          isTask: true,
          severity: "WARNING",
          title:
            state === "READY"
              ? `Order ${r.order.number}: every item is back in stock — confirm it`
              : `Order ${r.order.number}: ${backCount} of ${missingAtStart.length} missing items are back in stock`,
          body: "Поръчки → Липсващи артикули",
          entityType: "Order",
          entityId: r.orderId,
        },
      });
      notified++;
    });
  }
  return { evaluated: rows.length, notified, tagged };
}

type Candidate = Awaited<ReturnType<typeof autoTagCandidates>>[number];

/**
 * Automatic out_of_stock: a new order no ONE warehouse of its line can fill. Per order, against the warehouse numbers
 * minus every other order's reservations and minus what the waiting orders were given — its own reservation is
 * added back (it holds its units already). Not when any item has no fresh warehouse snapshot (a stopped stock sync
 * must not tag every new order), and once per order. Queued only for stores that write to Shopify (LIVE).
 */
async function autoTag(
  accountId: string,
  now: Date,
  candidates: Candidate[],
  ctx: {
    vps: {
      connectionId: string;
      productId: string | null;
      stockLevel: { physical: number; free: number; snapshotAt: Date } | null;
      connection: { type: string };
    }[];
    rowOrderIds: string[];
    rows: { order: { lines: { id: string; productId: string | null; quantity: number }[] } }[];
    allocations: Map<string, WaitAllocation>;
    connectionsFor: (lineId: string | null | undefined) => string[];
  },
) {
  const settings = await getStockSettings(accountId);
  // The new orders share the units among themselves oldest first, like the waiting orders do: the warehouse numbers
  // minus every OTHER order's reservations (theirs and the waiting orders' left out), minus what the waiting orders
  // were given. Unclamped: a negative number stays negative. Only fresh snapshots count.
  const reservations = await crmReservations(accountId, [...new Set(ctx.vps.map((v) => v.productId!))], {
    excludeOrderIds: [...ctx.rowOrderIds, ...candidates.map((c) => c.id)],
  });
  const pool = new Map<string, number>();
  const carriers = new Set<string>();
  for (const v of ctx.vps) {
    const k = reservationKey(v.connectionId, v.productId!);
    carriers.add(k);
    if (pool.has(k) || !v.stockLevel) continue;
    if (isStale(v.stockLevel.snapshotAt, staleHoursFor(settings, v.connection.type), now)) continue;
    // min(free − given, physical − reserved − given) = min(free, physical − reserved) − given.
    pool.set(k, Math.min(v.stockLevel.free, v.stockLevel.physical - (reservations.get(k) ?? 0)));
  }
  for (const r of ctx.rows)
    for (const l of r.order.lines) {
      const a = [...ctx.allocations.values()].find((x) => x.covered.includes(l.id));
      if (!a?.connectionId || !l.productId) continue;
      const k = reservationKey(a.connectionId, l.productId);
      if (pool.has(k)) pool.set(k, pool.get(k)! - l.quantity);
    }
  const shares = new Map(
    allocateStockWaits(
      candidates.map((c) => ({
        orderId: c.id,
        placedAt: c.placedAt,
        lines: c.lines.map((l) => ({ lineId: l.id, productId: l.productId, quantity: l.quantity })),
        connectionIds: ctx.connectionsFor(c.company?.lineId),
      })),
      pool,
    ).map((a) => [a.orderId, a]),
  );
  let tagged = 0;
  for (const c of candidates) {
    if (shares.get(c.id)!.full) continue;
    const conns = ctx.connectionsFor(c.company?.lineId);
    // Every warehouse of its line that carries the product has fresh numbers (one stopped sync could be hiding
    // the units): otherwise people decide.
    const known = c.lines.every((l) => {
      const at = conns.filter((conn) => carriers.has(reservationKey(conn, l.productId!)));
      return at.length > 0 && at.every((conn) => pool.has(reservationKey(conn, l.productId!)));
    });
    if (!known) continue;
    const queued = await withAccountTransaction(accountId, async (tx, { lockKey, lockForUpdate }) => {
      await lockKey(`order-tags:${c.id}`);
      await lockForUpdate("Order", c.id);
      // Again under the lock: approved, sent, followed or tagged meanwhile → nothing.
      const now2 = await tx.order.findFirst({
        where: { id: c.id, accountId, status: { in: [...AUTO_TAG_STATUSES] }, stockWait: null },
        select: { id: true },
      });
      if (!now2) return false;
      const before = await tx.shopifyTagWrite.count({
        where: { accountId, orderId: c.id, add: { has: OUT_OF_STOCK_TAG } },
      });
      if (before) return false;
      await queueTagChange(tx, {
        accountId,
        storeId: c.storeId!,
        orderId: c.id,
        add: [OUT_OF_STOCK_TAG],
        remove: [],
      });
      return true;
    });
    if (!queued) continue;
    tagged++;
    await recordAudit({
      accountId,
      action: "order.stock_wait.auto_out_of_stock",
      entityType: "Order",
      entityId: c.id,
      after: { add: [OUT_OF_STOCK_TAG] },
    });
  }
  return tagged;
}

/** Statuses of a new order the automatic out_of_stock tag may look at (not held, not with a warehouse). */
const AUTO_TAG_STATUSES = ["AWAITING_TAG", "IMPORTED", "CHECKING", "NEEDS_REVIEW", "READY"] as const;
/** How long after it came in a new order is still looked at (stock sold elsewhere meanwhile counts too). */
export const AUTO_TAG_WINDOW_MS = 24 * 3_600_000;

/**
 * New Shopify orders of stores with the automatic tag on: created since it was switched on and within the last day,
 * not followed yet, not tagged by us before, every line linked to a master product.
 */
async function autoTagCandidates(accountId: string, now: Date) {
  const db = accountDb(accountId);
  const stores = await db.store.findMany({
    // Only stores that write to Shopify: a refused or test write would use up the order's one tag.
    where: { outOfStockAutoTagSince: { not: null }, archivedAt: null, writeBackMode: "LIVE" },
    select: { id: true, outOfStockAutoTagSince: true },
  });
  if (!stores.length) return [];
  const windowStart = new Date(now.getTime() - AUTO_TAG_WINDOW_MS);
  return db.order.findMany({
    where: {
      source: "SHOPIFY",
      status: { in: [...AUTO_TAG_STATUSES] },
      stockWait: null,
      tagWrites: { none: { add: { has: OUT_OF_STOCK_TAG } } },
      AND: [{ lines: { some: {} } }, { lines: { none: { productId: null } } }],
      // Came in after the switch-on and within the last day, by Shopify's date too (a backfill of old orders is not
      // "new").
      OR: stores.map((st) => {
        const from = st.outOfStockAutoTagSince! > windowStart ? st.outOfStockAutoTagSince! : windowStart;
        return { storeId: st.id, createdAt: { gte: from }, placedAt: { gte: from } };
      }),
    },
    select: {
      id: true,
      storeId: true,
      placedAt: true,
      company: { select: { lineId: true } },
      lines: { select: { id: true, productId: true, quantity: true }, orderBy: { id: "asc" } },
    },
    orderBy: { placedAt: "asc" },
    take: 300,
  });
}

/**
 * Orders that carry a flow tag but are not followed (tagged before this existed, or a webhook was missed): found by
 * their tags, whatever the spelling ("Waiting for stock", "OUT_OF_STOCK"…), and handed to syncStockWait.
 */
export async function discoverStockWaits(limit = 500) {
  const found = await withSystemTransaction(
    (tx) => tx.$queryRaw<{ id: string; accountId: string }[]>`
      SELECT o.id, o."accountId" FROM "Order" o
      WHERE o.source = 'SHOPIFY'::"OrderSource"
        AND o.status = ANY(ARRAY['IMPORTED', 'CHECKING', 'NEEDS_REVIEW', 'READY', 'ON_HOLD', 'AWAITING_TAG']::"CrmOrderStatus"[])
        AND NOT EXISTS (SELECT 1 FROM "OrderStockWait" w WHERE w."accountId" = o."accountId" AND w."orderId" = o.id)
        AND EXISTS (
          SELECT 1 FROM unnest(o.tags) t
          WHERE regexp_replace(lower(trim(t)), '[[:space:]_-]+', ' ', 'g') IN ('out of stock', 'waiting for stock')
        )
      ORDER BY o."updatedAt" DESC
      LIMIT ${limit}`,
  );
  for (const o of found)
    await withAccountTransaction(o.accountId, (tx) => syncStockWait(tx, o.accountId, o.id));
  return found.length;
}

/** Cron: every account that follows orders. */
let lastDiscoveryAt = 0;
/** The tag search scans orders: every 30 minutes (the import notices tags on its own; this catches the rest). */
export const DISCOVERY_EVERY_MS = 30 * 60_000;

export async function runStockWaitEvaluation(now: Date = new Date()) {
  let discovered = 0;
  if (now.getTime() - lastDiscoveryAt >= DISCOVERY_EVERY_MS) {
    discovered = await discoverStockWaits();
    lastDiscoveryAt = now.getTime();
  }
  const [waiting, auto] = await Promise.all([
    systemDb().orderStockWait.findMany({ select: { accountId: true }, distinct: ["accountId"] }),
    systemDb().store.findMany({
      where: { outOfStockAutoTagSince: { not: null }, archivedAt: null, writeBackMode: "LIVE" },
      select: { accountId: true },
      distinct: ["accountId"],
    }),
  ]);
  const accounts = [...new Set([...waiting, ...auto].map((a) => a.accountId))].map((accountId) => ({
    accountId,
  }));
  let notified = 0;
  let tagged = 0;
  for (const { accountId } of accounts) {
    try {
      const r = await evaluateStockWaits(accountId, now);
      notified += r.notified;
      tagged += r.tagged;
    } catch (err) {
      logger.warn({ accountId, err: (err as Error).message }, "stock wait evaluation failed for an account");
    }
  }
  return { accounts: accounts.length, notified, tagged, discovered };
}

// ───────────── page + actions ─────────────

const scopeWhere = (actor: ScopedActor): Prisma.OrderWhereInput =>
  actor.companyScope ? { companyId: { in: actor.companyScope } } : {};

/** The page: counts per tab and the rows of one tab (company-scoped). */
export async function stockWaitOverview(actor: ScopedActor, tab: StockWaitTab) {
  assertCan(actor.role, "account.read");
  const db = accountDb(actor.accountId);
  const order = scopeWhere(actor);
  const [counts, rows, connections] = await Promise.all([
    db.orderStockWait.groupBy({ by: ["state"], where: { order }, _count: { _all: true } }),
    db.orderStockWait.findMany({
      where: { state: TAB_STATE[tab], order },
      select: {
        id: true,
        orderId: true,
        stage: true,
        state: true,
        expected: true,
        readyConnectionId: true,
        detail: true,
        evaluatedAt: true,
        order: {
          select: {
            number: true,
            placedAt: true,
            customerName: true,
            store: {
              select: { id: true, name: true, writeBackMode: true, connectionStatus: true },
            },
            tagWrites: {
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { status: true, add: true, remove: true, lastError: true, createdAt: true },
            },
          },
        },
      },
      orderBy: { order: { placedAt: "asc" } },
      take: 500,
    }),
    db.fulfillmentConnection.findMany({ select: { id: true, name: true, type: true } }),
  ]);
  const count = Object.fromEntries(STOCK_WAIT_TABS.map((t) => [t, 0])) as Record<StockWaitTab, number>;
  for (const c of counts)
    for (const t of STOCK_WAIT_TABS) if (TAB_STATE[t] === c.state) count[t] = c._count._all;
  return {
    count,
    connections: new Map(connections.map((c) => [c.id, c])),
    rows: rows.map((r) => {
      const scopes = (r.order.store?.connectionStatus as { scopes?: string[] } | null)?.scopes;
      return {
        ...r,
        detail: (r.detail ?? { connectionId: null, lines: [] }) as unknown as {
          connectionId: string | null;
          lines: WaitLineDetail[];
        },
        /** null = not known (the store's connection was not tested since the scope was added). */
        canWriteTags: scopes ? scopes.includes("write_orders") : null,
        lastWrite: r.order.tagWrites[0] ?? null,
      };
    }),
  };
}

export const StockWaitDecision = z.object({
  action: z.enum(["waiting", "confirm"]),
  orderIds: z.array(z.string().min(1)).min(1).max(200),
});

/**
 * "Чака зареждане" (out_of_stock → waiting_for_stock) and "Потвърди" (READY → the store's confirmation tag) for
 * one or many orders. Each queues one ShopifyTagWrite; the order moves when Shopify has the tags (the sender
 * updates our copy). Orders not in the right state are skipped and counted.
 */
export async function decideStockWait(actor: ScopedActor, raw: z.input<typeof StockWaitDecision>) {
  assertCan(actor.role, "orders.review");
  const { action, orderIds } = StockWaitDecision.parse(raw);
  const accountId = actor.accountId;
  // "Потвърди" decides on the numbers of right now, not on the last cron run (up to two minutes old).
  if (action === "confirm")
    await evaluateStockWaits(accountId).catch((err: Error) =>
      // The last cron result still stands (at most two minutes old): never blocks the click.
      logger.warn({ accountId, err: err.message }, "stock wait re-evaluation before confirm failed"),
    );
  let queued = 0;
  let skipped = 0;
  for (const orderId of [...new Set(orderIds)]) {
    const ok = await withAccountTransaction(accountId, async (tx, { lockKey }) => {
      await lockKey(`order-tags:${orderId}`);
      const row = await tx.orderStockWait.findUnique({
        where: { accountId_orderId: { accountId, orderId } },
        select: {
          stage: true,
          state: true,
          expected: true,
          order: { select: { companyId: true, storeId: true, tags: true, raw: true } },
        },
      });
      if (!row || !row.order.storeId) return null;
      if (actor.companyScope && !actor.companyScope.includes(row.order.companyId ?? "")) return null;
      const open = await tx.shopifyTagWrite.count({
        where: { accountId, orderId, status: { in: ["PENDING", "SENDING", "PAUSED"] } },
      });
      if (open) return null; // a change of this order is still on its way
      const tags = shopifyTagsOf(row.order.raw, row.order.tags);
      let add: string[];
      let remove: string[];
      if (action === "waiting") {
        // Only when every missing item is expected (checked here, not only on the page: it may be stale).
        if (row.stage !== OUT_OF_STOCK_TAG || row.state !== "OUT_OF_STOCK" || !row.expected) return null;
        add = [WAITING_TAG];
        remove = [OUT_OF_STOCK_TAG];
      } else {
        if (row.state !== "READY") return null;
        const gate = await tx.storeOrderTag.findUnique({
          where: { accountId_storeId: { accountId, storeId: row.order.storeId } },
          select: { tag: true },
        });
        // The store's confirmation tag moves the order from "Чака таг" into review. A store without one already
        // takes every order: only the flow's tags are removed.
        add = gate ? [gate.tag] : [];
        remove = [WAITING_TAG, OUT_OF_STOCK_TAG];
      }
      const id = await queueTagChange(tx, {
        accountId,
        storeId: row.order.storeId,
        orderId,
        add,
        remove: remove.filter((r) => tags.some((t) => sameTag(t, r))),
        createdById: actor.userId,
      });
      return { id, add, remove };
    });
    if (!ok) {
      skipped++;
      continue;
    }
    queued++;
    await recordAudit({
      accountId,
      userId: actor.userId,
      action: action === "waiting" ? "order.stock_wait.waiting" : "order.stock_wait.confirm",
      entityType: "Order",
      entityId: orderId,
      after: { tagWriteId: ok.id, add: ok.add, remove: ok.remove },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  }
  if (!queued && skipped) throw new DomainError("stock_wait_nothing_to_do");
  return { queued, skipped };
}

export const OutOfStockAutoTagInput = z.object({ storeId: z.string().min(1).max(64), enabled: z.boolean() });

/**
 * Turns the automatic out_of_stock tag of one store on (from now: only orders that come in after this) or off.
 * stores.manage; audited.
 */
export async function setOutOfStockAutoTag(actor: ScopedActor, raw: z.input<typeof OutOfStockAutoTagInput>) {
  assertCan(actor.role, "stores.manage");
  const { storeId, enabled } = OutOfStockAutoTagInput.parse(raw);
  const db = accountDb(actor.accountId);
  const store = await db.store.findFirst({
    where: {
      id: storeId,
      archivedAt: null,
      ...(actor.companyScope ? { companyId: { in: actor.companyScope } } : {}),
    },
    select: { id: true, outOfStockAutoTagSince: true },
  });
  if (!store) throw new DomainError("not_found");
  if (enabled === !!store.outOfStockAutoTagSince) return { enabled };
  await db.store.update({
    where: { id: storeId },
    data: { outOfStockAutoTagSince: enabled ? new Date() : null },
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "store.out_of_stock_auto_tag",
    entityType: "Store",
    entityId: storeId,
    before: { enabled: !!store.outOfStockAutoTagSince },
    after: { enabled },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return { enabled };
}

/** Stores and their automatic-tag setting (the page's settings card; company-scoped). */
export async function outOfStockAutoTagStores(actor: ScopedActor) {
  return accountDb(actor.accountId).store.findMany({
    where: { archivedAt: null, ...(actor.companyScope ? { companyId: { in: actor.companyScope } } : {}) },
    select: { id: true, name: true, outOfStockAutoTagSince: true, writeBackMode: true },
    orderBy: { name: "asc" },
  });
}
