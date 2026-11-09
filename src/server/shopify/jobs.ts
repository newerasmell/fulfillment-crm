import { WEBHOOK_TOPICS } from "@/integrations/shopify/webhooks";
import type { PgBoss } from "pg-boss";
import type { ShopifyClientOptions } from "@/integrations/shopify/client";
import { parseAppCredentials } from "@/integrations/shopify/credentials";
import { logger } from "@/lib/logger";
import { readCredentialSecret } from "@/server/security/credentials";
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
  /**
   * Ignored (jobs queued by older code): whether the store is deleted after the removal is decided from the
   * store itself (webhookStatus.deleteRequested), since jobs are coalesced per store and a restore may come between.
   */
  deleteAfter?: boolean;
  /** The user who asked, for the audit log. */
  userId?: string | null;
  /** Remove our subscriptions on the shop the store pointed at before a domain change (the store is not archived). */
  oldDomain?: string;
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
    boss.send(QUEUES.shopifyRemoveWebhooks.name, d, {
      singletonKey: d.oldDomain ? `${d.storeId}:old:${d.oldDomain}` : d.storeId,
    }),
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

async function clientIdOf(accountId: string, credentialId: string) {
  return parseAppCredentials(await readCredentialSecret(accountDb(accountId), accountId, credentialId))
    .clientId;
}

/**
 * True when another live store (any group) uses this shop through the same Shopify app: webhook subscriptions
 * belong to the app, so they are shared with it and must stay. A store on the same shop through another app
 * does not use ours. A credential that cannot be read counts as shared (keeping them is the safe side).
 */
async function sharedWithSameApp(
  accountId: string,
  storeId: string,
  domain: string,
  credentialId: string | null,
) {
  const others = await systemDb().store.findMany({
    where: { domain, id: { not: storeId }, archivedAt: null, credentialId: { not: null } },
    select: { accountId: true, credentialId: true },
  });
  if (!others.length) return false;
  if (!credentialId) return true;
  let own: string;
  try {
    own = await clientIdOf(accountId, credentialId);
  } catch {
    return true;
  }
  for (const o of others) {
    if (o.credentialId === credentialId) return true;
    try {
      if ((await clientIdOf(o.accountId, o.credentialId!)) === own) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** Domain change: removes our subscriptions on the old shop (same credential), unless the store points there again. */
async function removeOldShopWebhooks(
  data: RemoveWebhooksJob & { oldDomain: string },
  opts: ShopifyClientOptions,
) {
  const store = await accountDb(data.accountId).store.findUnique({
    where: { id: data.storeId },
    select: { domain: true, credentialId: true },
  });
  if (!store || !store.credentialId || store.domain === data.oldDomain) return "skipped" as const;
  if (await sharedWithSameApp(data.accountId, data.storeId, data.oldDomain, store.credentialId))
    return "removed" as const;
  const uri = validCallbackUrl(data.callbackUrl) ?? webhookCallbackUrl();
  if (!uri) return "failed" as const;
  const status = await removeStoreWebhooks(data.accountId, data.storeId, uri, opts, data.oldDomain);
  logger.info({ storeId: data.storeId, ok: status.ok }, "shopify webhooks removed on the previous shop");
  return status.ok ? ("removed" as const) : ("failed" as const);
}

/**
 * Removal job: only for an archived store (a restore in between wins). Without a usable connection nothing can
 * be removed — a store being deleted is then deleted anyway (Shopify drops subscriptions that keep failing). A shop
 * that another live store uses through the same app keeps its subscriptions: they are shared. The store is deleted
 * afterwards only when it still asks for it (deleteRequested), whatever job payload was coalesced into this run.
 */
export async function runRemoveWebhooks(data: RemoveWebhooksJob, opts: ShopifyClientOptions = {}) {
  if (data.oldDomain) return removeOldShopWebhooks({ ...data, oldDomain: data.oldDomain }, opts);
  const db = accountDb(data.accountId);
  const store = await db.store.findUnique({
    where: { id: data.storeId },
    select: {
      archivedAt: true,
      domain: true,
      connectionStatus: true,
      webhookStatus: true,
      credentialId: true,
    },
  });
  if (!store || !store.archivedAt) return "skipped" as const;
  const finish = async () => {
    const now = await db.store.findUnique({
      where: { id: data.storeId },
      select: { archivedAt: true, webhookStatus: true },
    });
    const deleteRequested = (now?.webhookStatus as { deleteRequested?: boolean } | undefined)
      ?.deleteRequested;
    if (!now?.archivedAt || deleteRequested !== true) return "removed" as const;
    await purgeStore(data.accountId, data.storeId, { userId: data.userId ?? null });
    return "deleted" as const;
  };
  const shared = await sharedWithSameApp(data.accountId, data.storeId, store.domain, store.credentialId);
  const connected = (store.connectionStatus as { ok?: boolean }).ok === true;
  if (shared || !connected) {
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
          ...(shared ? { note: "shared_shop" } : { note: "not_connected" }),
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
      select: { id: true, accountId: true, connectionStatus: true, webhookStatus: true },
    });
    let queued = 0;
    for (const s of stores) {
      if ((s.connectionStatus as { ok?: boolean }).ok !== true) continue;
      await enqueueShopify.syncOrders(boss, { accountId: s.accountId, storeId: s.id, mode: "reconcile" });
      queued++;
      // A topic added in a later version (e.g. products/create) is subscribed without anyone pressing a button;
      // registration is idempotent (only missing topics are created).
      const topics = (s.webhookStatus as { topics?: unknown } | null)?.topics;
      if (Array.isArray(topics) && topics.length && WEBHOOK_TOPICS.some((t) => !topics.includes(t)))
        await enqueueShopify.registerWebhooks(boss, { accountId: s.accountId, storeId: s.id });
    }
    for (const e of await staleWebhookEvents()) {
      if (e.accountId) await enqueueShopify.webhook(boss, { accountId: e.accountId, eventId: e.id });
    }
    if (queued) logger.info({ stores: queued }, "shopify reconcile queued");
  });
}
