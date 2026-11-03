import type { PgBoss } from "pg-boss";
import type { ShopifyClientOptions } from "@/integrations/shopify/client";
import { logger } from "@/lib/logger";
import { QUEUES } from "@/server/jobs/queues";
import { accountDb, systemDb } from "@/server/db/client";
import { purgeStore } from "@/server/store-lifecycle";
import { testStoreConnection } from "./connection";
import { syncStoreOrders } from "./orders";
import { syncStoreProducts } from "./products";
import { shopifyClientForStore } from "./store-client";
import {
  processShopifyWebhook,
  registerStoreWebhooks,
  removeStoreWebhooks,
  staleWebhookEvents,
  validCallbackUrl,
  webhookCallbackUrl,
} from "./webhooks";

/** Every payload names its account, so failures show up in that account's dead-letter view only. */
export interface StoreJob {
  accountId: string;
  storeId: string;
  /**
   * Public webhook URL, set by the web service (only it knows its public host). Carried along from the connection
   * test to the webhook registration.
   */
  callbackUrl?: string | null;
}
export interface SyncOrdersJob extends StoreJob {
  mode: "reconcile" | "backfill";
  /** Backfill window (created_at), ISO. */
  from?: string;
  to?: string;
}
export interface RemoveWebhooksJob extends StoreJob {
  /** Delete the store once the removal succeeded (Изтрий магазина); the user who asked, for the audit log. */
  deleteAfter?: boolean;
  userId?: string | null;
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
  removeWebhooks: (boss: PgBoss, d: RemoveWebhooksJob) =>
    boss.send(QUEUES.shopifyRemoveWebhooks.name, d, { singletonKey: d.storeId }),
  syncOrders: (boss: PgBoss, d: SyncOrdersJob) =>
    boss.send(QUEUES.shopifySyncOrders.name, d, {
      singletonKey: d.mode === "backfill" ? `${d.storeId}:backfill:${d.from}` : `${d.storeId}:reconcile`,
    }),
  syncProducts: (boss: PgBoss, d: StoreJob) =>
    boss.send(QUEUES.shopifySyncProducts.name, d, { singletonKey: d.storeId }),
  webhook: (boss: PgBoss, d: WebhookJob) =>
    boss.send(QUEUES.shopifyWebhook.name, d, { singletonKey: d.eventId }),
};

/**
 * A store is usable by the jobs only while it is connected and not archived; a failed test stops the automation,
 * an archived store runs no job at all (except the webhook removal).
 */
export async function connectedStore(accountId: string, storeId: string) {
  const store = await accountDb(accountId).store.findUnique({
    where: { id: storeId },
    select: { connectionStatus: true, archivedAt: true },
  });
  return !!store && !store.archivedAt && (store.connectionStatus as { ok?: boolean }).ok === true;
}

async function isArchived(accountId: string, storeId: string) {
  const s = await accountDb(accountId).store.findUnique({
    where: { id: storeId },
    select: { archivedAt: true },
  });
  return !s || !!s.archivedAt;
}

/**
 * Removal job: only for an archived store (a restore in between wins). Without a usable connection nothing can
 * be removed — a store being deleted is then deleted anyway (Shopify drops subscriptions that keep failing). A shop
 * that another live store (another group) still uses keeps its subscriptions: they are shared.
 */
export async function runRemoveWebhooks(data: RemoveWebhooksJob, opts: ShopifyClientOptions = {}) {
  const db = accountDb(data.accountId);
  const store = await db.store.findUnique({
    where: { id: data.storeId },
    select: { archivedAt: true, domain: true, connectionStatus: true, webhookStatus: true },
  });
  if (!store || !store.archivedAt) return "skipped" as const;
  const finish = async () => {
    if (data.deleteAfter) await purgeStore(data.accountId, data.storeId, { userId: data.userId ?? null });
    return data.deleteAfter ? ("deleted" as const) : ("removed" as const);
  };
  const shared = await systemDb().store.count({
    where: { domain: store.domain, id: { not: data.storeId }, archivedAt: null },
  });
  const connected = (store.connectionStatus as { ok?: boolean }).ok === true;
  if (shared > 0 || !connected) {
    const prev = store.webhookStatus as { deleteRequested?: boolean };
    await db.store.update({
      where: { id: data.storeId },
      data: {
        webhookStatus: {
          ok: true,
          at: new Date().toISOString(),
          topics: [],
          removed: true,
          ...(prev.deleteRequested ? { deleteRequested: true } : {}),
          ...(shared > 0 ? { note: "shared_shop" } : { note: "not_connected" }),
        },
      },
    });
    return finish();
  }
  const uri = validCallbackUrl(data.callbackUrl) ?? webhookCallbackUrl();
  if (!uri) {
    const prev = store.webhookStatus as Record<string, unknown>;
    await db.store.update({
      where: { id: data.storeId },
      data: {
        webhookStatus: { ...prev, ok: false, at: new Date().toISOString(), errors: ["no_callback_url"] },
      },
    });
    return "failed" as const;
  }
  let status;
  try {
    status = await removeStoreWebhooks(data.accountId, data.storeId, uri, opts);
  } catch (err) {
    const code = (err as { code?: string }).code ?? "unexpected";
    const prev = store.webhookStatus as Record<string, unknown>;
    await db.store.update({
      where: { id: data.storeId },
      data: { webhookStatus: { ...prev, ok: false, at: new Date().toISOString(), errors: [code] } },
    });
    throw err;
  }
  logger.info({ storeId: data.storeId, ok: status.ok }, "shopify webhooks removed");
  return status.ok ? finish() : ("failed" as const);
}

export async function registerShopifyWorkers(boss: PgBoss, opts: { pollingIntervalSeconds: number }) {
  await boss.work<StoreJob>(QUEUES.shopifyTestConnection.name, opts, async (jobs) => {
    for (const { data } of jobs) {
      if (await isArchived(data.accountId, data.storeId)) continue;
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
      const uri = validCallbackUrl(data.callbackUrl) ?? webhookCallbackUrl();
      if (!uri) {
        await accountDb(data.accountId).store.update({
          where: { id: data.storeId },
          data: {
            webhookStatus: {
              ok: false,
              at: new Date().toISOString(),
              topics: [],
              errors: ["no_callback_url"],
            },
          },
        });
        logger.warn({ storeId: data.storeId }, "shopify webhooks: public URL unknown");
        continue;
      }
      const status = await registerStoreWebhooks(data.accountId, data.storeId, uri);
      logger.info(
        { storeId: data.storeId, ok: status.ok, topics: status.topics.length },
        "shopify webhooks registered",
      );
    }
  });

  await boss.work<RemoveWebhooksJob>(QUEUES.shopifyRemoveWebhooks.name, opts, async (jobs) => {
    for (const { data } of jobs) await runRemoveWebhooks(data);
  });

  await boss.work<SyncOrdersJob>(QUEUES.shopifySyncOrders.name, opts, async (jobs) => {
    for (const { data } of jobs) {
      if (!(await connectedStore(data.accountId, data.storeId))) continue;
      const { store, client } = await shopifyClientForStore(data.accountId, data.storeId);
      if (data.mode === "backfill" && !(data.from && data.to)) continue;
      const mode =
        data.mode === "backfill"
          ? { kind: "backfill" as const, from: data.from!, to: data.to! }
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
      where: { credentialId: { not: null }, archivedAt: null },
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
