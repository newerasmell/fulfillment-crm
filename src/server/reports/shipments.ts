import { Prisma } from "@/generated/prisma/client";
import { accountDb } from "@/server/db/client";
import type { ReportRange } from "./range";
import { assertReport, companySql, connectionTypeSql, reportQuery, type ReportCtx } from "./sql";

/**
 * Справка 2 — Пратки по склад и куриер: shipments (Fulfillment) created in the period, by warehouse connection
 * and carrier, from their current CRM status:
 *   sent       = has a ship date, or status SHIPPED / DELIVERED / COD_PAID / RETURNING / RETURN_RECEIVED;
 *   delivered  = DELIVERED / COD_PAID, or a delivery date without a return;
 *   returned   = RETURNING / RETURN_RECEIVED;
 *   cancelled  = CANCELLED before it was shipped (never sent; left out of both rates);
 *   in transit = sent − delivered − returned.
 * delivery rate = delivered / sent; return rate = returned / sent (shipments still on the way count in "sent").
 * The carrier is Fulfillment.carrier as the warehouse reported it (FHB parcel service code, named from the FHB
 * carrier list); euShipments shipments do not store their courier on the shipment, so they show "not recorded".
 */

export interface ShipmentCounts {
  created: number;
  sent: number;
  delivered: number;
  returned: number;
  cancelled: number;
  failed: number;
  inTransit: number;
}

export interface CarrierRow extends ShipmentCounts {
  carrier: string | null;
  carrierName: string | null;
}

export interface WarehouseRow extends ShipmentCounts {
  connectionId: string;
  name: string;
  type: string;
  carriers: CarrierRow[];
}

/** Pure: rate in [0,1] of `n` over sent shipments; null when nothing was sent. */
export const rate = (n: number, sent: number) => (sent > 0 ? n / sent : null);

const zero = (): ShipmentCounts => ({
  created: 0,
  sent: 0,
  delivered: 0,
  returned: 0,
  cancelled: 0,
  failed: 0,
  inTransit: 0,
});

const add = (a: ShipmentCounts, b: ShipmentCounts) => {
  for (const k of Object.keys(zero()) as (keyof ShipmentCounts)[]) a[k] += b[k];
};

export async function shipmentsReport(ctx: ReportCtx, range: ReportRange) {
  assertReport(ctx);
  const company = companySql(ctx, Prisma.sql`o."companyId"`);
  if (company === false) return { warehouses: [] as WarehouseRow[], total: zero() };
  const rows = await reportQuery<{
    connectionId: string;
    name: string;
    type: string;
    carrier: string | null;
    created: number;
    sent: number;
    delivered: number;
    returned: number;
    cancelled: number;
    failed: number;
  }>(
    ctx.accountId,
    Prisma.sql`
      WITH s AS (
        SELECT f."connectionId", f.carrier, f.status::text AS status,
               (f."shippedAt" IS NOT NULL
                 OR f.status IN ('SHIPPED','DELIVERED','COD_PAID','RETURNING','RETURN_RECEIVED')) AS sent,
               (f.status IN ('DELIVERED','COD_PAID')
                 OR (f."deliveredAt" IS NOT NULL AND f.status NOT IN ('RETURNING','RETURN_RECEIVED'))) AS delivered
          FROM "Fulfillment" f
          JOIN "Order" o ON o.id = f."orderId" AND o."accountId" = f."accountId"
          JOIN "FulfillmentConnection" c ON c.id = f."connectionId" AND c."accountId" = f."accountId"
         WHERE f."accountId" = ${ctx.accountId}
           AND f."createdAt" >= ${range.start} AND f."createdAt" < ${range.end}
           ${company}
           ${connectionTypeSql(ctx, Prisma.sql`c.type`)}
      )
      SELECT s."connectionId", c.name, c.type::text AS type, s.carrier,
             count(*)::int AS created,
             count(*) FILTER (WHERE s.sent)::int AS sent,
             count(*) FILTER (WHERE s.sent AND s.delivered)::int AS delivered,
             count(*) FILTER (WHERE s.status IN ('RETURNING','RETURN_RECEIVED'))::int AS returned,
             count(*) FILTER (WHERE s.status = 'CANCELLED' AND NOT s.sent)::int AS cancelled,
             count(*) FILTER (WHERE s.status = 'SUBMIT_FAILED' AND NOT s.sent)::int AS failed
        FROM s
        JOIN "FulfillmentConnection" c ON c.id = s."connectionId" AND c."accountId" = ${ctx.accountId}
       GROUP BY s."connectionId", c.name, c.type, s.carrier`,
  );
  const fhbIds = [...new Set(rows.filter((r) => r.type.startsWith("FHB")).map((r) => r.connectionId))];
  const carriers = fhbIds.length
    ? await accountDb(ctx.accountId).fhbCarrier.findMany({
        where: { connectionId: { in: fhbIds } },
        select: { connectionId: true, code: true, name: true },
      })
    : [];
  const carrierName = new Map(carriers.map((c) => [`${c.connectionId}:${c.code}`, c.name]));
  const byConn = new Map<string, WarehouseRow>();
  const total = zero();
  for (const r of rows) {
    const counts: ShipmentCounts = {
      created: r.created,
      sent: r.sent,
      delivered: r.delivered,
      returned: r.returned,
      cancelled: r.cancelled,
      failed: r.failed,
      inTransit: Math.max(0, r.sent - r.delivered - r.returned),
    };
    const w = byConn.get(r.connectionId) ?? {
      connectionId: r.connectionId,
      name: r.name,
      type: r.type,
      carriers: [],
      ...zero(),
    };
    byConn.set(r.connectionId, w);
    add(w, counts);
    add(total, counts);
    w.carriers.push({
      carrier: r.carrier,
      carrierName: r.carrier ? (carrierName.get(`${r.connectionId}:${r.carrier}`) ?? null) : null,
      ...counts,
    });
  }
  const warehouses = [...byConn.values()]
    .map((w) => ({ ...w, carriers: w.carriers.sort((a, b) => b.created - a.created) }))
    .sort((a, b) => b.created - a.created || a.name.localeCompare(b.name));
  return { warehouses, total };
}
export type ShipmentsReport = Awaited<ReturnType<typeof shipmentsReport>>;

const pct = (v: number | null) => (v == null ? "" : (v * 100).toFixed(1));

export function shipmentsCsv(r: ShipmentsReport, labels: { noCarrier: string }): string[][] {
  const out: string[][] = [
    [
      "warehouse",
      "type",
      "carrier",
      "created",
      "sent",
      "delivered",
      "returned",
      "in_transit",
      "cancelled_before_shipping",
      "submit_failed",
      "delivery_rate_pct",
      "return_rate_pct",
    ],
  ];
  const line = (w: WarehouseRow, carrier: string, c: ShipmentCounts) => [
    w.name,
    w.type,
    carrier,
    String(c.created),
    String(c.sent),
    String(c.delivered),
    String(c.returned),
    String(c.inTransit),
    String(c.cancelled),
    String(c.failed),
    pct(rate(c.delivered, c.sent)),
    pct(rate(c.returned, c.sent)),
  ];
  for (const w of r.warehouses) {
    out.push(line(w, "*", w));
    for (const c of w.carriers)
      out.push(
        line(w, c.carrierName ? `${c.carrierName} (${c.carrier})` : (c.carrier ?? labels.noCarrier), c),
      );
  }
  return out;
}
