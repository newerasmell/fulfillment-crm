import type { StockSource } from "@/generated/prisma/client";
import { accountDb } from "@/server/db/client";

/**
 * Stock arithmetic shared by the stock board, the discrepancy sweep and the Shopify inventory push (P5-01, P5-03,
 * SPEC §3 StockLevel): sellable = min(vendor free, physical − CRM-reserved), never below 0.
 *
 * CRM-reserved = units of orders the CRM has committed to a warehouse that the warehouse does not know about yet:
 *  - APPROVED orders without an active shipment, at the warehouse their check routed them to (OrderCheck.connectionId);
 *  - shipments QUEUED or SUBMITTING (the request has not been accepted by the warehouse yet).
 * Once the warehouse accepted an order its own free quantity already excludes it, so counting it again would
 * reserve it twice. Computed on read; StockLevel.reserved (used by the vendor pre-flights) is not rewritten here.
 */

export const NOT_AT_VENDOR_YET = ["QUEUED", "SUBMITTING"] as const;
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
  const [approved, shipments] = await Promise.all([
    db.order.findMany({
      where: { status: "APPROVED", check: { is: { connectionId: { not: null } } } },
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
  ]);
  const out = new Map<string, number>();
  const add = (connectionId: string, productId: string | null, qty: number) => {
    if (!productId || qty <= 0) return;
    const k = reservationKey(connectionId, productId);
    out.set(k, (out.get(k) ?? 0) + qty);
  };
  for (const o of approved) {
    // A queued shipment is counted below from its own lines; a failed/cancelled one reserves nothing.
    if (o.fulfillments.some((f) => !INACTIVE_SHIPMENT.has(f.status))) continue;
    for (const l of o.lines) add(o.check!.connectionId!, l.productId, l.quantity);
  }
  for (const f of shipments) for (const l of f.lines) add(f.connectionId, l.orderLine.productId, l.quantity);
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
