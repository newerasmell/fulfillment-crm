import type { OutboundStatus, Prisma } from "@/generated/prisma/client";
import { ShopifyClient, type ShopifyClientOptions } from "@/integrations/shopify/client";
import { ShopifyError } from "@/integrations/shopify/errors";
import {
  existingFulfillment,
  failedFulfillment,
  FULFILLMENT_CREATE_MUTATION,
  FulfillmentCreateSchema,
  isDefiniteGraphqlRejection,
  planFulfillment,
  WRITE_BACK_READ_QUERY,
  WriteBackReadSchema,
  type WriteBackRead,
} from "@/integrations/shopify/fulfillments";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import { recordAudit } from "@/server/audit";
import { accountDb, systemDb, withSystemTransaction } from "@/server/db/client";
import { globalOutboxPaused } from "@/server/outbox/outbox";
import { shopifyClientForStore } from "@/server/shopify/store-client";

/**
 * Shopify fulfillment write-back (P4-07, SPEC §4, INTEGRATION_NOTES §6). When a shipment is SHIPPED (or later)
 * and has a tracking number, ONE ShopifyWriteBack row is created for it (unique per shipment). The sender:
 *  - gates on the store's CURRENT writeBackMode at send time: READ_ONLY → REFUSED (nothing read or sent),
 *    DRY_RUN → reads the order's fulfillment orders (a read) and records the exact mutation + variables,
 *    LIVE → sends fulfillmentCreate; the account kill switch / global pause park it as PAUSED;
 *  - claims the row (SENDING + lockedAt) before the call, so a crash leaves evidence, not a silent retry;
 *  - reads the order's fulfillments back by tracking number BEFORE every send and every retry: an existing
 *    fulfillment with our tracking number means done (never a second fulfillment for one shipment);
 *  - sends the mutation with a client that never retries by itself; an unknown outcome is resolved by the
 *    read-back, and becomes UNCERTAIN + a CRITICAL task when the read-back fails too.
 * Rows are only created for stores not in READ_ONLY and for shipments of the last WRITE_BACK_WINDOW_DAYS,
 * so raising a store's mode never notifies customers about old parcels.
 */

export const WRITE_BACK_MAX_ATTEMPTS = 5;
export const WRITE_BACK_STALE_MS = 10 * 60_000;
export const WRITE_BACK_WINDOW_DAYS = 14;
const SHIPPED_STATES = ["SHIPPED", "DELIVERED", "COD_PAID"] as const;
const backoffMs = (attempt: number) => Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

export type StoreClientFactory = (
  accountId: string,
  storeId: string,
  opts: ShopifyClientOptions,
) => Promise<{ client: ShopifyClient; store: { notifyCustomer: boolean } }>;

const defaultClients: StoreClientFactory = (accountId, storeId, opts) =>
  shopifyClientForStore(accountId, storeId, opts);

async function openTask(
  accountId: string,
  orderId: string,
  kind: string,
  title: string,
  body: string,
  severity: "WARNING" | "CRITICAL" = "WARNING",
) {
  const db = systemDb();
  const open = await db.alert.findFirst({
    where: { accountId, kind, entityType: "Order", entityId: orderId, status: { not: "RESOLVED" } },
    select: { id: true },
  });
  if (open) return;
  await db.alert.create({
    data: {
      accountId,
      kind,
      isTask: true,
      severity,
      title,
      body: body.slice(0, 2000),
      entityType: "Order",
      entityId: orderId,
    },
  });
}

/**
 * Creates the write-back rows that are due: shipped shipments with a tracking number, of Shopify orders, in
 * stores whose write-back is not READ_ONLY. Idempotent (unique per shipment). Also re-arms DRY_RUN records of
 * stores that are LIVE now (still inside the window), and turns crashed sends into UNCERTAIN tasks.
 */
export async function sweepWriteBacks(now: Date = new Date(), limit = 200) {
  const db = systemDb();
  const since = new Date(now.getTime() - WRITE_BACK_WINDOW_DAYS * 86_400_000);
  const stale = await db.shopifyWriteBack.findMany({
    where: { status: "SENDING", lockedAt: { lt: new Date(now.getTime() - WRITE_BACK_STALE_MS) } },
    select: {
      id: true,
      accountId: true,
      orderId: true,
      fulfillmentId: true,
      trackingNumber: true,
      evaluatedMode: true,
      request: true,
    },
  });
  for (const s of stale) {
    // A DRY_RUN only read: nothing can have been created, it may simply run again.
    const to: OutboundStatus = s.evaluatedMode === "LIVE" ? "UNCERTAIN" : "PENDING";
    const moved = await db.shopifyWriteBack.updateMany({
      where: { id: s.id, status: "SENDING" },
      data: { status: to, lastError: "worker stopped during the Shopify call" },
    });
    if (moved.count === 1 && to === "UNCERTAIN") {
      await openTask(
        s.accountId,
        s.orderId,
        "shopify_writeback_uncertain",
        "Shopify fulfillment: unknown result — check the order in Shopify before doing anything",
        "The worker stopped during fulfillmentCreate.",
        "CRITICAL",
      );
      await event(s, "uncertain", {
        lastError: "worker stopped during the Shopify call",
        request: s.request,
      });
    }
  }

  const due = await db.fulfillment.findMany({
    where: {
      status: { in: [...SHIPPED_STATES] },
      NOT: { trackingNumbers: { isEmpty: true } },
      shopifyWriteBack: null,
      OR: [{ shippedAt: { gte: since } }, { shippedAt: null, updatedAt: { gte: since } }],
      order: {
        source: "SHOPIFY",
        shopifyOrderGid: { not: null },
        status: { notIn: ["CANCELLED", "FULFILLED_EXTERNALLY"] },
        store: { writeBackMode: { not: "READ_ONLY" } },
      },
    },
    select: {
      id: true,
      accountId: true,
      orderId: true,
      trackingNumbers: true,
      order: { select: { storeId: true } },
    },
    take: limit,
  });
  let created = 0;
  for (const f of due) {
    const res = await db.shopifyWriteBack.createMany({
      data: [
        {
          accountId: f.accountId,
          storeId: f.order.storeId!,
          orderId: f.orderId,
          fulfillmentId: f.id,
          trackingNumber: f.trackingNumbers[0]!,
        },
      ],
      skipDuplicates: true,
    });
    created += res.count;
  }
  const rearmed = await db.shopifyWriteBack.updateMany({
    where: { status: "DRY_RUN_RECORDED", createdAt: { gte: since }, store: { writeBackMode: "LIVE" } },
    data: { status: "PENDING", attempts: 0, nextAttemptAt: null, lastError: null },
  });
  const ready = await db.shopifyWriteBack.findMany({
    where: {
      OR: [
        { status: "PENDING", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        ...(globalOutboxPaused() ? [] : [{ status: "PAUSED" as const, account: { outboxPaused: false } }]),
      ],
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  return { created, rearmed: rearmed.count, stale: stale.length, ready: ready.map((r) => r.id) };
}

type Claim =
  | { kind: "skip" }
  | {
      kind: "done";
      status: OutboundStatus;
      row?: { id: string; accountId: string; fulfillmentId: string; trackingNumber: string };
    }
  | {
      kind: "go";
      mode: "DRY_RUN" | "LIVE";
      attempts: number;
      row: {
        id: string;
        accountId: string;
        storeId: string;
        orderId: string;
        fulfillmentId: string;
        trackingNumber: string;
      };
    };

/** Processes one write-back row. Safe to call concurrently and repeatedly (row lock + status machine). */
export async function processWriteBack(
  id: string,
  clients: StoreClientFactory = defaultClients,
  now: Date = new Date(),
): Promise<OutboundStatus | "skipped"> {
  const claim: Claim = await withSystemTransaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "ShopifyWriteBack" WHERE id = ${id} FOR UPDATE SKIP LOCKED`;
    if (locked.length === 0) return { kind: "skip" };
    const row = await tx.shopifyWriteBack.findUniqueOrThrow({
      where: { id },
      include: {
        store: { select: { writeBackMode: true } },
        account: { select: { outboxPaused: true } },
      },
    });
    if (row.status !== "PENDING" && row.status !== "PAUSED") return { kind: "skip" };
    if (row.nextAttemptAt && row.nextAttemptAt > now) return { kind: "skip" };
    const mode = row.store.writeBackMode;
    if (globalOutboxPaused() || row.account.outboxPaused) {
      await tx.shopifyWriteBack.update({
        where: { id },
        data: { status: "PAUSED", evaluatedMode: mode, lastError: "paused" },
      });
      return { kind: "done", status: "PAUSED" };
    }
    if (mode === "READ_ONLY") {
      await tx.shopifyWriteBack.update({
        where: { id },
        data: { status: "REFUSED", evaluatedMode: mode, lastError: "store_read_only" },
      });
      return { kind: "done", status: "REFUSED", row };
    }
    const attempts = row.attempts + 1;
    await tx.shopifyWriteBack.update({
      where: { id },
      data: { status: "SENDING", evaluatedMode: mode, attempts, lockedAt: now, lastError: null },
    });
    return { kind: "go", mode, attempts, row };
  });
  if (claim.kind === "skip") return "skipped";
  if (claim.kind === "done") {
    if (claim.status === "REFUSED" && claim.row)
      await event(claim.row, "refused", { lastError: "store_read_only", mode: "READ_ONLY" });
    return claim.status;
  }
  return run(claim, clients, now);
}

async function run(claim: Extract<Claim, { kind: "go" }>, clients: StoreClientFactory, now: Date) {
  const db = systemDb();
  const { row, mode } = claim;
  const finalize = async (data: Prisma.ShopifyWriteBackUpdateManyMutationInput, status: OutboundStatus) => {
    const res = await db.shopifyWriteBack.updateMany({
      where: { id: row.id, status: "SENDING" },
      data: { ...data, status },
    });
    if (res.count === 1) return status;
    // The sweep declared it stale meanwhile: keep the late answer for the operator.
    await recordAudit({
      accountId: row.accountId,
      action: "shopify.writeback.late_result",
      entityType: "ShopifyWriteBack",
      entityId: row.id,
      after: { wouldBe: status, lastError: (data.lastError as string | null | undefined) ?? null },
    });
    return (await db.shopifyWriteBack.findUniqueOrThrow({ where: { id: row.id } })).status;
  };
  const retryLater = (detail: string) =>
    claim.attempts >= WRITE_BACK_MAX_ATTEMPTS
      ? finalize({ lastError: `max attempts: ${detail}` }, "FAILED").then(async (s) => {
          if (s === "FAILED") {
            await openTask(
              row.accountId,
              row.orderId,
              "shopify_writeback_failed",
              "Shopify fulfillment could not be created",
              detail,
            );
            await event(row, "failed", { lastError: `max attempts: ${detail}` });
          }
          return s;
        })
      : finalize(
          { lastError: detail, nextAttemptAt: new Date(now.getTime() + backoffMs(claim.attempts)) },
          "PENDING",
        );
  let sentRequest: Prisma.InputJsonValue | null = null;
  const failVisibly = async (reason: string, response?: unknown) => {
    const status = await finalize({ lastError: reason, lastResponse: json(response) }, "FAILED");
    if (status === "FAILED") {
      await openTask(
        row.accountId,
        row.orderId,
        "shopify_writeback_failed",
        "Shopify fulfillment needs an operator",
        reason,
      );
      await event(row, "failed", { lastError: reason, request: sentRequest, response: response ?? null });
    }
    return status;
  };
  const uncertain = async (detail: string) => {
    const status = await finalize({ lastError: detail }, "UNCERTAIN");
    if (status === "UNCERTAIN") {
      await openTask(
        row.accountId,
        row.orderId,
        "shopify_writeback_uncertain",
        "Shopify fulfillment: unknown result — check the order in Shopify before doing anything",
        detail,
        "CRITICAL",
      );
      await event(row, "uncertain", { lastError: detail, request: sentRequest });
    }
    return status;
  };

  // Everything we need from our side: Shopify ids of the shipped lines, tracking, notify setting.
  const [order, shipment] = await Promise.all([
    db.order.findUniqueOrThrow({ where: { id: row.orderId }, select: { shopifyOrderGid: true } }),
    db.fulfillment.findUniqueOrThrow({
      where: { id: row.fulfillmentId },
      select: {
        carrier: true,
        trackingUrls: true,
        lines: { select: { quantity: true, orderLine: { select: { shopifyLineGid: true } } } },
      },
    }),
  ]);
  let reader: ShopifyClient;
  let writer: ShopifyClient;
  let notifyCustomer: boolean;
  try {
    const r = await clients(row.accountId, row.storeId, {});
    reader = r.client;
    notifyCustomer = r.store.notifyCustomer;
    // The write never retries inside the client: a lost answer is resolved by reading back.
    writer = (await clients(row.accountId, row.storeId, { maxRetries: 0 })).client;
  } catch (err) {
    return failVisibly(`no Shopify client: ${scrubText((err as Error).message)}`);
  }
  const read = () =>
    reader.query(
      WRITE_BACK_READ_QUERY,
      { id: order.shopifyOrderGid },
      WriteBackReadSchema,
    ) as Promise<WriteBackRead>;

  let before: WriteBackRead;
  try {
    before = await read();
  } catch (err) {
    // Nothing was sent: try again later.
    return retryLater(`read failed: ${scrubText((err as Error).message)}`);
  }
  const existing = existingFulfillment(before, row.trackingNumber);
  if (existing) {
    const status = await finalize(
      {
        shopifyFulfillmentGid: existing.id,
        lastResponse: json(existing),
        sentAt: mode === "LIVE" ? now : undefined,
      },
      mode === "LIVE" ? "SENT" : "DRY_RUN_RECORDED",
    );
    if (status === "SENT") await event(row, "already_fulfilled", existing);
    return status;
  }
  // A fulfillment with our tracking number that failed at Shopify: an operator decides (never a silent SENT,
  // never an automatic second one).
  const failedBefore = failedFulfillment(before, row.trackingNumber);
  if (failedBefore)
    return failVisibly(`shopify_fulfillment_${failedBefore.status.toLowerCase()}`, failedBefore);
  const plan = planFulfillment(
    before,
    shipment.lines
      .filter((l) => l.orderLine.shopifyLineGid)
      .map((l) => ({ shopifyLineGid: l.orderLine.shopifyLineGid!, quantity: l.quantity })),
    { number: row.trackingNumber, company: shipment.carrier, url: shipment.trackingUrls[0] ?? null },
    notifyCustomer,
  );
  if (!plan.ok) return failVisibly(plan.reason);
  const request = json({ mutation: FULFILLMENT_CREATE_MUTATION, variables: { fulfillment: plan.input } });

  if (mode === "DRY_RUN") {
    const status = await finalize({ request }, "DRY_RUN_RECORDED");
    if (status === "DRY_RUN_RECORDED") await event(row, "dry_run", { variables: plan.input });
    return status;
  }

  sentRequest = request;
  await db.shopifyWriteBack.updateMany({ where: { id: row.id, status: "SENDING" }, data: { request } });
  let answer;
  try {
    answer = await writer.query(
      FULFILLMENT_CREATE_MUTATION,
      { fulfillment: plan.input },
      FulfillmentCreateSchema,
    );
  } catch (err) {
    const detail = scrubText((err as Error).message);
    // Shopify rejected the document itself (HTTP 401/403, or GraphQL errors whose codes all say "rejected
    // before execution"): nothing was executed. Any other GraphQL error (INTERNAL_SERVER_ERROR, a timeout, no
    // code) may come after the mutation ran: resolved by reading back like any unknown outcome.
    if (
      err instanceof ShopifyError &&
      (err.code === "auth_failed" ||
        (err.code === "graphql_error" && isDefiniteGraphqlRejection(err.graphqlCodes)))
    )
      return failVisibly(`${err.code}: ${detail}`);
    logger.warn({ writeBackId: row.id, err: detail }, "shopify fulfillmentCreate outcome unknown");
    let after: WriteBackRead;
    try {
      after = await read();
    } catch (readErr) {
      const rd = scrubText((readErr as Error).message);
      return uncertain(`${detail}; read-back failed: ${rd}`);
    }
    const found = existingFulfillment(after, row.trackingNumber);
    const failedAfter = failedFulfillment(after, row.trackingNumber);
    if (!found && failedAfter)
      return failVisibly(`shopify_fulfillment_${failedAfter.status.toLowerCase()}`, failedAfter);
    if (found) {
      const status = await finalize(
        {
          shopifyFulfillmentGid: found.id,
          sentAt: now,
          lastResponse: json(found),
          lastError: `recovered by read-back after: ${detail}`,
        },
        "SENT",
      );
      if (status === "SENT") await event(row, "sent", found);
      return status;
    }
    return retryLater(detail);
  }
  const payload = answer.fulfillmentCreate;
  if (!payload?.fulfillment || payload.userErrors.length) {
    const reason = payload?.userErrors.map((e) => e.message).join("; ") || "no fulfillment returned";
    return failVisibly(`rejected: ${scrubText(reason)}`, payload);
  }
  const status = await finalize(
    { shopifyFulfillmentGid: payload.fulfillment.id, sentAt: now, lastResponse: json(payload) },
    "SENT",
  );
  if (status === "SENT") await event(row, "sent", payload.fulfillment);
  return status;
}

/** Timeline + audit entry for every write-back outcome that matters (INTEGRATION_NOTES §6). */
async function event(
  row: { id: string; accountId: string; fulfillmentId: string; trackingNumber: string },
  what: "sent" | "dry_run" | "already_fulfilled" | "failed" | "uncertain" | "refused",
  payload: unknown,
) {
  await systemDb().fulfillmentEvent.create({
    data: {
      accountId: row.accountId,
      fulfillmentId: row.fulfillmentId,
      occurredAt: new Date(),
      source: "shopify.writeback",
      rawStatus: what,
      payload: json(payload),
    },
  });
  await recordAudit({
    accountId: row.accountId,
    action: `shopify.writeback.${what}`,
    entityType: "ShopifyWriteBack",
    entityId: row.id,
    after: { trackingNumber: row.trackingNumber, result: payload as Record<string, unknown> },
  });
}

/** Write-back rows of one order for the order page (the caller has already checked the order's scope). */
export function orderWriteBacks(accountId: string, orderId: string) {
  return accountDb(accountId).shopifyWriteBack.findMany({
    where: { orderId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      status: true,
      evaluatedMode: true,
      trackingNumber: true,
      request: true,
      lastError: true,
      shopifyFulfillmentGid: true,
      sentAt: true,
      updatedAt: true,
    },
  });
}
