import type { Queue } from "pg-boss";

/** Jobs that used up their retries land here and wait for a person (Settings → System jobs). */
export const DEAD_LETTER_QUEUE = "dead_letters";

export interface QueueDef {
  name: string;
  options: Omit<Queue, "name">;
  /** Cron (UTC) if the queue is scheduled. */
  cron?: string;
}

/**
 * "stately": at most one queued and one running job per singletonKey (pg-boss ignores singletonKey under the
 * default "standard" policy). A queue's policy cannot be changed after creation — new queues only.
 */
const retry = {
  retryLimit: 5,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 600,
  deadLetter: DEAD_LETTER_QUEUE,
};

export const QUEUES = {
  /** Sample/health job: proves the worker runs, retries and dead-letters. */
  ping: { name: "system.ping", options: { ...retry, retryLimit: 3 } },
  /**
   * Sends one OutboundRequest (data: { requestId }). Created before policies were used ("standard": duplicates
   * possible); harmless because the sender claims each request atomically and never double-sends.
   */
  outboxSend: { name: "outbox.send", options: { ...retry, expireInSeconds: 300 } },
  /** Every minute: picks due outbox rows, turns crashed sends into UNCERTAIN tasks. */
  outboxSweep: { name: "outbox.sweep", options: { retryLimit: 0, expireInSeconds: 120 }, cron: "* * * * *" },
  /** Shopify: connection test for one store (data: { accountId, storeId }). */
  shopifyTestConnection: {
    name: "shopify.testConnection",
    options: { ...retry, policy: "stately", retryLimit: 1, expireInSeconds: 120 },
  },
  /** Shopify: subscribe the store's webhooks to our URL (idempotent). */
  shopifyRegisterWebhooks: {
    name: "shopify.registerWebhooks",
    options: { ...retry, policy: "stately", expireInSeconds: 300 },
  },
  /** Shopify: pull orders (data: { accountId, storeId, mode: "reconcile" | "backfill", days? }). */
  shopifySyncOrders: {
    name: "shopify.syncOrders",
    options: { ...retry, policy: "stately", expireInSeconds: 3600 },
  },
  /** Shopify: pull all variants and auto-match them to master products. */
  shopifySyncProducts: {
    name: "shopify.syncProducts",
    options: { ...retry, policy: "stately", expireInSeconds: 3600 },
  },
  /** Shopify: act on one stored webhook event (data: { accountId, eventId }). */
  shopifyWebhook: {
    name: "shopify.webhook",
    options: { ...retry, policy: "stately", expireInSeconds: 300 },
  },
  /** Every 15 min: reconcile orders of every connected store, re-queue stuck webhook events. */
  shopifyReconcile: {
    name: "shopify.reconcile",
    options: { retryLimit: 0, expireInSeconds: 600 },
    cron: "*/15 * * * *",
  },
  /** euShipments read side (data: { accountId, connectionId[, countryId] }); every call is a GET/list. */
  eushipmentsTestConnection: {
    name: "eushipments.testConnection",
    options: { ...retry, policy: "stately", retryLimit: 1, expireInSeconds: 120 },
  },
  eushipmentsSyncReference: {
    name: "eushipments.syncReference",
    options: { ...retry, policy: "stately", expireInSeconds: 1800 },
  },
  eushipmentsSyncCities: {
    name: "eushipments.syncCities",
    options: { ...retry, policy: "stately", expireInSeconds: 1800 },
  },
  eushipmentsSyncProducts: {
    name: "eushipments.syncProducts",
    options: { ...retry, policy: "stately", expireInSeconds: 1800 },
  },
  eushipmentsSyncStock: {
    name: "eushipments.syncStock",
    options: { ...retry, policy: "stately", expireInSeconds: 900 },
  },
  eushipmentsPollOrders: {
    name: "eushipments.pollOrders",
    options: { ...retry, policy: "stately", expireInSeconds: 1800 },
  },
  eushipmentsPollBookings: {
    name: "eushipments.pollBookings",
    options: { ...retry, policy: "stately", expireInSeconds: 900 },
  },
  eushipmentsPollCod: {
    name: "eushipments.pollCod",
    options: { ...retry, policy: "stately", expireInSeconds: 1800 },
  },
  /** Every 15 min: products, stock, open shipments and bookings of every usable euShipments connection. */
  eushipmentsTick: {
    name: "eushipments.tick",
    options: { retryLimit: 0, expireInSeconds: 600 },
    cron: "*/15 * * * *",
  },
  /** Daily: couriers / warehouses / countries / offices and COD payouts. */
  eushipmentsDaily: {
    name: "eushipments.daily",
    options: { retryLimit: 0, expireInSeconds: 600 },
    cron: "41 3 * * *",
  },
  /** Hourly housekeeping: old login attempts. */
  housekeeping: {
    name: "system.housekeeping",
    options: { retryLimit: 2, expireInSeconds: 300 },
    cron: "17 * * * *",
  },
} satisfies Record<string, QueueDef>;
