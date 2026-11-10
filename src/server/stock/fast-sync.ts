import { logger } from "@/lib/logger";
import { accountDb, systemDb } from "@/server/db/client";
import { crmReservations } from "./levels";
import { createInventoryPush } from "./push";

/** How far back each run looks beyond its previous run (late commits, a slow run): changes are never missed. */
export const FAST_SYNC_OVERLAP_MS = 3 * 60_000;
/** First run of an account, or after a long pause: how far back to look (the 10-minute full push covers older). */
export const FAST_SYNC_MAX_LOOKBACK_MS = 15 * 60_000;
/** Products handled per account and run; more are left to the 10-minute full push (logged). */
export const FAST_SYNC_PRODUCTS = 3000;

type Enqueue = (p: { accountId: string; pushId: string }) => Promise<unknown>;

/**
 * Fast stock sync (owner request 2026-11-10: one unit ordered in store A must disappear from every store of the
 * line at once, not after the 10-minute push). Every minute, per account: the products of every order that changed
 * since the previous run (new order, status change, approval, cancel, Shopify update — any change bumps
 * Order.updatedAt), with an overlap so a transaction that committed late is never missed, are planned for every
 * store that sells them, and one InventoryPush per store is queued right away (trigger "fast", only those products,
 * CRM reservations computed once for them). Nothing is written on the order paths themselves (no locks, no extra
 * work per status change). The push is the existing one: the store's mode at send time, compare-and-set, idempotent
 * batches, read-back; a fast push takes the numbers of the moment it is sent. A store that already has a push open
 * is planned again next minute (the overlap brings the products back). The 10-minute full push stays the safety
 * net (e.g. a line removed from an order, a relinked product, a new warehouse snapshot).
 */
export async function runFastStockSync(now: Date = new Date(), enqueue?: Enqueue) {
  const accounts = await systemDb().store.findMany({
    where: {
      archivedAt: null,
      inventoryPushMode: { not: "DISABLED" },
      locations: { some: { connectionId: { not: null }, isActive: true } },
    },
    select: { accountId: true },
    distinct: ["accountId"],
  });
  const queued: { accountId: string; pushId: string }[] = [];
  for (const { accountId } of accounts) {
    try {
      queued.push(...(await fastSyncAccount(accountId, now, enqueue)));
    } catch (err) {
      logger.warn({ accountId, err: (err as Error).message }, "fast stock sync failed for an account");
    }
  }
  return queued;
}

async function fastSyncAccount(accountId: string, now: Date, enqueue?: Enqueue) {
  const db = accountDb(accountId);
  const cursor = await db.stockSyncCursor.findUnique({ where: { accountId }, select: { lastRunAt: true } });
  const floor = now.getTime() - FAST_SYNC_MAX_LOOKBACK_MS;
  const since = new Date(Math.max(floor, (cursor?.lastRunAt.getTime() ?? floor) - FAST_SYNC_OVERLAP_MS));
  const changed = await db.orderLine.findMany({
    where: { productId: { not: null }, order: { updatedAt: { gte: since } } },
    select: { productId: true },
    distinct: ["productId"],
    take: FAST_SYNC_PRODUCTS + 1,
  });
  if (changed.length > FAST_SYNC_PRODUCTS)
    logger.warn({ accountId, since }, "fast stock sync: more changed products than one run takes");
  const productIds = changed.slice(0, FAST_SYNC_PRODUCTS).map((c) => c.productId!);
  // Stores where an order changed: Shopify moved its own numbers there (sold, or given back by a cancel with
  // "Restock"), so every line of those products is sent and the sender's read decides what differs.
  const orderStores = new Set(
    (
      await db.order.findMany({
        // Since the previous run only (no overlap): an order is a reason to re-read its store once, not every run.
        where: { updatedAt: { gte: cursor?.lastRunAt ?? since }, storeId: { not: null } },
        select: { storeId: true },
        distinct: ["storeId"],
      })
    ).map((o) => o.storeId!),
  );
  const queued: { accountId: string; pushId: string }[] = [];
  let blocked = false;
  if (productIds.length) {
    const links = await db.storeVariantLink.findMany({
      where: {
        productId: { in: productIds },
        store: {
          archivedAt: null,
          inventoryPushMode: { not: "DISABLED" },
          locations: { some: { connectionId: { not: null }, isActive: true } },
        },
      },
      select: { storeId: true, productId: true },
    });
    const byStore = new Map<string, Set<string>>();
    for (const l of links) byStore.set(l.storeId, (byStore.get(l.storeId) ?? new Set()).add(l.productId!));
    const reservations = await crmReservations(accountId, productIds);
    for (const [storeId, ids] of byStore) {
      try {
        const r = await createInventoryPush(storeId, { kind: "system" }, now, {
          productIds: [...ids],
          reservations,
          allLines: orderStores.has(storeId),
        });
        if (r.created && r.pushId) {
          const p = { accountId, pushId: r.pushId };
          queued.push(p);
          // Sent right away (not after every store is planned): its numbers are seconds old.
          if (enqueue) await enqueue(p);
        } else if (r.reason === "push_open") {
          // This store's earlier push is still on its way: these products must come back next run, so the cursor
          // stays where it is (up to the look-back limit). A push waiting only for its retry time is sent now
          // instead of at the next 10-minute sweep (it takes the numbers of the moment it is sent).
          blocked = true;
          const due = "openDueAt" in r && (!r.openDueAt || r.openDueAt <= now);
          if (r.pushId && "openStatus" in r && r.openStatus === "PENDING" && due && enqueue)
            await enqueue({ accountId, pushId: r.pushId });
        }
      } catch (err) {
        blocked = true;
        logger.warn({ storeId, err: (err as Error).message }, "fast stock sync: store skipped");
      }
    }
  }
  // Only a run that reached every store moves the cursor; otherwise the same window is looked at again next run
  // (never further back than the look-back limit, beyond which the 10-minute full push covers).
  if (blocked && cursor) return queued;
  await db.stockSyncCursor.upsert({
    where: { accountId },
    create: { accountId, lastRunAt: now },
    update: { lastRunAt: now },
  });
  return queued;
}
