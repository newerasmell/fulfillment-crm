import type { StockSource } from "@/generated/prisma/client";
import { accountDb } from "@/server/db/client";

/**
 * Stock arithmetic shared by the stock board, the discrepancy sweep and the Shopify inventory push (P5-01, P5-03,
 * SPEC §3 StockLevel): sellable = min(vendor free, physical − CRM-reserved), never below 0.
 *
 * CRM-reserved = units the CRM has promised that the warehouse's numbers do not show yet. Shopify's own
 * `available` already subtracts every unfulfilled order as `committed`, so anything that is in the warehouse's
 * free quantity but promised to a customer must be reserved here, or the push hands it back to Shopify (oversell):
 *  - every order not yet at a warehouse (IMPORTED, CHECKING, NEEDS_REVIEW, READY, APPROVED, SUBMIT_FAILED,
 *    ON_HOLD, BLOCKED) without an active shipment: at the warehouse its check routed it to (OrderCheck.connectionId),
 *    or, while it is not routed, at EVERY warehouse that carries the product (conservative: it may go anywhere);
 *  - shipments QUEUED or SUBMITTING (the request has not been accepted by the warehouse yet);
 *  - shipments ACCEPTED or PROCESSING accepted AFTER the warehouse snapshot of that product was taken (a daily
 *    euShipments snapshot does not exclude an order accepted this morning yet).
 * Once the warehouse accepted an order before its snapshot, the vendor's free quantity already excludes it, so
 * counting it again would reserve it twice. Computed on read; StockLevel.reserved (used by the vendor pre-flights)
 * is not rewritten here.
 */

export const NOT_AT_VENDOR_YET = ["QUEUED", "SUBMITTING"] as const;
/** Order statuses that mean "promised to a customer, not inside any warehouse's numbers yet". */
export const ORDER_NOT_AT_WAREHOUSE = [
  "IMPORTED",
  "CHECKING",
  "NEEDS_REVIEW",
  "READY",
  "APPROVED",
  "SUBMIT_FAILED",
  "ON_HOLD",
  "BLOCKED",
] as const;
const AT_VENDOR = ["ACCEPTED", "PROCESSING"] as const;
const INACTIVE_SHIPMENT = new Set(["SUBMIT_FAILED", "CANCELLED"]);

export const reservationKey = (connectionId: string, productId: string) => `${connectionId}:${productId}`;

/** Pure: sellable from a vendor snapshot and the CRM reservation. */
export function sellableOf(level: { physical: number; free: number }, reserved: number) {
  return Math.max(0, Math.min(level.free, level.physical - reserved));
}

/** Pure: is a snapshot older than `staleHours`? */
export function isStale(snapshotAt: Date, staleHours: number, now: Date) {
  return now.getTime() - snapshotAt.getTime() > staleHours * 3_600_000;
}

/** Units reserved by the CRM per (connection, product). */
export async function crmReservations(accountId: string): Promise<Map<string, number>> {
  const db = accountDb(accountId);
  const [orders, queued, accepted] = await Promise.all([
    db.order.findMany({
      where: { status: { in: [...ORDER_NOT_AT_WAREHOUSE] } },
      select: {
        check: { select: { connectionId: true } },
        lines: { select: { productId: true, quantity: true } },
        fulfillments: { select: { status: true } },
      },
    }),
    db.fulfillment.findMany({
      where: { status: { in: [...NOT_AT_VENDOR_YET] } },
      select: {
        connectionId: true,
        lines: { select: { quantity: true, orderLine: { select: { productId: true } } } },
      },
    }),
    db.fulfillment.findMany({
      where: { status: { in: [...AT_VENDOR] } },
      select: {
        connectionId: true,
        submittedAt: true,
        updatedAt: true,
        lines: { select: { quantity: true, orderLine: { select: { productId: true } } } },
      },
    }),
  ]);
  const out = new Map<string, number>();
  const add = (connectionId: string, productId: string | null, qty: number) => {
    if (!productId || qty <= 0) return;
    const k = reservationKey(connectionId, productId);
    out.set(k, (out.get(k) ?? 0) + qty);
  };
  const unrouted: { productId: string; quantity: number }[] = [];
  for (const o of orders) {
    // A queued/accepted shipment is counted below from its own lines; a failed/cancelled one reserves nothing.
    if (o.fulfillments.some((f) => !INACTIVE_SHIPMENT.has(f.status))) continue;
    const routed = o.check?.connectionId ?? null;
    for (const l of o.lines) {
      if (!l.productId) continue;
      if (routed) add(routed, l.productId, l.quantity);
      else unrouted.push({ productId: l.productId, quantity: l.quantity });
    }
  }
  for (const f of queued) for (const l of f.lines) add(f.connectionId, l.orderLine.productId, l.quantity);

  // The warehouses that carry each product: unrouted orders and the snapshot times of accepted shipments.
  const productIds = new Set<string>(unrouted.map((u) => u.productId));
  for (const f of accepted)
    for (const l of f.lines) if (l.orderLine.productId) productIds.add(l.orderLine.productId);
  if (productIds.size === 0) return out;
  const vps = await db.vendorProduct.findMany({
    where: { productId: { in: [...productIds] }, archived: false },
    select: { connectionId: true, productId: true, stockLevel: { select: { snapshotAt: true } } },
    orderBy: { id: "asc" },
  });
  const carriers = new Map<string, Set<string>>();
  const snapshotOf = new Map<string, Date | null>();
  for (const v of vps) {
    const set = carriers.get(v.productId!) ?? new Set<string>();
    set.add(v.connectionId);
    carriers.set(v.productId!, set);
    const k = reservationKey(v.connectionId, v.productId!);
    if (!snapshotOf.has(k)) snapshotOf.set(k, v.stockLevel?.snapshotAt ?? null);
  }
  for (const u of unrouted) for (const c of carriers.get(u.productId) ?? []) add(c, u.productId, u.quantity);
  for (const f of accepted) {
    // When the warehouse accepted it; updatedAt (later or equal) is the conservative fallback.
    const acceptedAt = f.submittedAt ?? f.updatedAt;
    for (const l of f.lines) {
      const pid = l.orderLine.productId;
      if (!pid) continue;
      const snap = snapshotOf.get(reservationKey(f.connectionId, pid));
      if (snap && acceptedAt > snap) add(f.connectionId, pid, l.quantity);
    }
  }
  return out;
}

/** Units sold per product over the last `days` days (every order the CRM did not cancel), for run-out estimates. */
export async function salesByProduct(accountId: string, days: number, now: Date = new Date()) {
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await accountDb(accountId).orderLine.groupBy({
    by: ["productId"],
    where: { productId: { not: null }, order: { placedAt: { gte: since }, status: { not: "CANCELLED" } } },
    _sum: { quantity: true },
  });
  return new Map(rows.map((r) => [r.productId!, r._sum.quantity ?? 0]));
}

/** Pure: days until sellable runs out at the average daily sales of the window; null = no sales (never). */
export function daysLeft(sellable: number, soldInWindow: number, windowDays: number): number | null {
  if (soldInWindow <= 0) return null;
  return sellable / (soldInWindow / windowDays);
}

export interface WarehouseCell {
  connectionId: string;
  vendorProductId: string;
  vendorId: string;
  vendorCode: string | null;
  physical: number;
  free: number;
  reserved: number;
  sellable: number;
  snapshotAt: Date | null;
  source: StockSource | null;
  stale: boolean;
}
