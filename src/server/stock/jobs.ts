import { runFastStockSync } from "./fast-sync";
import { runStockWaitEvaluation } from "./waiting";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { ShopifyError } from "@/integrations/shopify/errors";
import { logger } from "@/lib/logger";
import { systemDb } from "@/server/db/client";
import { QUEUES } from "@/server/jobs/queues";
import { sweepStockAlerts } from "./discrepancies";
import { pollFhbReceipts, sweepInboundAlerts } from "./inbound";
import { processInventoryActivation, sweepInventoryActivations } from "./activate";
import { processInventoryPush, sweepInventoryPushes } from "./push";
import { syncStoreInventory } from "./shopify-inventory";

/** Stock track workers (P5-01..P5-03). Every payload names its account (dead-letter view per account). */

const StoreJob = z.object({ accountId: z.string().min(1), storeId: z.string().min(1) });
const PushJob = z.object({ accountId: z.string().min(1), pushId: z.string().min(1) });
export type StockStoreJob = z.infer<typeof StoreJob>;
export type StockPushJob = z.infer<typeof PushJob>;
const ActivateJob = z.object({ accountId: z.string().min(1), activationId: z.string().min(1) });
export type StockActivateJob = z.infer<typeof ActivateJob>;

export const enqueueStock = {
  shopifyInventory: (boss: PgBoss, d: StockStoreJob) =>
    boss.send(QUEUES.stockShopifyInventory.name, StoreJob.parse(d), { singletonKey: d.storeId }),
  push: (boss: PgBoss, d: StockPushJob) =>
    boss.send(QUEUES.stockInventoryPush.name, PushJob.parse(d), { singletonKey: d.pushId }),
  activate: (boss: PgBoss, d: StockActivateJob) =>
    boss.send(QUEUES.stockInventoryActivate.name, ActivateJob.parse(d), { singletonKey: d.activationId }),
};

/** Missing scopes (read_inventory / read_locations) are a setup gap, not a job failure: logged, not retried. */
const isSetupGap = (err: unknown) =>
  err instanceof ShopifyError && (err.code === "auth_failed" || err.graphqlCodes.includes("ACCESS_DENIED"));

export async function registerStockWorkers(boss: PgBoss, opts: { pollingIntervalSeconds: number }) {
  await boss.work(QUEUES.stockDiscrepancies.name, opts, async () => {
    const r = await sweepStockAlerts();
    if (r.created || r.resolved) logger.info(r, "stock discrepancy alerts");
  });

  await boss.work(QUEUES.stockInboundSweep.name, opts, async () => {
    const conns = await systemDb().fulfillmentConnection.findMany({
      where: { type: "FHB_V3", enabled: true, credentialId: { not: null } },
      select: { id: true, accountId: true },
    });
    for (const c of conns) {
      try {
        await pollFhbReceipts(c.accountId, c.id);
      } catch (err) {
        logger.warn({ connectionId: c.id, err: (err as Error).message }, "fhb receipt poll failed");
      }
    }
    const r = await sweepInboundAlerts();
    if (r.created || r.resolved) logger.info(r, "inbound alerts");
  });

  await boss.work(QUEUES.stockShopifyInventoryTick.name, opts, async () => {
    const stores = await systemDb().store.findMany({
      where: { credentialId: { not: null }, archivedAt: null },
      select: { id: true, accountId: true, connectionStatus: true },
    });
    for (const s of stores)
      if ((s.connectionStatus as { ok?: boolean }).ok === true)
        await enqueueStock.shopifyInventory(boss, { accountId: s.accountId, storeId: s.id });
  });

  await boss.work<StockStoreJob>(QUEUES.stockShopifyInventory.name, opts, async (jobs) => {
    for (const job of jobs) {
      const d = StoreJob.parse(job.data);
      try {
        const r = await syncStoreInventory(d.accountId, d.storeId);
        logger.info({ storeId: d.storeId, ...r }, "shopify inventory read");
      } catch (err) {
        if (!isSetupGap(err)) throw err;
        logger.warn(
          { storeId: d.storeId, code: (err as ShopifyError).code },
          "shopify inventory: missing access",
        );
      }
    }
  });

  // Several stores' pushes at a time (one open push per store already keeps each store's sends in order): with
  // 30–40 stores and a fast push each minute, one-at-a-time would fall behind.
  await boss.work<StockPushJob>(
    QUEUES.stockInventoryPush.name,
    { ...opts, localConcurrency: 6 },
    async (jobs) => {
      for (const job of jobs) {
        const d = PushJob.parse(job.data);
        const status = await processInventoryPush(d.pushId);
        logger.info({ pushId: d.pushId, status }, "inventory push processed");
      }
    },
  );

  await boss.work<StockActivateJob>(QUEUES.stockInventoryActivate.name, opts, async (jobs) => {
    for (const job of jobs) {
      const d = ActivateJob.parse(job.data);
      const r = await processInventoryActivation(d.activationId);
      logger.info({ activationId: d.activationId, result: r }, "inventory activation processed");
      // LIVE success: read the store's Shopify inventory again so the next preview includes the new levels.
      if (r !== "skipped" && r.refreshInventory) {
        const a = await systemDb().inventoryActivation.findUniqueOrThrow({
          where: { id: d.activationId },
          select: { storeId: true },
        });
        await enqueueStock.shopifyInventory(boss, { accountId: d.accountId, storeId: a.storeId });
      }
    }
  });

  await boss.work(QUEUES.stockFastPush.name, opts, async () => {
    const queued = await runFastStockSync(new Date(), (p) => enqueueStock.push(boss, p));
    if (queued.length) logger.info({ pushes: queued.length }, "fast stock sync");
  });

  await boss.work(QUEUES.stockWaitEvaluate.name, opts, async () => {
    const r = await runStockWaitEvaluation(new Date());
    if (r.notified) logger.info(r, "missing-stock orders: notified");
  });

  await boss.work(QUEUES.stockInventoryPushSweep.name, opts, async () => {
    const act = await sweepInventoryActivations();
    for (const a of act.ready)
      await enqueueStock.activate(boss, { accountId: a.accountId, activationId: a.id });
    const r = await sweepInventoryPushes();
    for (const p of r.ready) await enqueueStock.push(boss, { accountId: p.accountId, pushId: p.id });
    if (r.created || r.ready.length || r.stale)
      logger.info({ ...r, ready: r.ready.length }, "inventory pushes");
  });
}
