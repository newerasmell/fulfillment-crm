import { assertCan } from "@/server/auth/rbac";
import { accountDb } from "@/server/db/client";
import { STOCK_CONNECTION_TYPES } from "@/server/routing/engine";
import { companyWhere } from "@/server/companies";
import { isStale } from "@/server/stock/levels";
import { heldUnits, holdKey, skuHolds } from "@/server/warehouse-cases/sku";
import { getStockSettings, staleHoursFor } from "@/server/stock/settings";
import type { ScopedActor } from "@/server/stores";

/**
 * Quick stock check in „Нова ръчна пратка“ (owner request 2026-11-23): for each chosen product, the units in every
 * warehouse separately and in total — the warehouses of the companies the member sees (as on the stock board).
 *  - physical: what the warehouse reports on its shelves (FHB physical; euShipments has one number, already without
 *    its accepted orders);
 *  - sellable: the same number „Провери“ checks against (the routing stock check: stored sellable minus units a
 *    warehouse could not give), so the two never disagree on one screen.
 * Reads only.
 */
export async function stockPerWarehouse(actor: ScopedActor, productIds: string[]) {
  assertCan(actor.role, "orders.fulfill");
  const ids = [...new Set(productIds)].filter(Boolean).slice(0, 100);
  if (!ids.length) return [];
  const db = accountDb(actor.accountId);
  const [connections, vps, holds, settings] = await Promise.all([
    db.fulfillmentConnection.findMany({
      where: {
        enabled: true,
        type: { in: [...STOCK_CONNECTION_TYPES] },
        ...companyWhere(actor.companyScope),
      },
      select: { id: true, name: true, type: true },
      orderBy: { name: "asc" },
    }),
    db.vendorProduct.findMany({
      where: { productId: { in: ids }, archived: false },
      select: {
        connectionId: true,
        productId: true,
        stockLevel: { select: { physical: true, sellable: true, snapshotAt: true } },
      },
      orderBy: { id: "asc" },
    }),
    skuHolds(actor.accountId, ids),
    getStockSettings(actor.accountId),
  ]);
  const now = new Date();
  return ids.map((productId) => {
    const warehouses = connections.map((c) => {
      // The first non-archived link per warehouse, as routing and the stock board read it.
      const level = vps.find((v) => v.productId === productId && v.connectionId === c.id)?.stockLevel ?? null;
      if (!level) return { connectionId: c.id, name: c.name, type: c.type, carried: false as const };
      return {
        connectionId: c.id,
        name: c.name,
        type: c.type,
        carried: true as const,
        physical: Math.max(0, level.physical),
        sellable: Math.max(
          0,
          level.sellable -
            (holds.has(holdKey(c.id, productId)) ? heldUnits(holds.get(holdKey(c.id, productId))!) : 0),
        ),
        snapshotAt: level.snapshotAt.toISOString(),
        stale: isStale(level.snapshotAt, staleHoursFor(settings, c.type), now),
      };
    });
    const carried = warehouses.filter((w) => w.carried);
    return {
      productId,
      warehouses: carried,
      totalPhysical: carried.reduce((s, w) => s + (w.carried ? w.physical : 0), 0),
      totalSellable: carried.reduce((s, w) => s + (w.carried ? w.sellable : 0), 0),
    };
  });
}

export type ProductStock = Awaited<ReturnType<typeof stockPerWarehouse>>[number];
