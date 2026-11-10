import { Prisma } from "@/generated/prisma/client";
import type { ReportRange } from "./range";
import { assertReport, companySql, reportQuery, type ReportCtx } from "./sql";

/**
 * Справка 3 — Време за обработка, for orders placed in the period (not cancelled):
 *   imported  = Order.createdAt (when the CRM first saw it);
 *   approved  = first OrderEvent to APPROVED;
 *   submitted = first shipment's submittedAt, else the first OrderEvent to ACCEPTED / PROCESSING;
 *   shipped   = first shipment's shippedAt, else the first OrderEvent to SHIPPED;
 *   delivered = first shipment's deliveredAt, else the first OrderEvent to DELIVERED / COD_PAID.
 * Median and p90 (Postgres percentile_cont) per step, overall and per warehouse of the first shipment. A step
 * counts only when both ends exist and are in order. Shipments are looked up from the period start on (a
 * shipment is never created before its order), so the query stays on the date indexes.
 */

export const STAGES = ["approve", "submit", "ship", "deliver", "total"] as const;
export type Stage = (typeof STAGES)[number];

export interface StageStat {
  n: number;
  /** Seconds. */
  median: number | null;
  p90: number | null;
}

export interface TimingRow {
  connectionId: string | null;
  name: string | null;
  type: string | null;
  orders: number;
  stages: Record<Stage, StageStat>;
}

/** Column pairs per stage (fixed identifiers, never input). */
const PAIRS: Record<Stage, [string, string]> = {
  approve: ["imported", "approved"],
  submit: ["approved", "submitted"],
  ship: ["submitted", "shipped"],
  deliver: ["shipped", "delivered"],
  total: ["imported", "delivered"],
};

export async function timingReport(ctx: ReportCtx, range: ReportRange) {
  assertReport(ctx);
  const company = companySql(ctx, Prisma.sql`o."companyId"`);
  if (company === false) return { overall: null as TimingRow | null, warehouses: [] as TimingRow[] };
  const scoped = ctx.connectionTypes
    ? ctx.connectionTypes.length
      ? Prisma.sql`WHERE c.type::text IN (${Prisma.join([...ctx.connectionTypes])})`
      : Prisma.sql`WHERE FALSE`
    : Prisma.empty;
  const select = Prisma.join(
    STAGES.map((s) => {
      const [a, b] = PAIRS[s];
      const d = Prisma.raw(`extract(epoch FROM (t.${b} - t.${a}))`);
      const ok = Prisma.raw(`t.${a} IS NOT NULL AND t.${b} IS NOT NULL AND t.${b} >= t.${a}`);
      return Prisma.sql`count(*) FILTER (WHERE ${ok})::int AS ${Prisma.raw(`"${s}_n"`)},
        percentile_cont(0.5) WITHIN GROUP (ORDER BY ${d}) FILTER (WHERE ${ok}) AS ${Prisma.raw(`"${s}_p50"`)},
        percentile_cont(0.9) WITHIN GROUP (ORDER BY ${d}) FILTER (WHERE ${ok}) AS ${Prisma.raw(`"${s}_p90"`)}`;
    }),
    ",\n",
  );
  const rows = await reportQuery<Record<string, unknown>>(
    ctx.accountId,
    Prisma.sql`
      WITH o AS (
        SELECT o.id, o."createdAt" AS imported
          FROM "Order" o
         WHERE o."accountId" = ${ctx.accountId}
           AND o."placedAt" >= ${range.start} AND o."placedAt" < ${range.end}
           AND o.status NOT IN ('CANCELLED', 'AWAITING_TAG', 'QTY_HOLD')
           ${company}
      ), ev AS (
        SELECT e."orderId",
               min(e."createdAt") FILTER (WHERE e."toStatus" = 'APPROVED') AS approved,
               min(e."createdAt") FILTER (WHERE e."toStatus" IN ('ACCEPTED','PROCESSING')) AS submitted,
               min(e."createdAt") FILTER (WHERE e."toStatus" = 'SHIPPED') AS shipped,
               min(e."createdAt") FILTER (WHERE e."toStatus" IN ('DELIVERED','COD_PAID')) AS delivered
          FROM "OrderEvent" e
          JOIN o ON o.id = e."orderId"
         WHERE e."accountId" = ${ctx.accountId}
         GROUP BY e."orderId"
      ), f AS (
        SELECT DISTINCT ON (f."orderId") f."orderId", f."connectionId", f."submittedAt", f."shippedAt", f."deliveredAt"
          FROM "Fulfillment" f
          JOIN o ON o.id = f."orderId"
         WHERE f."accountId" = ${ctx.accountId}
           AND f."createdAt" >= ${range.start}
           AND f.status NOT IN ('CANCELLED','SUBMIT_FAILED')
         ORDER BY f."orderId", f."createdAt"
      ), t AS (
        SELECT f."connectionId", o.imported, ev.approved,
               COALESCE(f."submittedAt", ev.submitted) AS submitted,
               COALESCE(f."shippedAt", ev.shipped) AS shipped,
               COALESCE(f."deliveredAt", ev.delivered) AS delivered
          FROM o
          LEFT JOIN ev ON ev."orderId" = o.id
          LEFT JOIN f ON f."orderId" = o.id
          LEFT JOIN "FulfillmentConnection" c ON c.id = f."connectionId" AND c."accountId" = ${ctx.accountId}
          ${scoped}
      )
      SELECT t."connectionId", GROUPING(t."connectionId")::int AS g, count(*)::int AS orders,
             ${select}
        FROM t
       GROUP BY GROUPING SETS ((), (t."connectionId"))`,
  );
  const ids = rows.map((r) => r.connectionId).filter((x): x is string => typeof x === "string");
  const conns = ids.length
    ? await reportQuery<{ id: string; name: string; type: string }>(
        ctx.accountId,
        Prisma.sql`SELECT id, name, type::text AS type FROM "FulfillmentConnection"
                    WHERE "accountId" = ${ctx.accountId} AND id IN (${Prisma.join(ids)})`,
      )
    : [];
  const conn = new Map(conns.map((c) => [c.id, c]));
  const num = (v: unknown) => (v == null ? null : Number(v));
  const toRow = (r: Record<string, unknown>): TimingRow => {
    const id = (r.connectionId as string | null) ?? null;
    return {
      connectionId: id,
      name: id ? (conn.get(id)?.name ?? null) : null,
      type: id ? (conn.get(id)?.type ?? null) : null,
      orders: Number(r.orders),
      stages: Object.fromEntries(
        STAGES.map((s) => [
          s,
          { n: Number(r[`${s}_n`] ?? 0), median: num(r[`${s}_p50`]), p90: num(r[`${s}_p90`]) },
        ]),
      ) as Record<Stage, StageStat>,
    };
  };
  const overallRow = rows.find((r) => Number(r.g) === 1);
  return {
    overall: overallRow && Number(overallRow.orders) > 0 ? toRow(overallRow) : null,
    warehouses: rows
      .filter((r) => Number(r.g) === 0)
      .map(toRow)
      .sort((a, b) => Number(!a.connectionId) - Number(!b.connectionId) || b.orders - a.orders),
  };
}
export type TimingReport = Awaited<ReturnType<typeof timingReport>>;

const hours = (s: number | null) => (s == null ? "" : (s / 3600).toFixed(2));

export function timingCsv(r: TimingReport, labels: { all: string; noShipment: string }): string[][] {
  const out: string[][] = [
    ["warehouse", "orders", ...STAGES.flatMap((s) => [`${s}_n`, `${s}_median_h`, `${s}_p90_h`])],
  ];
  const line = (name: string, row: TimingRow) => [
    name,
    String(row.orders),
    ...STAGES.flatMap((s) => [
      String(row.stages[s].n),
      hours(row.stages[s].median),
      hours(row.stages[s].p90),
    ]),
  ];
  if (r.overall) out.push(line(labels.all, r.overall));
  for (const w of r.warehouses) out.push(line(w.name ?? labels.noShipment, w));
  return out;
}
