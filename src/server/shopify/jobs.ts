import type { PgBoss } from "pg-boss";
import { logger } from "@/lib/logger";
import { QUEUES } from "@/server/jobs/queues";
import { accountDb, systemDb } from "@/server/db/client";
import { testStoreConnection } from "./connection";
import { syncStoreOrders } from "./orders";
import { syncStoreProducts } from "./products";
import { shopifyClientForStore } from "./store-client";
import { processShopifyWebhook, registerStoreWebhooks, staleWebhookEvents } from "./webhooks";

/** Every payload names its account, so failures show up in that account's dead-letter view only. */
export interface StoreJob {
  accountId: string;
  storeId: string;
}
export interface SyncOrdersJob extends StoreJob {
  mode: "reconcile" | "backfill";
  days?: number;
}
export interface WebhookJob {
  accountId: string;
  eventId: string;
}

export const enqueueShopify = {
  testConnection: (boss: PgBoss, d: StoreJob) =>
    boss.send(QUEUES.shopifyTestConnection.name, d, { singletonKey: d.storeId }),
  registerWebhooks: (boss: PgBoss, d: StoreJob) =>
    boss.send(QUEUES.shopifyRegisterWebhooks.name, d, { singletonKey: d.storeId }),
  syncOrders: (boss: PgBoss, d: SyncOrdersJob) =>
    boss.send(QUEUES.shopifySyncOrders.name, d, { singletonKey: `${d.storeId}:${d.mode}` }),
  syncProducts: (boss: PgBoss, d: StoreJob) =>
    boss.send(QUEUES.shopifySyncProducts.name, d, { singletonKey: d.storeId }),
  webhook: (boss: PgBoss, d: WebhookJob) =>
    boss.send(QUEUES.shopifyWebhook.name, d, { singletonKey: d.eventId }),
};

/** A store is usable by the jobs only while it is connected; a failed test stops the automation. */
async function connectedStore(accountId: string, storeId: string) {
  const store = await accountDb(accountId).store.findUnique({
    where: { id: storeId },
    select: { connectionStatus: true },
  });
  return !!store && (store.connectionStatus as { ok?: boolean }).ok === true;
}

export async function registerShopifyWorkers(boss: PgBoss, opts: { pollingIntervalSeconds: number }) {
  await boss.work<StoreJob>(QUEUES.shopifyTestConnection.name, opts, async (jobs) => {
    for (const { data } of jobs) {
      const status = await testStoreConnection(data.accountId, data.storeId);
      // A fresh good connection starts the first imports and subscribes the webhooks.
      if (status.ok) {
        await enqueueShopify.registerWebhooks(boss, data);
        await enqueueShopify.syncProducts(boss, data);
        await enqueueShopify.syncOrders(boss, { ...data, mode: "reconcile" });
      }
    }
  });

  await boss.work<StoreJob>(QUEUES.shopifyRegisterWebhooks.name, opts, async (jobs) => {
    for (const { data } of jobs) {
      if (!(await connectedStore(data.accountId, data.storeId))) continue;
      const status = await registerStoreWebhooks(data.accountId, data.storeId);
      logger.info(
        { storeId: data.storeId, ok: status.ok, topics: status.topics.length },
        "shopify webhooks registered",
      );
    }
  });

  await boss.work<SyncOrdersJob>(QUEUES.shopifySyncOrders.name, opts, async (jobs) => {
    for (const { data } of jobs) {
      if (!(await connectedStore(data.accountId, data.storeId))) continue;
      const { store, client } = await shopifyClientForStore(data.accountId, data.storeId);
      const mode =
        data.mode === "backfill"
          ? { kind: "backfill" as const, days: Math.min(Math.max(data.days ?? 30, 1), 365) }
          : { kind: "reconcile" as const };
      await syncStoreOrders(data.accountId, store, client, mode);
    }
  });

  await boss.work<StoreJob>(QUEUES.shopifySyncProducts.name, opts, async (jobs) => {
    for (const { data } of jobs) {
      if (!(await connectedStore(data.accountId, data.storeId))) continue;
      const { store, client } = await shopifyClientForStore(data.accountId, data.storeId);
      await syncStoreProducts(data.accountId, store, client);
    }
  });

  await boss.work<WebhookJob>(QUEUES.shopifyWebhook.name, opts, async (jobs) => {
    for (const { data } of jobs) await processShopifyWebhook(data.accountId, data.eventId);
  });

  await boss.work(QUEUES.shopifyReconcile.name, opts, async () => {
    const stores = await systemDb().store.findMany({
      where: { credentialId: { not: null } },
      select: { id: true, accountId: true, connectionStatus: true },
    });
    let queued = 0;
    for (const s of stores) {
      if ((s.connectionStatus as { ok?: boolean }).ok !== true) continue;
      await enqueueShopify.syncOrders(boss, { accountId: s.accountId, storeId: s.id, mode: "reconcile" });
      queued++;
    }
    for (const e of await staleWebhookEvents()) {
      if (e.accountId) await enqueueShopify.webhook(boss, { accountId: e.accountId, eventId: e.id });
    }
    if (queued) logger.info({ stores: queued }, "shopify reconcile queued");
  });
}
