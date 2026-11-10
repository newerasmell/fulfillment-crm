import { Prisma } from "@/generated/prisma/client";
import { accountDb } from "@/server/db/client";
import { daysOf, type ReportRange } from "./range";
import { assertReport, companySql, reportQuery, scopeWhere, toCents, type ReportCtx } from "./sql";

/**
 * Справка 1 — Поръчки по ден / магазин / фирма: orders placed in the period (Sofia days), count and total per
 * currency (different currencies are never added together), COD vs prepaid share. Cancelled orders are counted
 * separately and left out of the totals. Two grouped queries; nothing is loaded per order.
 */

export interface MoneyTotal {
  currency: string;
  count: number;
  cod: number;
  /** Sum of order totals in cents (this currency only). */
  totalCents: number;
  /** Sum of the order totals of the COD orders (order currency) — not the COD amount; see CodAmount. */
  codCents: number;
}

/**
 * COD to collect, in the currency the courier collects it in: the destination country's local currency
 * (Order.codLocalAmount / codLocalCurrency, falling back to codAmount in the order currency) — the same
 * "expected" amount the COD board and the COD report use (classifyCod). Never mixed with order-currency totals.
 */
export interface CodAmount {
  currency: string;
  count: number;
  amountCents: number;
}

export interface DayRow {
  day: string;
  orders: number;
  cod: number;
  prepaid: number;
  cancelled: number;
}

export interface GroupRow {
  id: string | null;
  name: string;
  orders: number;
  cod: number;
  totals: MoneyTotal[];
}

const addTo = (m: Map<string, MoneyTotal>, currency: string, n: number, cod: boolean, cents: number) => {
  const t = m.get(currency) ?? { currency, count: 0, cod: 0, totalCents: 0, codCents: 0 };
  m.set(currency, t);
  t.count += n;
  t.totalCents += cents;
  if (cod) {
    t.cod += n;
    t.codCents += cents;
  }
};

export async function ordersReport(ctx: ReportCtx, range: ReportRange) {
  assertReport(ctx);
  const company = companySql(ctx, Prisma.sql`o."companyId"`);
  const days = daysOf(range);
  const empty = {
    days: days.map((day) => ({ day, orders: 0, cod: 0, prepaid: 0, cancelled: 0 })),
    totals: [] as MoneyTotal[],
    codAmounts: [] as CodAmount[],
    byStore: [] as GroupRow[],
    byCompany: [] as GroupRow[],
    orders: 0,
    cod: 0,
    cancelled: 0,
  };
  if (company === false) return empty;
  const [perDay, groups, codRows] = await Promise.all([
    reportQuery<{ day: string; currency: string; pm: string; cancelled: boolean; n: number; total: string }>(
      ctx.accountId,
      Prisma.sql`
        SELECT to_char((o."placedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Sofia', 'YYYY-MM-DD') AS day,
               o.currency, o."paymentMethod"::text AS pm, (o.status = 'CANCELLED') AS cancelled,
               count(*)::int AS n, coalesce(sum(o.total), 0)::text AS total
          FROM "Order" o
         WHERE o."accountId" = ${ctx.accountId}
           AND o."placedAt" >= ${range.start} AND o."placedAt" < ${range.end}
           AND o.status NOT IN ('AWAITING_TAG', 'QTY_HOLD')
           ${company}
         GROUP BY 1, 2, 3, 4`,
    ),
    accountDb(ctx.accountId).order.groupBy({
      by: ["storeId", "companyId", "currency", "paymentMethod"],
      where: {
        ...scopeWhere(ctx),
        placedAt: { gte: range.start, lt: range.end },
        // Orders still waiting for their store's tag are not counted (not confirmed yet).
        status: { notIn: ["CANCELLED", "AWAITING_TAG", "QTY_HOLD"] },
      },
      _count: { _all: true },
      _sum: { total: true },
    }),
    reportQuery<{ currency: string; n: number; amount: string }>(
      ctx.accountId,
      Prisma.sql`
        SELECT CASE WHEN o."codLocalAmount" IS NOT NULL THEN coalesce(o."codLocalCurrency", o.currency)
                    ELSE o.currency END AS currency,
               count(*)::int AS n,
               coalesce(sum(coalesce(o."codLocalAmount", o."codAmount")), 0)::text AS amount
          FROM "Order" o
         WHERE o."accountId" = ${ctx.accountId}
           AND o."placedAt" >= ${range.start} AND o."placedAt" < ${range.end}
           AND o.status NOT IN ('CANCELLED', 'AWAITING_TAG', 'QTY_HOLD') AND o."paymentMethod" = 'COD'
           AND coalesce(o."codLocalAmount", o."codAmount") IS NOT NULL
           ${company}
         GROUP BY 1`,
    ),
  ]);
  const codAmounts: CodAmount[] = codRows
    .map((r) => ({ currency: r.currency, count: r.n, amountCents: toCents(r.amount) }))
    .sort((a, b) => b.count - a.count || a.currency.localeCompare(b.currency));
  const byDay = new Map(empty.days.map((d) => [d.day, { ...d }]));
  const totals = new Map<string, MoneyTotal>();
  let orders = 0;
  let cod = 0;
  let cancelled = 0;
  for (const r of perDay) {
    const d = byDay.get(r.day);
    if (r.cancelled) {
      cancelled += r.n;
      if (d) d.cancelled += r.n;
      continue;
    }
    orders += r.n;
    if (r.pm === "COD") cod += r.n;
    if (d) {
      d.orders += r.n;
      if (r.pm === "COD") d.cod += r.n;
      else d.prepaid += r.n;
    }
    addTo(totals, r.currency, r.n, r.pm === "COD", toCents(r.total));
  }

  const ids = (k: "storeId" | "companyId") => [
    ...new Set(groups.map((g) => g[k]).filter((x): x is string => !!x)),
  ];
  const db = accountDb(ctx.accountId);
  const [stores, companies] = await Promise.all([
    db.store.findMany({ where: { id: { in: ids("storeId") } }, select: { id: true, name: true } }),
    db.company.findMany({ where: { id: { in: ids("companyId") } }, select: { id: true, name: true } }),
  ]);
  const group = (k: "storeId" | "companyId", names: Map<string, string>) => {
    const out = new Map<string | null, { orders: number; cod: number; m: Map<string, MoneyTotal> }>();
    for (const g of groups) {
      const key = g[k];
      const row = out.get(key) ?? { orders: 0, cod: 0, m: new Map() };
      out.set(key, row);
      const n = g._count._all;
      const isCod = g.paymentMethod === "COD";
      row.orders += n;
      if (isCod) row.cod += n;
      addTo(row.m, g.currency, n, isCod, toCents(g._sum.total?.toString()));
    }
    return [...out]
      .map(([id, r]) => ({
        id,
        name: id ? (names.get(id) ?? "—") : "",
        orders: r.orders,
        cod: r.cod,
        totals: sortTotals([...r.m.values()]),
      }))
      .sort((a, b) => b.orders - a.orders || a.name.localeCompare(b.name));
  };
  return {
    days: [...byDay.values()],
    totals: sortTotals([...totals.values()]),
    codAmounts,
    byStore: group("storeId", new Map(stores.map((s) => [s.id, s.name]))),
    byCompany: group("companyId", new Map(companies.map((c) => [c.id, c.name]))),
    orders,
    cod,
    cancelled,
  };
}
export type OrdersReport = Awaited<ReturnType<typeof ordersReport>>;

const sortTotals = (t: MoneyTotal[]) =>
  t.sort((a, b) => b.count - a.count || a.currency.localeCompare(b.currency));

const money = (cents: number) => (cents / 100).toFixed(2);
const pct = (n: number, of: number) => (of ? ((n / of) * 100).toFixed(1) : "");

/** CSV: one line per day, then one per store/company and currency. */
export function ordersCsv(r: OrdersReport, labels: { manual: string; noCompany: string }): string[][] {
  const out: string[][] = [
    ["section", "key", "currency", "orders", "cod_orders", "cod_share_pct", "cancelled", "total"],
  ];
  for (const d of r.days)
    out.push([
      "day",
      d.day,
      "",
      String(d.orders),
      String(d.cod),
      pct(d.cod, d.orders),
      String(d.cancelled),
      "",
    ]);
  for (const t of r.totals)
    out.push([
      "total",
      "",
      t.currency,
      String(t.count),
      String(t.cod),
      pct(t.cod, t.count),
      "",
      money(t.totalCents),
    ]);
  for (const c of r.codAmounts)
    out.push(["cod_amount", "", c.currency, "", String(c.count), "", "", money(c.amountCents)]);
  for (const [section, rows, none] of [
    ["store", r.byStore, labels.manual],
    ["company", r.byCompany, labels.noCompany],
  ] as const)
    for (const g of rows)
      for (const t of g.totals)
        out.push([
          section,
          g.id ? g.name : none,
          t.currency,
          String(t.count),
          String(t.cod),
          pct(t.cod, t.count),
          "",
          money(t.totalCents),
        ]);
  return out;
}
