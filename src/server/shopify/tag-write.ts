import type { OutboundStatus, Prisma } from "@/generated/prisma/client";
import type { ShopifyClient } from "@/integrations/shopify/client";
import { ShopifyError } from "@/integrations/shopify/errors";
import { isDefiniteGraphqlRejection } from "@/integrations/shopify/fulfillments";
import {
  applyTagChange,
  ORDER_TAGS_ADD_MUTATION,
  ORDER_TAGS_READ_QUERY,
  ORDER_TAGS_REMOVE_MUTATION,
  OrderTagsAddSchema,
  OrderTagsReadSchema,
  OrderTagsRemoveSchema,
  tagDelta,
} from "@/integrations/shopify/order-tags";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import { recordAudit } from "@/server/audit";
import { systemDb, withSystemTransaction } from "@/server/db/client";
import type { StoreClientFactory } from "@/server/fulfill/writeback";
import { globalOutboxPaused } from "@/server/outbox/outbox";
import { shopifyClientForStore } from "@/server/shopify/store-client";
import { SHOPIFY_TEST_TAG, transition } from "@/server/pipeline";
import { syncStockWait } from "@/server/stock/waiting";

/**
 * Order tags → Shopify (ShopifyTagWrite: remove some tags, add others; "Липсващи артикули", owner request
 * 2026-11-10). The SENDER is the mode gate, on the store's CURRENT writeBackMode ("Записване в Shopify"):
 *   READ_ONLY → REFUSED (nothing read or sent); DRY_RUN → the exact mutations recorded, nothing sent;
 *   LIVE → read the order's tags, send only what still differs (tagsRemove, then tagsAdd).
 * Account kill switch / global pause park the row as PAUSED. Both mutations are idempotent, so an unclear answer
 * is simply tried again later (the next attempt reads first). After SENT our copy of the order's tags follows and
 * the missing-stock flow is updated; the orders/updated webhook then brings the order itself up to date (e.g. the
 * confirmation tag moves it from "Чака таг" into review).
 */

export const TAG_WRITE_MAX_ATTEMPTS = 5;
export const TAG_WRITE_STALE_MS = 10 * 60_000;
const backoffMs = (attempt: number) => Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;
const OPEN = ["PENDING", "SENDING", "PAUSED"] as const;
const TAGS_FAILED_TASK = "shopify_tags_failed";

const defaultClients: StoreClientFactory = (accountId, storeId, opts) =>
  shopifyClientForStore(accountId, storeId, opts);

type Row = {
  id: string;
  accountId: string;
  storeId: string;
  orderId: string;
  add: string[];
  remove: string[];
  createdById: string | null;
  order: { shopifyOrderGid: string | null; number: string };
};
type Claim =
  | { kind: "skip" }
  | { kind: "done"; status: OutboundStatus; accountId: string }
  | { kind: "go"; attempts: number; row: Row };

async function audit(row: { id: string; accountId: string; orderId: string }, what: string, after: object) {
  await recordAudit({
    accountId: row.accountId,
    action: `shopify.tags.${what}`,
    entityType: "Order",
    entityId: row.orderId,
    after: { tagWriteId: row.id, ...after },
  });
}

async function openTask(accountId: string, orderId: string, title: string, body: string) {
  const db = systemDb();
  const kind = TAGS_FAILED_TASK;
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
      severity: "WARNING",
      title,
      body: body.slice(0, 2000),
      entityType: "Order",
      entityId: orderId,
    },
  });
}

/** The two mutations a change needs (DRY_RUN records exactly these). */
const requestOf = (gid: string, add: string[], remove: string[]) => ({
  ...(remove.length
    ? { remove: { mutation: ORDER_TAGS_REMOVE_MUTATION, variables: { id: gid, tags: remove } } }
    : {}),
  ...(add.length ? { add: { mutation: ORDER_TAGS_ADD_MUTATION, variables: { id: gid, tags: add } } } : {}),
});

/** Processes one row. Safe to call concurrently and repeatedly (row lock + status machine). */
export async function processTagWrite(
  id: string,
  clients: StoreClientFactory = defaultClients,
  now: Date = new Date(),
): Promise<OutboundStatus | "skipped"> {
  const claim: Claim = await withSystemTransaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "ShopifyTagWrite" WHERE id = ${id} FOR UPDATE SKIP LOCKED`;
    if (locked.length === 0) return { kind: "skip" };
    const row = await tx.shopifyTagWrite.findUniqueOrThrow({
      where: { id },
      include: {
        store: { select: { writeBackMode: true } },
        account: { select: { outboxPaused: true } },
        order: { select: { shopifyOrderGid: true, number: true } },
      },
    });
    if (row.status !== "PENDING" && row.status !== "PAUSED") return { kind: "skip" };
    if (row.nextAttemptAt && row.nextAttemptAt > now) return { kind: "skip" };
    // An earlier change of the same order goes first (they apply in the order they were asked for).
    const earlier = await tx.shopifyTagWrite.count({
      where: {
        accountId: row.accountId,
        orderId: row.orderId,
        status: { in: [...OPEN] },
        OR: [{ createdAt: { lt: row.createdAt } }, { createdAt: row.createdAt, id: { lt: row.id } }],
      },
    });
    if (earlier) return { kind: "skip" };
    const mode = row.store.writeBackMode;
    if (globalOutboxPaused() || row.account.outboxPaused) {
      await tx.shopifyTagWrite.update({
        where: { id },
        data: { status: "PAUSED", evaluatedMode: mode, lastError: "paused" },
      });
      return { kind: "done", status: "PAUSED", accountId: row.accountId };
    }
    if (mode === "READ_ONLY") {
      await tx.shopifyTagWrite.update({
        where: { id },
        data: { status: "REFUSED", evaluatedMode: mode, lastError: "store_read_only" },
      });
      return { kind: "done", status: "REFUSED", accountId: row.accountId };
    }
    if (!row.order.shopifyOrderGid) {
      await tx.shopifyTagWrite.update({
        where: { id },
        data: { status: "REFUSED", evaluatedMode: mode, lastError: "not_a_shopify_order" },
      });
      return { kind: "done", status: "REFUSED", accountId: row.accountId };
    }
    if (mode === "DRY_RUN") {
      await tx.shopifyTagWrite.update({
        where: { id },
        data: {
          status: "DRY_RUN_RECORDED",
          evaluatedMode: mode,
          request: json(requestOf(row.order.shopifyOrderGid, row.add, row.remove)),
          lastError: null,
        },
      });
      return { kind: "done", status: "DRY_RUN_RECORDED", accountId: row.accountId };
    }
    const attempts = row.attempts + 1;
    await tx.shopifyTagWrite.update({
      where: { id },
      data: { status: "SENDING", evaluatedMode: mode, attempts, lockedAt: now, lastError: null },
    });
    return { kind: "go", attempts, row };
  });
  if (claim.kind === "skip") return "skipped";
  if (claim.kind === "done") {
    if (claim.status !== "PAUSED") {
      const r = await systemDb().shopifyTagWrite.findFirstOrThrow({
        where: { id, accountId: claim.accountId },
      });
      await audit(r, claim.status === "REFUSED" ? "refused" : "dry_run", {
        add: r.add,
        remove: r.remove,
        lastError: r.lastError,
      });
    }
    return claim.status;
  }
  return run(claim, clients, now);
}

async function run(claim: Extract<Claim, { kind: "go" }>, clients: StoreClientFactory, now: Date) {
  const db = systemDb();
  const { row } = claim;
  const gid = row.order.shopifyOrderGid!;
  const finalize = async (data: Prisma.ShopifyTagWriteUpdateManyMutationInput, status: OutboundStatus) => {
    const res = await db.shopifyTagWrite.updateMany({
      where: { id: row.id, accountId: row.accountId, status: "SENDING" },
      data: { ...data, status },
    });
    return res.count === 1 ? status : currentStatus(row);
  };
  const fail = async (reason: string) => {
    const s = await finalize({ lastError: reason }, "FAILED");
    if (s === "FAILED") {
      await openTask(
        row.accountId,
        row.orderId,
        `Shopify: the tags of order ${row.order.number} could not be changed`,
        reason,
      );
      await audit(row, "failed", { add: row.add, remove: row.remove, lastError: reason });
    }
    return s;
  };
  const retryLater = (detail: string) =>
    claim.attempts >= TAG_WRITE_MAX_ATTEMPTS
      ? fail(`max attempts: ${detail}`)
      : finalize(
          { lastError: detail, nextAttemptAt: new Date(now.getTime() + backoffMs(claim.attempts)) },
          "PENDING",
        );

  let client: ShopifyClient;
  try {
    client = (await clients(row.accountId, row.storeId, { maxRetries: 0 })).client;
  } catch (err) {
    return fail(`no Shopify client: ${scrubText((err as Error).message)}`);
  }
  const definite = (err: unknown) =>
    err instanceof ShopifyError &&
    (err.code === "auth_failed" ||
      // Throttled is not a refusal of this change: tried again later.
      (err.code === "graphql_error" &&
        !err.graphqlCodes.includes("THROTTLED") &&
        isDefiniteGraphqlRejection(err.graphqlCodes)));

  let current: string[];
  try {
    const r = await client.query(ORDER_TAGS_READ_QUERY, { id: gid }, OrderTagsReadSchema);
    if (!r.order) return fail("order_not_found");
    current = r.order.tags;
  } catch (err) {
    if (definite(err)) return fail(`${(err as ShopifyError).code}: ${scrubText((err as Error).message)}`);
    return retryLater(`read failed: ${scrubText((err as Error).message)}`);
  }
  const delta = tagDelta(current, row.add, row.remove);
  await db.shopifyTagWrite.updateMany({
    where: { id: row.id, accountId: row.accountId, status: "SENDING" },
    data: { request: json(requestOf(gid, delta.add, delta.remove)) },
  });
  // Add first, then remove: a failure in between leaves both tags (waiting_for_stock wins over out_of_stock, the
  // confirmation tag next to waiting_for_stock is harmless), never an order with no tag of the flow at all.
  const applied = { add: [] as string[], remove: [] as string[] };
  let failure: string | null = null;
  try {
    if (delta.add.length) {
      const r = await client.query(ORDER_TAGS_ADD_MUTATION, { id: gid, tags: delta.add }, OrderTagsAddSchema);
      const errs = r.tagsAdd?.userErrors ?? [];
      if (!r.tagsAdd || errs.length)
        failure = `rejected: ${scrubText(errs.map((e) => e.message).join("; ") || "no result returned")}`;
      else applied.add = delta.add;
    }
    if (!failure && delta.remove.length) {
      const r = await client.query(
        ORDER_TAGS_REMOVE_MUTATION,
        { id: gid, tags: delta.remove },
        OrderTagsRemoveSchema,
      );
      const errs = r.tagsRemove?.userErrors ?? [];
      if (!r.tagsRemove || errs.length)
        failure = `rejected: ${scrubText(errs.map((e) => e.message).join("; ") || "no result returned")}`;
      else applied.remove = delta.remove;
    }
  } catch (err) {
    const detail = scrubText((err as Error).message);
    // A missing write_orders scope is a definite rejection (ACCESS_DENIED): an operator task, not five retries.
    if (definite(err)) failure = `${(err as ShopifyError).code}: ${detail}`;
    else {
      logger.warn({ tagWriteId: row.id, err: detail }, "shopify tag change outcome unknown");
      if (applied.add.length) await followLocally(row, applyTagChange(current, applied.add, []));
      return retryLater(detail); // idempotent: the next attempt reads first and sends what still differs
    }
  }
  if (failure) {
    // What did reach Shopify is kept in our copy too.
    if (applied.add.length) await followLocally(row, applyTagChange(current, applied.add, []));
    return fail(failure);
  }
  const tags = applyTagChange(current, row.add, row.remove);
  const status = await withSystemTransaction(async (tx) => {
    const res = await tx.shopifyTagWrite.updateMany({
      where: { id: row.id, accountId: row.accountId, status: "SENDING" },
      data: {
        status: "SENT",
        sentAt: now,
        lastError: delta.add.length || delta.remove.length ? null : "already_set",
      },
    });
    if (res.count !== 1) return null;
    const left = await followLocally(row, tags, tx);
    // "Потвърди" on an order a person held until the stock came (e.g. "чака наличност"): with the confirmation tag
    // in Shopify now, it is released into review in the name of the person who confirmed.
    if (left && row.createdById) await releaseConfirmedHold(tx, row);
    // An earlier failure of this order's tags is settled now.
    await tx.alert.updateMany({
      where: {
        accountId: row.accountId,
        kind: TAGS_FAILED_TASK,
        entityType: "Order",
        entityId: row.orderId,
        status: { not: "RESOLVED" },
      },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    return "SENT" as const;
  });
  if (!status) return currentStatus(row);
  await audit(row, "sent", { add: delta.add, remove: delta.remove });
  return status;
}

/**
 * "Потвърди" on an order a person held until its stock came: with the confirmation tag in Shopify now, it is released
 * into review in the name of the person who confirmed. Only a hold older than that click (a hold put on after it, for
 * whatever reason, stays); a release the pipeline refuses becomes a task instead of disappearing.
 */
async function releaseConfirmedHold(
  tx: Prisma.TransactionClient,
  row: {
    id: string;
    accountId: string;
    orderId: string;
    createdById: string | null;
    order: { number: string };
  },
) {
  const order = await tx.order.findFirst({
    where: { id: row.orderId, accountId: row.accountId },
    select: { status: true },
  });
  if (order?.status !== "ON_HOLD") return;
  const write = await tx.shopifyTagWrite.findFirst({
    where: { id: row.id, accountId: row.accountId },
    select: { createdAt: true },
  });
  const held = await tx.orderEvent.findFirst({
    where: { accountId: row.accountId, orderId: row.orderId, toStatus: "ON_HOLD" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!write || (held && held.createdAt > write.createdAt)) return;
  const r = await transition(tx, {
    orderId: row.orderId,
    to: "IMPORTED",
    cause: "release",
    actor: { kind: "user", userId: row.createdById! },
    source: "stock_wait",
    reason: "items back in stock, confirmed",
    mode: "follow",
  });
  if (r.changed) return;
  await tx.alert.create({
    data: {
      accountId: row.accountId,
      kind: "stock_wait_release_refused",
      isTask: true,
      severity: "WARNING",
      title: `Order ${row.order.number}: confirmed (items back in stock) but still held — release it by hand`,
      body: `refused: ${r.reason ?? "unknown"}${r.guard ? ` (${r.guard})` : ""}`,
      entityType: "Order",
      entityId: row.orderId,
    },
  });
}

const currentStatus = async (row: { id: string; accountId: string }) =>
  (await systemDb().shopifyTagWrite.findFirstOrThrow({ where: { id: row.id, accountId: row.accountId } }))
    .status;

/**
 * Our copy of the order's tags follows Shopify's (the orders/updated webhook confirms it a moment later), and the
 * missing-stock flow follows the tags. Under the import's lock of this order, so an import running at the same
 * moment never writes the older tags back over these.
 */
async function followLocally(
  row: { accountId: string; storeId: string; orderId: string; order: { shopifyOrderGid: string | null } },
  tags: string[],
  tx?: Prisma.TransactionClient,
) {
  const apply = async (t: Prisma.TransactionClient) => {
    const key = `${row.accountId}:shopify-order:${row.storeId}:${row.order.shopifyOrderGid}`;
    await t.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))) l`;
    const order = await t.order.findFirst({
      where: { id: row.orderId, accountId: row.accountId },
      select: { raw: true, tags: true },
    });
    if (!order) return;
    const raw =
      order.raw && typeof order.raw === "object" && !Array.isArray(order.raw)
        ? { ...order.raw, tags }
        : order.raw;
    // Our own marker of a Shopify test order is not a Shopify tag: it stays (the import adds it the same way).
    const ours = order.tags.includes(SHOPIFY_TEST_TAG) ? [...tags, SHOPIFY_TEST_TAG] : tags;
    await t.order.updateMany({
      where: { id: row.orderId, accountId: row.accountId },
      data: { tags: ours, ...(raw ? { raw: json(raw) } : {}) },
    });
    const before = await t.orderStockWait.findFirst({
      where: { accountId: row.accountId, orderId: row.orderId },
      select: { id: true },
    });
    const stage = await syncStockWait(t, row.accountId, row.orderId);
    return !!before && !stage;
  };
  return tx ? apply(tx) : withSystemTransaction(apply);
}

/** Due rows (all accounts, worker): crashed sends back to PENDING (idempotent, read first), then everything ready. */
export async function sweepTagWrites(now: Date = new Date(), limit = 200) {
  const db = systemDb();
  const stale = await db.shopifyTagWrite.updateMany({
    where: { status: "SENDING", lockedAt: { lt: new Date(now.getTime() - TAG_WRITE_STALE_MS) } },
    data: { status: "PENDING", lastError: "worker stopped during the Shopify call" },
  });
  const ready = await db.shopifyTagWrite.findMany({
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
  return { stale: stale.count, ready: ready.map((r) => r.id) };
}
