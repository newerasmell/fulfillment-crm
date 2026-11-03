import { scopedRows } from "@/server/cod/board";
import { COD_BUCKETS, totalsBy, type CodBucket, type Totals } from "@/server/cod/classify";
import type { ReportRange } from "./range";
import { assertReport, type ReportCtx } from "./sql";

/**
 * Справка 4 — Наложен платеж: the COD board's own rows and arithmetic (src/server/cod: classifyCod, totalsBy —
 * nothing re-implemented) for shipments created in the period: expected vs received vs paid per currency and per
 * warehouse, ageing of what is delivered but not paid out yet, and the mismatch counts. Amounts are in the
 * destination country's local currency and are never added across currencies.
 */

export const AGE_BUCKETS = ["d0_7", "d8_14", "d15_30", "d30_plus"] as const;
type AgeBucket = (typeof AGE_BUCKETS)[number];

export interface AgeingRow {
  currency: string;
  buckets: Record<AgeBucket, { count: number; amount: number }>;
}

const cents = (n: number) => Math.round(n * 100);

export async function codReport(ctx: ReportCtx, range: ReportRange, now = new Date()) {
  assertReport(ctx, "cod.read");
  const { rows, truncated } = await scopedRows(
    {
      accountId: ctx.accountId,
      role: ctx.role as never,
      userId: "",
      companyScope: ctx.companyScope,
      activeCompanyId: ctx.activeCompanyId,
      lineCompanyIds: ctx.lineCompanyIds,
    },
    { connectionTypes: ctx.connectionTypes, created: { gte: range.start, lt: range.end } },
    now,
  );
  const sortT = (t: Iterable<Totals>) => [...t].sort((a, b) => a.currency.localeCompare(b.currency));
  const byCurrency = sortT(
    totalsBy(rows.map((r) => ({ key: "all", row: r.row })))
      .get("all")
      ?.values() ?? [],
  );
  const names = new Map(rows.map((r) => [r.shipment.connectionId, r.shipment.connection]));
  const byWarehouse = [...totalsBy(rows.map((r) => ({ key: r.shipment.connectionId, row: r.row })))]
    .map(([connectionId, m]) => ({
      connectionId,
      name: names.get(connectionId)?.name ?? "—",
      type: names.get(connectionId)?.type ?? "",
      totals: sortT(m.values()),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const ageing = new Map<string, AgeingRow>();
  for (const { row } of rows) {
    if (!row.expected || !row.delivered || row.vendor.state === "paid") continue;
    const b = row.bucket as CodBucket;
    if (!(AGE_BUCKETS as readonly string[]).includes(b)) continue;
    const a = ageing.get(row.expected.currency) ?? {
      currency: row.expected.currency,
      buckets: Object.fromEntries(
        AGE_BUCKETS.map((k) => [k, { count: 0, amount: 0 }]),
      ) as AgeingRow["buckets"],
    };
    ageing.set(a.currency, a);
    const cell = a.buckets[b as AgeBucket];
    cell.count++;
    cell.amount = (cents(cell.amount) + cents(row.expected.amount)) / 100;
  }
  const mismatches = { amount: 0, missing: 0, unexpected: 0 };
  for (const { row } of rows) if (row.mismatch) mismatches[row.mismatch]++;
  return {
    shipments: rows.length,
    /** The row cap of the COD board was hit: the figures are incomplete (shown on screen and in the CSV). */
    truncated,
    byCurrency,
    byWarehouse,
    ageing: [...ageing.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    mismatches,
    buckets: COD_BUCKETS,
  };
}
export type CodReport = Awaited<ReturnType<typeof codReport>>;

const m = (n: number) => n.toFixed(2);

export function codCsv(r: CodReport): string[][] {
  const out: string[][] = [
    ["section", "warehouse", "currency", "shipments", "expected", "received", "paid", "outstanding"],
  ];
  for (const t of r.byCurrency)
    out.push([
      "total",
      "",
      t.currency,
      String(t.count),
      m(t.expected),
      m(t.received),
      m(t.paid),
      m(t.outstanding),
    ]);
  for (const w of r.byWarehouse)
    for (const t of w.totals)
      out.push([
        "warehouse",
        w.name,
        t.currency,
        String(t.count),
        m(t.expected),
        m(t.received),
        m(t.paid),
        m(t.outstanding),
      ]);
  if (r.truncated) out.push(["truncated", "", "", String(r.shipments), "", "", "", ""]);
  out.push([]);
  out.push(["ageing", "currency", ...AGE_BUCKETS.flatMap((b) => [`${b}_count`, `${b}_amount`])]);
  for (const a of r.ageing)
    out.push([
      "ageing",
      a.currency,
      ...AGE_BUCKETS.flatMap((b) => [String(a.buckets[b].count), m(a.buckets[b].amount)]),
    ]);
  return out;
}
