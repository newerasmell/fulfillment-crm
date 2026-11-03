import { accountDb } from "@/server/db/client";
import { BOARD_MAX_PRODUCTS, matchesFilter, SALES_WINDOW_DAYS, stockBoard } from "@/server/stock/board";
import { ORDER_NOT_AT_WAREHOUSE } from "@/server/stock/levels";
import { assertReport, scopeWhere, type ReportCtx } from "./sql";

/**
 * Справка 6 — Наличности, a snapshot of now (no date range): the stock board's own rows and flags
 * (src/server/stock/board.ts — sellable, run-out estimate over the last SALES_WINDOW_DAYS of sales, settings'
 * runOutDays) for the sidebar product line:
 *   - running out: sellable > 0 and the estimate says it lasts at most runOutDays;
 *   - zero stock with open orders: no physical stock at any warehouse while orders that are not at a warehouse
 *     yet (ORDER_NOT_AT_WAREHOUSE, company scope) still ask for it.
 * Read only; the board's own limits apply (BOARD_MAX_PRODUCTS masters).
 */

export const STOCK_LIST_LIMIT = 200;

export async function stockReport(ctx: ReportCtx, now = new Date()) {
  assertReport(ctx);
  const board = await stockBoard(ctx, { filter: "all", pageSize: BOARD_MAX_PRODUCTS, now });
  const open = await accountDb(ctx.accountId).orderLine.groupBy({
    by: ["productId"],
    where: {
      productId: { in: board.rows.filter((r) => r.flags.zero).map((r) => r.id) },
      order: { ...scopeWhere(ctx), status: { in: [...ORDER_NOT_AT_WAREHOUSE] } },
    },
    _sum: { quantity: true },
    _count: { orderId: true },
  });
  const openOf = new Map(
    open.map((o) => [o.productId!, { units: o._sum.quantity ?? 0, lines: o._count.orderId }]),
  );
  const view = (r: (typeof board.rows)[number]) => ({
    id: r.id,
    sku: r.sku,
    name: r.name,
    isTester: r.isTester,
    sellable: r.totalSellable,
    physical: r.totalPhysical,
    sold: r.sold,
    daysLeft: r.daysLeft,
    stale: r.flags.stale,
    open: openOf.get(r.id) ?? null,
  });
  const runningOut = board.rows
    .filter((r) => matchesFilter(r, "runningOut"))
    .sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) || a.sku.localeCompare(b.sku))
    .map(view);
  const zeroOpen = board.rows
    .filter((r) => r.flags.zero && (openOf.get(r.id)?.units ?? 0) > 0)
    .map(view)
    .sort((a, b) => (b.open?.units ?? 0) - (a.open?.units ?? 0) || a.sku.localeCompare(b.sku));
  return {
    runOutDays: board.settings.runOutDays,
    salesWindowDays: SALES_WINDOW_DAYS,
    warehouses: board.connections.length,
    truncated: board.truncated,
    runningOutTotal: runningOut.length,
    zeroOpenTotal: zeroOpen.length,
    runningOut: runningOut.slice(0, STOCK_LIST_LIMIT),
    zeroOpen: zeroOpen.slice(0, STOCK_LIST_LIMIT),
  };
}
export type StockReport = Awaited<ReturnType<typeof stockReport>>;

export function stockCsv(r: StockReport): string[][] {
  const out: string[][] = [
    ["section", "sku", "name", "sellable", "physical", "sold_30d", "days_left", "open_units", "open_lines"],
  ];
  for (const [section, rows] of [
    ["running_out", r.runningOut],
    ["zero_with_open_orders", r.zeroOpen],
  ] as const)
    for (const p of rows)
      out.push([
        section,
        p.sku,
        p.name,
        String(p.sellable),
        String(p.physical),
        String(p.sold),
        p.daysLeft == null ? "" : p.daysLeft.toFixed(1),
        String(p.open?.units ?? 0),
        String(p.open?.lines ?? 0),
      ]);
  return out;
}
