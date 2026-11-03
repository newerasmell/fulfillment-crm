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
  /** Shopify: remove the store's webhook subscriptions to our URL (archive / delete); then deletes when asked. */
  shopifyRemoveWebhooks: {
    name: "shopify.removeWebhooks",
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
  /** API change watcher (P9-01): daily vendor spec fetch + diff + Shopify version deprecation check. */
  apiSpecWatch: {
    name: "apiwatch.specs",
    options: { retryLimit: 1, retryDelay: 600, policy: "stately", expireInSeconds: 900 },
    cron: "23 2 * * *",
  },
  /** API change watcher (P9-02): daily, queues one read-only live check per store/connection. */
  apiLiveCheck: {
    name: "apiwatch.liveCheck",
    options: { retryLimit: 0, policy: "stately", expireInSeconds: 300 },
    cron: "47 3 * * *",
  },
  /** One read-only live check (data: { accountId, kind, id }). */
  apiLiveCheckTarget: {
    name: "apiwatch.liveCheckTarget",
    options: { ...retry, retryLimit: 1, policy: "stately", expireInSeconds: 600 },
  },
  /** Hourly housekeeping: old login attempts. */
  housekeeping: {
    name: "system.housekeeping",
    options: { retryLimit: 2, expireInSeconds: 300 },
    cron: "17 * * * *",
  },
  /** FHB: re-read the order/product one stored callback points at (data: { accountId, eventId }). */
  fhbCallback: {
    name: "fhb.callback",
    options: { ...retry, policy: "stately", expireInSeconds: 300 },
  },
  /** Every 5 min: re-queue FHB callbacks whose job was lost or failed (bounded attempts). */
  fhbCallbackSweep: {
    name: "fhb.callbackSweep",
    options: { retryLimit: 0, expireInSeconds: 240 },
    cron: "*/5 * * * *",
  },
  /** FHB: one read resource of one connection (data: { accountId, connectionId, resource, service?, country? }). */
  fhbSync: {
    name: "fhb.sync",
    options: { ...retry, policy: "stately", retryLimit: 3, expireInSeconds: 3600 },
  },
  /** Every 30 min: queue the read sync of every FHB connection (SPEC §6.3 reconcile). */
  fhbReconcile: {
    name: "fhb.reconcile",
    options: { retryLimit: 0, expireInSeconds: 600 },
    cron: "*/30 * * * *",
  },
  /** Pre-flight checks of one order (data: { accountId, orderId }): routing + validators → READY / NEEDS_REVIEW. */
  ordersCheck: {
    name: "orders.check",
    options: { ...retry, policy: "stately", retryLimit: 3, expireInSeconds: 300 },
  },
  /** Every 5 min: queue checks for IMPORTED orders and for orders left in CHECKING by a crashed check. */
  ordersCheckSweep: {
    name: "orders.checkSweep",
    options: { retryLimit: 0, expireInSeconds: 240 },
    cron: "*/5 * * * *",
  },
  /** Every 2 min: Shopify fulfillment write-back of shipped shipments (store writeBackMode gate in the sender). */
  shopifyWriteBack: {
    name: "shopify.writeBack",
    options: { retryLimit: 0, policy: "stately", expireInSeconds: 600 },
    cron: "*/2 * * * *",
  },
  /** Every 2 min: product weight → Shopify (store weightWriteMode gate in the sender). */
  shopifyWeightWrite: {
    name: "shopify.weightWrite",
    options: { retryLimit: 0, policy: "stately", expireInSeconds: 600 },
    cron: "*/2 * * * *",
  },
  /** Every 10 min: order-state alerts (blocked / unknown / submit failed / stuck) and email/Telegram notifications. */
  alertsSweep: {
    name: "alerts.sweep",
    options: { retryLimit: 0, policy: "stately", expireInSeconds: 540 },
    cron: "*/10 * * * *",
  },
  /** Master catalogue run of a product line (data: { accountId, runId, lineId }); one at a time per line. */
  linesCatalogue: {
    name: "lines.catalogue",
    options: { ...retry, policy: "stately", retryLimit: 3, expireInSeconds: 3600 },
  },
  /** Every minute: follow open reroutes (P4-09) — confirm the old warehouse's cancel by read-back, then switch. */
  ordersRerouteSweep: {
    name: "orders.rerouteSweep",
    options: { retryLimit: 0, policy: "stately", expireInSeconds: 240 },
    cron: "* * * * *",
  },
  /** Stock track (P5-01): stock discrepancy alerts (Shopify oversell, stale snapshots, negative sellable). */
  stockDiscrepancies: {
    name: "stock.discrepancies",
    options: { retryLimit: 0, policy: "stately", expireInSeconds: 900 },
    cron: "25,55 * * * *",
  },
  /** Stock track (P5-02): FHB receipt read-back (GET only) per connection + inbound difference/overdue tasks. */
  stockInboundSweep: {
    name: "stock.inboundSweep",
    options: { retryLimit: 0, policy: "stately", expireInSeconds: 900 },
    cron: "10,40 * * * *",
  },
  /** Stock track (P5-03): read Shopify locations + inventory of one store (data: { accountId, storeId }). */
  stockShopifyInventory: {
    name: "stock.shopifyInventory",
    options: { ...retry, policy: "stately", retryLimit: 2, expireInSeconds: 1800 },
  },
  /** Every 10 min (owner request 2026-11-03): queue the Shopify inventory read of every connected store. */
  stockShopifyInventoryTick: {
    name: "stock.shopifyInventoryTick",
    options: { retryLimit: 0, expireInSeconds: 540 },
    cron: "2,12,22,32,42,52 * * * *",
  },
  /** Send one inventory push (data: { accountId, pushId }); the store's push mode is checked in the sender. */
  stockInventoryPush: {
    name: "stock.inventoryPush",
    options: { ...retry, policy: "stately", retryLimit: 0, expireInSeconds: 900 },
  },
  /**
   * Send one "activate products at this location" job (data: { accountId, activationId }); the store's push mode is
   * checked in the sender. Due/re-armed jobs are queued by stock.inventoryPushSweep.
   */
  stockInventoryActivate: {
    name: "stock.inventoryActivate",
    options: { ...retry, policy: "stately", retryLimit: 0, expireInSeconds: 900 },
  },
  /**
   * Every 10 min (owner request 2026-11-03), 3 min after the Shopify read: re-arm crashed pushes, create pushes for
   * DRY_RUN/LIVE stores, queue the due ones. At most one open push per store, so runs never pile up.
   */
  stockInventoryPushSweep: {
    name: "stock.inventoryPushSweep",
    options: { retryLimit: 0, policy: "stately", expireInSeconds: 540 },
    cron: "5,15,25,35,45,55 * * * *",
  },
  /** Every 10 min: return cases from the warehouse mirrors, overdue alerts, support notifications (P6-01). */
  returnsSweep: {
    name: "returns.sweep",
    options: { retryLimit: 0, policy: "stately", expireInSeconds: 540 },
    cron: "*/10 * * * *",
  },
  /** FHB local return photos of one case (data: { accountId, caseId }); GET calls only. */
  returnsPhotos: {
    name: "returns.photos",
    options: { ...retry, policy: "stately", retryLimit: 2, expireInSeconds: 600 },
  },
  /** Hourly: COD mismatches (amount / missing / unexpected) → operator tasks (P6-02). */
  codSweep: {
    name: "cod.sweep",
    options: { retryLimit: 0, policy: "stately", expireInSeconds: 1800 },
    cron: "37 * * * *",
  },
  /** Labels (P7): every 10 min — tracking of label shipments (Joy GET /shipment, AWB waybills-history) and
   * fetching AWB labels not stored yet. Read calls only. */
  labelsSweep: {
    name: "labels.sweep",
    options: { retryLimit: 0, policy: "stately", expireInSeconds: 540 },
    cron: "*/10 * * * *",
  },
  /** Tracking of one label connection (data: { accountId, connectionId }). */
  labelsTrack: {
    name: "labels.track",
    options: { ...retry, policy: "stately", retryLimit: 2, expireInSeconds: 900 },
  },
  /** One label read: bulk PDF job, AWB/Joy label re-fetch, price quote, Joy login test (data: { accountId, kind, id }). */
  labelsRead: {
    name: "labels.read",
    options: { ...retry, policy: "stately", retryLimit: 2, expireInSeconds: 300 },
  },
  /**
   * AI reviewer: one order (data: { accountId, orderId }); one queued + one running per order. The expiry is above
   * the LLM client's overall deadline (src/ai/llm.ts LLM_DEADLINE_MS = 240 s) plus the DB work around it.
   */
  aiReview: {
    name: "ai.review",
    options: { ...retry, policy: "stately", retryLimit: 1, expireInSeconds: 600 },
  },
  /** Every 5 min: queue AI reviews for checked orders whose current version has no suggestion yet. */
  aiSweep: {
    name: "ai.sweep",
    options: { retryLimit: 0, policy: "stately", expireInSeconds: 240 },
    cron: "*/5 * * * *",
  },
  /** Every 10 min: embed decided reviews, compare decisions with AI suggestions, automatic policy demotion. */
  aiEvaluate: {
    name: "ai.evaluate",
    options: { retryLimit: 0, policy: "stately", expireInSeconds: 540 },
    cron: "*/10 * * * *",
  },
  /** Daily: random audit sample of yesterday's autopilot approvals. */
  aiAuditSample: {
    name: "ai.auditSample",
    options: { retryLimit: 2, policy: "stately", expireInSeconds: 600 },
    cron: "21 4 * * *",
  },
  /** Weekly (Monday): cluster repeated operator corrections into validator proposals. */
  aiRuleMining: {
    name: "ai.ruleMining",
    options: { retryLimit: 1, policy: "stately", expireInSeconds: 1800 },
    cron: "37 5 * * 1",
  },
} satisfies Record<string, QueueDef>;
