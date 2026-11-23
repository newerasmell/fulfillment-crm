import { companyFilter } from "@/server/companies";
import { accountDb } from "@/server/db/client";
import { STOCK_CONNECTION_TYPES } from "@/server/routing/engine";
import { boardProductWhere, type StockCtx } from "./board";
import { crmReservations, isStale, reservationKey, sellableOf } from "./levels";
import { getStockSettings, staleHoursFor } from "./settings";

/**
 * „Общо в складовете“ (owner request 2026-11-23): how many units each warehouse holds in total, per company, at a
 * glance (e.g. Company A · euShipments: N бр.). Sums the warehouses' own last numbers over every product of the
 * member's companies and the sidebar's product line (the board's products; the first link per product and warehouse):
 *  - units: on the shelves (FHB physical; euShipments has one number, already without its accepted orders);
 *  - free: as on the board — the warehouse's number minus what the CRM holds (orders not sent yet, units a
 *    warehouse could not give);
 *  - products: how many products have at least one unit there.
 * Reads only.
 */
export async function warehouseTotals(ctx: StockCtx, now: Date = new Date()) {
  const db = accountDb(ctx.accountId);
  const [connections, settings] = await Promise.all([
    db.fulfillmentConnection.findMany({
      where: { type: { in: [...STOCK_CONNECTION_TYPES] }, ...companyFilter(ctx) },
      select: { id: true, name: true, type: true, company: { select: { id: true, name: true } } },
      orderBy: [{ name: "asc" }],
    }),
    getStockSettings(ctx.accountId),
  ]);
  if (!connections.length) return { companies: [], units: 0, free: 0 };
  const connectionIds = connections.map((c) => c.id);
  // The board's products: not archived, the sidebar's product line.
  const product = { archived: false, ...boardProductWhere(ctx) };
  // Flat reads joined in memory (a nested relation over the whole catalogue passes PostgreSQL's bind-parameter limit,
  // see discrepancies.ts); free as on the board: the warehouse number minus what the CRM holds (orders, holds).
  const [vpRows, levelRows, reservations] = await Promise.all([
    db.vendorProduct.findMany({
      where: { connectionId: { in: connectionIds }, archived: false, productId: { not: null }, product },
      select: { id: true, connectionId: true, productId: true },
      orderBy: { id: "asc" },
    }),
    db.stockLevel.findMany({
      where: { vendorProduct: { connectionId: { in: connectionIds }, archived: false, product } },
      select: { vendorProductId: true, physical: true, free: true, snapshotAt: true },
    }),
    crmReservations(ctx.accountId),
  ]);
  const levelOf = new Map(levelRows.map((l) => [l.vendorProductId, l]));
  const seen = new Set<string>();
  const byConn = new Map(
    connections.map((c) => [c.id, { units: 0, free: 0, products: 0, oldest: null as Date | null }]),
  );
  for (const v of vpRows) {
    const key = reservationKey(v.connectionId, v.productId!);
    // The first non-archived link per product and warehouse, as the board shows it (no number yet = 0).
    if (seen.has(key)) continue;
    seen.add(key);
    const level = levelOf.get(v.id);
    if (!level) continue;
    const t = byConn.get(v.connectionId)!;
    const units = Math.max(0, level.physical);
    t.units += units;
    t.free += sellableOf(level, reservations.get(key) ?? 0);
    if (units > 0) t.products++;
    if (!t.oldest || level.snapshotAt < t.oldest) t.oldest = level.snapshotAt;
  }
  const companies = new Map<
    string,
    {
      id: string;
      name: string;
      units: number;
      free: number;
      warehouses: {
        id: string;
        name: string;
        type: string;
        units: number;
        free: number;
        products: number;
        snapshotAt: Date | null;
        stale: boolean;
      }[];
    }
  >();
  for (const c of connections) {
    const t = byConn.get(c.id)!;
    const co = c.company ?? { id: "", name: "—" };
    const entry = companies.get(co.id) ?? { id: co.id, name: co.name, units: 0, free: 0, warehouses: [] };
    entry.units += t.units;
    entry.free += t.free;
    entry.warehouses.push({
      id: c.id,
      name: c.name,
      type: c.type,
      units: t.units,
      free: t.free,
      products: t.products,
      snapshotAt: t.oldest,
      // The oldest number of the warehouse decides: one fresh product does not hide many stale ones.
      stale: !!t.oldest && isStale(t.oldest, staleHoursFor(settings, c.type), now),
    });
    companies.set(co.id, entry);
  }
  const list = [...companies.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    companies: list,
    units: list.reduce((s, c) => s + c.units, 0),
    free: list.reduce((s, c) => s + c.free, 0),
  };
}

export type WarehouseTotals = Awaited<ReturnType<typeof warehouseTotals>>;
