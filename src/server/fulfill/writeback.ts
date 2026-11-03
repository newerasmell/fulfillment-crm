import type { OutboundStatus, Prisma, ShopifyWriteBackKind } from "@/generated/prisma/client";
import { ShopifyClient, type ShopifyClientOptions } from "@/integrations/shopify/client";
import { ShopifyError } from "@/integrations/shopify/errors";
import {
  EVENT_FOR_STATUS,
  EVENT_RANK,
  existingFulfillment,
  failedFulfillment,
  FULFILLMENT_CREATE_MUTATION,
  FULFILLMENT_EVENT_CREATE_MUTATION,
  FULFILLMENT_TRACKING_UPDATE_MUTATION,
  FulfillmentCreateSchema,
  FulfillmentEventCreateSchema,
  FulfillmentTrackingUpdateSchema,
  isDefiniteGraphqlRejection,
  newFulfillments,
  planFulfillment,
  sameLines,
  trackingInput,
  WRITE_BACK_READ_QUERY,
  WRITE_BACK_STATE_QUERY,
  WriteBackReadSchema,
  WriteBackStateSchema,
  type ShopifyEventStatus,
  type WriteBackRead,
  type WriteBackState,
} from "@/integrations/shopify/fulfillments";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import { recordAudit } from "@/server/audit";
import { accountDb, systemDb, withSystemTransaction } from "@/server/db/client";
import { globalOutboxPaused } from "@/server/outbox/outbox";
import { shopifyClientForStore } from "@/server/shopify/store-client";

/**
 * Shopify write-back (P4-07, lifecycle owner request 2026-11-03; SPEC §4, INTEGRATION_NOTES §6). Per shipment, in
 * order, each write one ShopifyWriteBack row:
 *  1. FULFIL (one per shipment): fulfillmentCreate for this shipment's lines of the order's open fulfillment
 *     orders. When depends on the store's "Маркирай изпълнена в Shopify": ON_TRACKING (default) — SHIPPED or later
 *     with a tracking number; ON_ACCEPT — ACCEPTED or later, with tracking when there is one, otherwise without
 *     tracking and notifyCustomer=false (no shipping e-mail without tracking).
 *  2. TRACKING (one per tracking value): fulfillmentTrackingInfoUpdate of that Shopify fulfillment when the
 *     shipment gets a tracking number later or it changes; notifyCustomer from the store setting.
 *  3. EVENT (one per FulfillmentEventStatus): fulfillmentEventCreate when our status moves (EVENT_FOR_STATUS);
 *     never an earlier status after a later one (EVENT_RANK), never twice.
 * The sender, for every kind:
 *  - gates on the store's CURRENT writeBackMode at send time: READ_ONLY → REFUSED (nothing read or sent),
 *    DRY_RUN → records the exact mutation + variables, LIVE → sends; the account kill switch / global pause park
 *    it as PAUSED; a shipment cancelled / re-routed since the row was created → REFUSED;
 *  - claims the row (SENDING + lockedAt) before the call, so a crash leaves evidence, not a silent retry;
 *  - reads Shopify back BEFORE every send and every retry (fulfillment with our tracking number / our lines; the
 *    tracking number or event already on the fulfillment) — never a second fulfillment for one shipment;
 *  - sends with a client that never retries by itself; an unknown outcome is resolved by the read-back, and
 *    becomes UNCERTAIN + a CRITICAL task when the read-back fails too;
 *  - TRACKING / EVENT rows in LIVE wait for the shipment's FULFIL row (and earlier rows of their kind) to be done.
 * Rows are only created for stores not in READ_ONLY and for shipments of the last WRITE_BACK_WINDOW_DAYS, so
 * raising a store's mode never notifies customers about old parcels.
 */

export const WRITE_BACK_MAX_ATTEMPTS = 5;
export const WRITE_BACK_STALE_MS = 10 * 60_000;
export const WRITE_BACK_WINDOW_DAYS = 14;
/** A TRACKING / EVENT row whose FULFIL row (or an earlier row of its kind) is still on its way looks again after. */
export const WRITE_BACK_WAIT_MS = 2 * 60_000;
const SHIPPED_STATES = ["SHIPPED", "DELIVERED", "COD_PAID"] as const;
const ACCEPTED_STATES = ["ACCEPTED", "PROCESSING", ...SHIPPED_STATES] as const;
/** Statuses whose shipment may still get tracking updates / events (a FULFIL row exists already). */
const FOLLOW_STATES = [...ACCEPTED_STATES, "RETURNING", "RETURN_RECEIVED", "EXCEPTION"] as const;
const IN_FLIGHT: OutboundStatus[] = ["PENDING", "PAUSED", "SENDING"];
const DEPENDENT_PAGE = 500;
const NO_TARGET = "<the Shopify fulfillment created by the FULFIL write-back>";
const backoffMs = (attempt: number) => Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

const WHAT: Record<ShopifyWriteBackKind, string> = {
  FULFIL: "Shopify fulfillment",
  TRACKING: "Shopify tracking update",
  EVENT: "Shopify fulfillment event",
};
const MUTATION_NAME: Record<ShopifyWriteBackKind, string> = {
  FULFIL: "fulfillmentCreate",
  TRACKING: "fulfillmentTrackingInfoUpdate",
  EVENT: "fulfillmentEventCreate",
};

export type StoreClientFactory = (
  accountId: string,
  storeId: string,
  opts: ShopifyClientOptions,
) => Promise<{ client: ShopifyClient; store: { notifyCustomer: boolean } }>;

const defaultClients: StoreClientFactory = (accountId, storeId, opts) =>
  shopifyClientForStore(accountId, storeId, opts);

/** A shipment we may still write about: Shopify order, not cancelled, not re-routed away, store not READ_ONLY. */
const writableShipment = {
  status: { not: "CANCELLED" },
  reroutesFrom: { none: { status: { in: ["CANCEL_QUEUED", "DONE"] } } },
  order: {
    source: "SHOPIFY",
    shopifyOrderGid: { not: null },
    status: { notIn: ["CANCELLED", "FULFILLED_EXTERNALLY"] },
    store: { writeBackMode: { not: "READ_ONLY" } },
  },
} satisfies Prisma.FulfillmentWhereInput;

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

type RowRef = {
  id: string;
  accountId: string;
  fulfillmentId: string;
  kind: ShopifyWriteBackKind;
  value: string;
  trackingNumber: string | null;
};

/**
 * Creates the write-back rows that are due (idempotent: unique per shipment + kind + value), re-arms DRY_RUN
 * records of stores that are LIVE now (still inside the window), and turns crashed sends into UNCERTAIN tasks.
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
      kind: true,
      value: true,
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
        `${WHAT[s.kind]}: unknown result — check the order in Shopify before doing anything`,
        `The worker stopped during ${MUTATION_NAME[s.kind]}.`,
        "CRITICAL",
      );
      await event(s, "uncertain", {
        lastError: "worker stopped during the Shopify call",
        request: s.request,
      });
    }
  }

  // 1. FULFIL: one per shipment, when the store's trigger says so.
  const due = await db.fulfillment.findMany({
    where: {
      ...writableShipment,
      shopifyWriteBacks: { none: { kind: "FULFIL" } },
      OR: [{ shippedAt: { gte: since } }, { shippedAt: null, updatedAt: { gte: since } }],
      AND: [
        {
          OR: [
            { status: { in: [...SHIPPED_STATES] }, NOT: { trackingNumbers: { isEmpty: true } } },
            { status: { in: [...ACCEPTED_STATES] }, order: { store: { fulfilTrigger: "ON_ACCEPT" } } },
          ],
        },
      ],
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
          kind: "FULFIL",
          value: "",
          trackingNumber: f.trackingNumbers[0] ?? null,
        },
      ],
      skipDuplicates: true,
    });
    created += res.count;
  }

  // 2 + 3. TRACKING and EVENT rows of shipments that already have their FULFIL row and changed recently.
  let cursor: string | undefined;
  for (let page = 0; page < 40; page++) {
    const batch = await db.fulfillment.findMany({
      where: {
        ...writableShipment,
        status: { in: [...FOLLOW_STATES] },
        updatedAt: { gte: since },
        shopifyWriteBacks: { some: { kind: "FULFIL" } },
      },
      select: {
        id: true,
        accountId: true,
        orderId: true,
        status: true,
        trackingNumbers: true,
        order: { select: { storeId: true } },
        shopifyWriteBacks: {
          select: { kind: true, value: true, trackingNumber: true, createdAt: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
      },
      orderBy: { id: "asc" },
      take: DEPENDENT_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const f of batch) {
      const rows = dependentRowsDue(f.status, f.trackingNumbers, f.shopifyWriteBacks);
      if (rows.length === 0) continue;
      const res = await db.shopifyWriteBack.createMany({
        data: rows.map((r) => ({
          accountId: f.accountId,
          storeId: f.order.storeId!,
          orderId: f.orderId,
          fulfillmentId: f.id,
          kind: r.kind,
          value: r.value,
          trackingNumber: r.kind === "TRACKING" ? r.value : null,
        })),
        skipDuplicates: true,
      });
      created += res.count;
    }
    if (batch.length < DEPENDENT_PAGE) break;
    cursor = batch.at(-1)!.id;
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
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
  });
  return { created, rearmed: rearmed.count, stale: stale.length, ready: ready.map((r) => r.id) };
}

/**
 * Which TRACKING / EVENT rows a shipment needs now (pure). `existing` are its write-back rows, oldest first.
 * TRACKING: the current tracking number differs from the last one written (FULFIL with tracking, or the latest
 * TRACKING row) and was never written. EVENT: the event of the current status, unless it, or a later one, exists.
 */
export function dependentRowsDue(
  status: string,
  trackingNumbers: readonly string[],
  existing: readonly { kind: ShopifyWriteBackKind; value: string; trackingNumber: string | null }[],
): { kind: "TRACKING" | "EVENT"; value: string }[] {
  const out: { kind: "TRACKING" | "EVENT"; value: string }[] = [];
  if (!existing.some((r) => r.kind === "FULFIL")) return out;
  const current = trackingNumbers[0];
  if (current) {
    const written = existing
      .map((r) => (r.kind === "FULFIL" ? r.trackingNumber : r.kind === "TRACKING" ? r.value : null))
      .filter((v): v is string => !!v);
    const known = existing.some((r) => r.kind === "TRACKING" && r.value === current);
    if (written.at(-1) !== current && !known) out.push({ kind: "TRACKING", value: current });
  }
  const ev = EVENT_FOR_STATUS[status];
  if (ev) {
    const events = existing.filter((r) => r.kind === "EVENT").map((r) => r.value as ShopifyEventStatus);
    const maxRank = Math.max(0, ...events.map((e) => EVENT_RANK[e] ?? 0));
    if (!events.includes(ev) && EVENT_RANK[ev] > maxRank) out.push({ kind: "EVENT", value: ev });
  }
  return out;
}

type ClaimRow = RowRef & {
  storeId: string;
  orderId: string;
  createdAt: Date;
  request: Prisma.JsonValue;
};

type Claim =
  | { kind: "skip" }
  | { kind: "done"; status: OutboundStatus; row?: RowRef; reason?: string }
  | {
      kind: "go";
      mode: "DRY_RUN" | "LIVE";
      attempts: number;
      row: ClaimRow;
      /** TRACKING / EVENT: the Shopify fulfillment to update (null only in DRY_RUN before the FULFIL is sent). */
      target: string | null;
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
        order: { select: { status: true } },
        fulfillment: {
          select: {
            status: true,
            reroutesFrom: { where: { status: { in: ["CANCEL_QUEUED", "DONE"] } }, select: { id: true } },
          },
        },
      },
    });
    if (row.status !== "PENDING" && row.status !== "PAUSED") return { kind: "skip" };
    if (row.nextAttemptAt && row.nextAttemptAt > now) return { kind: "skip" };
    const mode = row.store.writeBackMode;
    const refuse = async (reason: string) => {
      await tx.shopifyWriteBack.update({
        where: { id },
        data: { status: "REFUSED", evaluatedMode: mode, lastError: reason },
      });
      return { kind: "done" as const, status: "REFUSED" as const, row, reason };
    };
    if (globalOutboxPaused() || row.account.outboxPaused) {
      await tx.shopifyWriteBack.update({
        where: { id },
        data: { status: "PAUSED", evaluatedMode: mode, lastError: "paused" },
      });
      return { kind: "done", status: "PAUSED" };
    }
    if (mode === "READ_ONLY") return refuse("store_read_only");
    if (
      row.fulfillment.status === "CANCELLED" ||
      row.fulfillment.reroutesFrom.length > 0 ||
      row.order.status === "CANCELLED" ||
      row.order.status === "FULFILLED_EXTERNALLY"
    )
      return refuse("shipment_cancelled");

    let target: string | null = null;
    if (row.kind !== "FULFIL") {
      const [parent, earlier] = await Promise.all([
        tx.shopifyWriteBack.findFirst({
          where: { accountId: row.accountId, fulfillmentId: row.fulfillmentId, kind: "FULFIL" },
          select: { status: true, shopifyFulfillmentGid: true },
        }),
        tx.shopifyWriteBack.count({
          where: {
            accountId: row.accountId,
            fulfillmentId: row.fulfillmentId,
            kind: row.kind,
            id: { not: row.id },
            status: { in: IN_FLIGHT },
            OR: [{ createdAt: { lt: row.createdAt } }, { createdAt: row.createdAt, id: { lt: row.id } }],
          },
        }),
      ]);
      target = parent?.shopifyFulfillmentGid ?? null;
      if (mode === "LIVE") {
        // In order: the fulfillment first, then earlier rows of this kind; a parent that will not be sent
        // means there is nothing in Shopify to update.
        if ((parent && IN_FLIGHT.includes(parent.status)) || earlier > 0) {
          await tx.shopifyWriteBack.update({
            where: { id },
            data: {
              status: "PENDING",
              evaluatedMode: mode,
              nextAttemptAt: new Date(now.getTime() + WRITE_BACK_WAIT_MS),
              lastError: "waiting_for_earlier_write",
            },
          });
          return { kind: "done", status: "PENDING" };
        }
        if (!parent || parent.status !== "SENT" || !target) return refuse("fulfillment_not_in_shopify");
      }
    }
    const attempts = row.attempts + 1;
    await tx.shopifyWriteBack.update({
      where: { id },
      data: { status: "SENDING", evaluatedMode: mode, attempts, lockedAt: now, lastError: null },
    });
    return { kind: "go", mode, attempts, row, target };
  });
  if (claim.kind === "skip") return "skipped";
  if (claim.kind === "done") {
    if (claim.status === "REFUSED" && claim.row)
      await event(claim.row, "refused", { lastError: claim.reason ?? null });
    return claim.status;
  }
  return run(claim, clients, now);
}

/** What one kind sends, and how to tell from Shopify that it is already there. */
interface SendPlan {
  request: Prisma.InputJsonValue;
  /** Sends the mutation once; returns the Shopify result or a definite refusal. */
  send: () => Promise<
    { ok: true; gid: string; response: unknown } | { ok: false; reason: string; response: unknown }
  >;
  /** Read-back after an unknown outcome: the result when it is in Shopify now, null when not (throws if unreadable). */
  confirm: () => Promise<{ gid: string; response: unknown } | null>;
}

type Prepared =
  { kind: "plan"; plan: SendPlan; dryRunPayload: unknown } | { kind: "final"; status: OutboundStatus };

async function run(claim: Extract<Claim, { kind: "go" }>, clients: StoreClientFactory, now: Date) {
  const db = systemDb();
  const { row, mode } = claim;
  const what = WHAT[row.kind];
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
              `${what} could not be written`,
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
        `${what} needs an operator`,
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
        `${what}: unknown result — check the order in Shopify before doing anything`,
        detail,
        "CRITICAL",
      );
      await event(row, "uncertain", { lastError: detail, request: sentRequest });
    }
    return status;
  };
  const alreadyThere = async (gid: string, response: unknown) => {
    const status = await finalize(
      { shopifyFulfillmentGid: gid, lastResponse: json(response), sentAt: mode === "LIVE" ? now : undefined },
      mode === "LIVE" ? "SENT" : "DRY_RUN_RECORDED",
    );
    if (status === "SENT") await event(row, "already_sent", response);
    return status;
  };

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
  const ctx: KindContext = {
    row,
    mode,
    target: claim.target,
    reader,
    writer,
    notifyCustomer,
    retryLater,
    failVisibly,
    alreadyThere,
    finalize,
  };

  let prepared: Prepared;
  try {
    prepared =
      row.kind === "FULFIL"
        ? await prepareFulfil(ctx)
        : row.kind === "TRACKING"
          ? await prepareTracking(ctx)
          : await prepareEvent(ctx);
  } catch (err) {
    // Only reads happened: nothing was sent, try again later.
    return retryLater(`read failed: ${scrubText((err as Error).message)}`);
  }
  if (prepared.kind === "final") return prepared.status;
  const { plan } = prepared;

  if (mode === "DRY_RUN") {
    const status = await finalize({ request: plan.request }, "DRY_RUN_RECORDED");
    if (status === "DRY_RUN_RECORDED") await event(row, "dry_run", prepared.dryRunPayload);
    return status;
  }

  sentRequest = plan.request;
  await db.shopifyWriteBack.updateMany({
    where: { id: row.id, status: "SENDING" },
    data: { request: plan.request, ...(claim.target ? { shopifyFulfillmentGid: claim.target } : {}) },
  });
  let answer: Awaited<ReturnType<SendPlan["send"]>>;
  try {
    answer = await plan.send();
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
    logger.warn(
      { writeBackId: row.id, kind: row.kind, err: detail },
      `shopify ${MUTATION_NAME[row.kind]} outcome unknown`,
    );
    let found: Awaited<ReturnType<SendPlan["confirm"]>>;
    try {
      found = await plan.confirm();
    } catch (readErr) {
      if (readErr instanceof ConfirmFailure) return failVisibly(readErr.reason, readErr.response);
      const rd = scrubText((readErr as Error).message);
      return uncertain(`${detail}; read-back failed: ${rd}`);
    }
    if (found) {
      const status = await finalize(
        {
          shopifyFulfillmentGid: found.gid,
          sentAt: now,
          lastResponse: json(found.response),
          lastError: `recovered by read-back after: ${detail}`,
        },
        "SENT",
      );
      if (status === "SENT") await event(row, "sent", found.response);
      return status;
    }
    return retryLater(detail);
  }
  if (!answer.ok) return failVisibly(`rejected: ${scrubText(answer.reason)}`, answer.response);
  const status = await finalize(
    { shopifyFulfillmentGid: answer.gid, sentAt: now, lastResponse: json(answer.response) },
    "SENT",
  );
  if (status === "SENT") await event(row, "sent", answer.response);
  return status;
}

/** A read-back that found a definite failure in Shopify (an operator decides, never a silent retry). */
class ConfirmFailure extends Error {
  constructor(
    readonly reason: string,
    readonly response: unknown,
  ) {
    super(reason);
  }
}

interface KindContext {
  row: ClaimRow;
  mode: "DRY_RUN" | "LIVE";
  target: string | null;
  reader: ShopifyClient;
  writer: ShopifyClient;
  notifyCustomer: boolean;
  retryLater: (detail: string) => Promise<OutboundStatus>;
  failVisibly: (reason: string, response?: unknown) => Promise<OutboundStatus>;
  alreadyThere: (gid: string, response: unknown) => Promise<OutboundStatus>;
  finalize: (
    data: Prisma.ShopifyWriteBackUpdateManyMutationInput,
    status: OutboundStatus,
  ) => Promise<OutboundStatus>;
}

const final = (status: OutboundStatus): Prepared => ({ kind: "final", status });
const readOrder = (c: ShopifyClient, gid: string | null) =>
  c.query(WRITE_BACK_READ_QUERY, { id: gid }, WriteBackReadSchema) as Promise<WriteBackRead>;
const readState = (c: ShopifyClient, gid: string) =>
  c.query(WRITE_BACK_STATE_QUERY, { id: gid }, WriteBackStateSchema) as Promise<WriteBackState>;
const userErrorText = (errs: { message: string }[] | undefined) => errs?.map((e) => e.message).join("; ");

/** Stored with a fulfilment sent without tracking: what identifies ours in a later read-back. */
interface ReadBackKey {
  knownFulfillmentIds: string[];
  lines: { lineItemId: string; quantity: number }[];
}

/** FULFIL: fulfillmentCreate for this shipment's lines (with tracking when the row has it). */
async function prepareFulfil(ctx: KindContext): Promise<Prepared> {
  const db = systemDb();
  const { row } = ctx;
  const [order, shipment] = await Promise.all([
    db.order.findUniqueOrThrow({ where: { id: row.orderId }, select: { shopifyOrderGid: true } }),
    db.fulfillment.findUniqueOrThrow({
      where: { id: row.fulfillmentId },
      select: {
        carrier: true,
        trackingNumbers: true,
        trackingUrls: true,
        lines: { select: { quantity: true, orderLine: { select: { shopifyLineGid: true } } } },
      },
    }),
  ]);
  const read = () => readOrder(ctx.reader, order.shopifyOrderGid);
  const before = await read();
  const tn = row.trackingNumber;
  const lines = shipment.lines
    .filter((l) => l.orderLine.shopifyLineGid)
    .map((l) => ({ shopifyLineGid: l.orderLine.shopifyLineGid!, quantity: l.quantity }));

  // Without tracking (ON_ACCEPT): ours is a fulfillment that did not exist at our first attempt and holds
  // exactly our lines. The key is stored with the request before the first send and reused on every retry.
  const prior = (row.request as { readBack?: ReadBackKey } | null)?.readBack ?? null;
  const findOurs = async (r: WriteBackRead, key: ReadBackKey) => {
    const matches: { gid: string; response: unknown }[] = [];
    for (const f of newFulfillments(r, key.knownFulfillmentIds)) {
      const state = await readState(ctx.reader, f.id);
      if (state.fulfillment && sameLines(state, key.lines)) matches.push({ gid: f.id, response: f });
    }
    if (matches.length > 1) throw new Error("several new Shopify fulfillments match this shipment");
    const m = matches[0] ?? null;
    if (m && FAILED.has((m.response as { status: string }).status))
      throw new ConfirmFailure(
        `shopify_fulfillment_${(m.response as { status: string }).status.toLowerCase()}`,
        m.response,
      );
    return m;
  };

  if (tn) {
    const existing = existingFulfillment(before, tn);
    if (existing) return final(await ctx.alreadyThere(existing.id, existing));
    // A fulfillment with our tracking number that failed at Shopify: an operator decides (never a silent SENT,
    // never an automatic second one).
    const failedBefore = failedFulfillment(before, tn);
    if (failedBefore)
      return final(
        await ctx.failVisibly(`shopify_fulfillment_${failedBefore.status.toLowerCase()}`, failedBefore),
      );
  } else if (prior) {
    try {
      const ours = await findOurs(before, prior);
      if (ours) return final(await ctx.alreadyThere(ours.gid, ours.response));
    } catch (err) {
      if (err instanceof ConfirmFailure) return final(await ctx.failVisibly(err.reason, err.response));
      throw err;
    }
  }

  const url = tn
    ? (shipment.trackingUrls[shipment.trackingNumbers.indexOf(tn)] ?? shipment.trackingUrls[0])
    : null;
  const plan = planFulfillment(
    before,
    lines,
    tn ? { number: tn, company: shipment.carrier, url: url ?? null } : null,
    // No shipping e-mail without a tracking number; the TRACKING update notifies later.
    tn ? ctx.notifyCustomer : false,
  );
  if (!plan.ok) return final(await ctx.failVisibly(plan.reason));
  const key: ReadBackKey | null = tn
    ? null
    : (prior ?? {
        knownFulfillmentIds: (before.order?.fulfillments ?? []).map((f) => f.id),
        lines: plan.lines,
      });
  const request = json({
    mutation: FULFILLMENT_CREATE_MUTATION,
    variables: { fulfillment: plan.input },
    ...(key ? { readBack: key } : {}),
  });
  return {
    kind: "plan",
    dryRunPayload: { variables: plan.input },
    plan: {
      request,
      send: async () => {
        const answer = await ctx.writer.query(
          FULFILLMENT_CREATE_MUTATION,
          { fulfillment: plan.input },
          FulfillmentCreateSchema,
        );
        const p = answer.fulfillmentCreate;
        if (!p?.fulfillment || p.userErrors.length)
          return {
            ok: false,
            reason: userErrorText(p?.userErrors) || "no fulfillment returned",
            response: p,
          };
        return { ok: true, gid: p.fulfillment.id, response: p };
      },
      confirm: async () => {
        const after = await read();
        if (tn) {
          const found = existingFulfillment(after, tn);
          const failedAfter = failedFulfillment(after, tn);
          if (!found && failedAfter)
            throw new ConfirmFailure(`shopify_fulfillment_${failedAfter.status.toLowerCase()}`, failedAfter);
          return found ? { gid: found.id, response: found } : null;
        }
        return findOurs(after, key!);
      },
    },
  };
}
const FAILED = new Set(["ERROR", "FAILURE"]);

/** Reads the target fulfillment; a missing / cancelled one is an operator task. */
async function targetState(ctx: KindContext): Promise<WriteBackState["fulfillment"] | Prepared> {
  const state = await readState(ctx.reader, ctx.target!);
  if (!state.fulfillment) return final(await ctx.failVisibly("shopify_fulfillment_not_found"));
  if (state.fulfillment.status === "CANCELLED")
    return final(await ctx.failVisibly("shopify_fulfillment_cancelled", state.fulfillment));
  return state.fulfillment;
}
const isPrepared = (x: unknown): x is Prepared =>
  !!x && typeof x === "object" && "kind" in x && (x.kind === "final" || x.kind === "plan");

/** TRACKING: fulfillmentTrackingInfoUpdate of the shipment's Shopify fulfillment with the new number. */
async function prepareTracking(ctx: KindContext): Promise<Prepared> {
  const { row } = ctx;
  const shipment = await systemDb().fulfillment.findUniqueOrThrow({
    where: { id: row.fulfillmentId },
    select: { carrier: true, trackingNumbers: true, trackingUrls: true },
  });
  const i = shipment.trackingNumbers.indexOf(row.value);
  const tracking = trackingInput({
    number: row.value,
    company: shipment.carrier,
    url: (i >= 0 ? shipment.trackingUrls[i] : undefined) ?? null,
  });
  const has = (f: NonNullable<WriteBackState["fulfillment"]>) =>
    f.trackingInfo.some((t) => t.number === row.value);
  if (ctx.mode === "LIVE") {
    const before = await targetState(ctx);
    if (isPrepared(before)) return before;
    if (before && has(before)) return final(await ctx.alreadyThere(before.id, before));
  }
  const variables = {
    fulfillmentId: ctx.target ?? NO_TARGET,
    trackingInfoInput: tracking,
    notifyCustomer: ctx.notifyCustomer,
  };
  return {
    kind: "plan",
    dryRunPayload: { variables },
    plan: {
      request: json({ mutation: FULFILLMENT_TRACKING_UPDATE_MUTATION, variables }),
      send: async () => {
        const answer = await ctx.writer.query(
          FULFILLMENT_TRACKING_UPDATE_MUTATION,
          variables,
          FulfillmentTrackingUpdateSchema,
        );
        const p = answer.fulfillmentTrackingInfoUpdate;
        if (!p?.fulfillment || p.userErrors.length)
          return {
            ok: false,
            reason: userErrorText(p?.userErrors) || "no fulfillment returned",
            response: p,
          };
        return { ok: true, gid: p.fulfillment.id, response: p };
      },
      confirm: async () => {
        const after = await readState(ctx.reader, ctx.target!);
        return after.fulfillment && has(after.fulfillment)
          ? { gid: after.fulfillment.id, response: after.fulfillment }
          : null;
      },
    },
  };
}

/** EVENT: fulfillmentEventCreate with the FulfillmentEventStatus of our shipment status. */
async function prepareEvent(ctx: KindContext): Promise<Prepared> {
  const { row } = ctx;
  const status = row.value as ShopifyEventStatus;
  const shipment = await systemDb().fulfillment.findUniqueOrThrow({
    where: { id: row.fulfillmentId },
    select: { shippedAt: true, deliveredAt: true },
  });
  const has = (f: NonNullable<WriteBackState["fulfillment"]>) =>
    f.events.nodes.some((e) => e.status === status);
  if (ctx.mode === "LIVE") {
    const before = await targetState(ctx);
    if (isPrepared(before)) return before;
    if (before && has(before)) return final(await ctx.alreadyThere(before.id, before.events));
    // Shopify already shows a final status (DELIVERED / FAILURE, ours or the carrier's): an earlier one is not
    // reported after it.
    const later = before?.events.nodes.find(
      (e) => e.status !== status && (EVENT_RANK[e.status as ShopifyEventStatus] ?? 0) > EVENT_RANK[status],
    );
    if (later) {
      const s = await ctx.finalize({ lastError: `superseded_by_${later.status.toLowerCase()}` }, "REFUSED");
      if (s === "REFUSED") await event(row, "refused", { lastError: `superseded_by_${later.status}` });
      return final(s);
    }
  }
  const happenedAt =
    (status === "DELIVERED" ? shipment.deliveredAt : status === "IN_TRANSIT" ? shipment.shippedAt : null) ??
    row.createdAt;
  const variables = {
    fulfillmentEvent: {
      fulfillmentId: ctx.target ?? NO_TARGET,
      status,
      happenedAt: happenedAt.toISOString(),
    },
  };
  return {
    kind: "plan",
    dryRunPayload: { variables },
    plan: {
      request: json({ mutation: FULFILLMENT_EVENT_CREATE_MUTATION, variables }),
      send: async () => {
        const answer = await ctx.writer.query(
          FULFILLMENT_EVENT_CREATE_MUTATION,
          variables,
          FulfillmentEventCreateSchema,
        );
        const p = answer.fulfillmentEventCreate;
        if (!p?.fulfillmentEvent || p.userErrors.length)
          return { ok: false, reason: userErrorText(p?.userErrors) || "no event returned", response: p };
        return { ok: true, gid: ctx.target!, response: p };
      },
      confirm: async () => {
        const after = await readState(ctx.reader, ctx.target!);
        return after.fulfillment && has(after.fulfillment)
          ? { gid: after.fulfillment.id, response: after.fulfillment.events }
          : null;
      },
    },
  };
}

/** Timeline + audit entry for every write-back outcome that matters (INTEGRATION_NOTES §6). */
async function event(
  row: RowRef,
  what: "sent" | "dry_run" | "already_sent" | "failed" | "uncertain" | "refused",
  payload: unknown,
) {
  await systemDb().fulfillmentEvent.create({
    data: {
      accountId: row.accountId,
      fulfillmentId: row.fulfillmentId,
      occurredAt: new Date(),
      source: "shopify.writeback",
      rawStatus: row.kind === "FULFIL" ? what : `${row.kind.toLowerCase()}.${what}`,
      payload: json(payload),
    },
  });
  await recordAudit({
    accountId: row.accountId,
    action: `shopify.writeback.${what}`,
    entityType: "ShopifyWriteBack",
    entityId: row.id,
    after: {
      kind: row.kind,
      value: row.value,
      trackingNumber: row.trackingNumber,
      result: payload as Record<string, unknown>,
    },
  });
}

/** Write-back rows of one order for the order page (the caller has already checked the order's scope). */
export function orderWriteBacks(accountId: string, orderId: string) {
  return accountDb(accountId).shopifyWriteBack.findMany({
    where: { orderId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      kind: true,
      value: true,
      status: true,
      evaluatedMode: true,
      trackingNumber: true,
      request: true,
      lastResponse: true,
      lastError: true,
      shopifyFulfillmentGid: true,
      sentAt: true,
      updatedAt: true,
    },
  });
}
