import type { OutboundStatus, Prisma } from "@/generated/prisma/client";
import type { ShopifyClient } from "@/integrations/shopify/client";
import { ShopifyError } from "@/integrations/shopify/errors";
import { isDefiniteGraphqlRejection } from "@/integrations/shopify/fulfillments";
import {
  VARIANT_WEIGHT_READ_QUERY,
  VARIANT_WEIGHT_UPDATE_MUTATION,
  VariantWeightReadSchema,
  VariantWeightUpdateSchema,
  variantWeightVariables,
  weightToGrams,
  type VariantWeightRead,
} from "@/integrations/shopify/weights";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import { recordAudit } from "@/server/audit";
import { systemDb, withSystemTransaction } from "@/server/db/client";
import type { StoreClientFactory } from "@/server/fulfill/writeback";
import { globalOutboxPaused } from "@/server/outbox/outbox";
import { shopifyClientForStore } from "@/server/shopify/store-client";

/**
 * Product weight → Shopify (ShopifyWeightWrite, one row per (variant, weight)). The SENDER is the mode gate,
 * evaluated at send time on the store's CURRENT weightWriteMode ("Тегло към Shopify"):
 *   DISABLED → REFUSED (nothing read, nothing sent);
 *   DRY_RUN  → the exact mutation + variables are recorded (no Shopify call at all);
 *   LIVE     → read the variant back; equal weight = done; otherwise productVariantsBulkUpdate (client never
 *              retries by itself), and an unclear answer is resolved by reading back again.
 * Account kill switch / global pause park the row as PAUSED. Setting a weight is idempotent at Shopify (the
 * same value twice changes nothing), so an unclear outcome is retried after the read-back, never duplicated.
 * `offlineOnly` lets the web app run the gate for outcomes that never touch Shopify (DISABLED, DRY_RUN, pause)
 * right after a person saves — a LIVE row is left for the worker (no Shopify call from a route handler).
 */

export const WEIGHT_WRITE_MAX_ATTEMPTS = 5;
export const WEIGHT_WRITE_STALE_MS = 10 * 60_000;
const backoffMs = (attempt: number) => Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

const defaultClients: StoreClientFactory = (accountId, storeId, opts) =>
  shopifyClientForStore(accountId, storeId, opts);

type Row = {
  id: string;
  accountId: string;
  storeId: string;
  productId: string;
  weightGrams: number;
  variantLink: { shopifyVariantGid: string; shopifyProductGid: string };
};

type Claim =
  { kind: "skip" } | { kind: "done"; status: OutboundStatus } | { kind: "go"; attempts: number; row: Row };

async function audit(
  row: { id: string; accountId: string; productId: string },
  what: string,
  after: unknown,
) {
  await recordAudit({
    accountId: row.accountId,
    action: `shopify.weight.${what}`,
    entityType: "Product",
    entityId: row.productId,
    after: { writeId: row.id, ...(after as Record<string, unknown>) },
  });
}

async function openTask(accountId: string, productId: string, title: string, body: string) {
  const db = systemDb();
  const kind = "shopify_weight_failed";
  const open = await db.alert.findFirst({
    where: { accountId, kind, entityType: "Product", entityId: productId, status: { not: "RESOLVED" } },
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
      entityType: "Product",
      entityId: productId,
    },
  });
}

/** Processes one row. Safe to call concurrently and repeatedly (row lock + status machine). */
export async function processWeightWrite(
  id: string,
  clients: StoreClientFactory = defaultClients,
  now: Date = new Date(),
  opts: { offlineOnly?: boolean } = {},
): Promise<OutboundStatus | "skipped"> {
  const claim: Claim = await withSystemTransaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "ShopifyWeightWrite" WHERE id = ${id} FOR UPDATE SKIP LOCKED`;
    if (locked.length === 0) return { kind: "skip" };
    const row = await tx.shopifyWeightWrite.findUniqueOrThrow({
      where: { id },
      include: {
        store: { select: { weightWriteMode: true } },
        account: { select: { outboxPaused: true } },
        variantLink: { select: { shopifyVariantGid: true, shopifyProductGid: true } },
      },
    });
    if (row.status !== "PENDING" && row.status !== "PAUSED") return { kind: "skip" };
    if (row.nextAttemptAt && row.nextAttemptAt > now) return { kind: "skip" };
    const mode = row.store.weightWriteMode;
    if (globalOutboxPaused() || row.account.outboxPaused) {
      await tx.shopifyWeightWrite.update({
        where: { id },
        data: { status: "PAUSED", evaluatedMode: mode, lastError: "paused" },
      });
      return { kind: "done", status: "PAUSED" };
    }
    if (mode === "DISABLED") {
      await tx.shopifyWeightWrite.update({
        where: { id },
        data: { status: "REFUSED", evaluatedMode: mode, lastError: "weight_write_disabled" },
      });
      return { kind: "done", status: "REFUSED" };
    }
    if (mode === "DRY_RUN") {
      const request = json({
        mutation: VARIANT_WEIGHT_UPDATE_MUTATION,
        variables: variantWeightVariables(
          row.variantLink.shopifyProductGid,
          row.variantLink.shopifyVariantGid,
          row.weightGrams,
        ),
      });
      await tx.shopifyWeightWrite.update({
        where: { id },
        data: { status: "DRY_RUN_RECORDED", evaluatedMode: mode, request, lastError: null },
      });
      return { kind: "done", status: "DRY_RUN_RECORDED" };
    }
    if (opts.offlineOnly) return { kind: "skip" };
    const attempts = row.attempts + 1;
    await tx.shopifyWeightWrite.update({
      where: { id },
      data: { status: "SENDING", evaluatedMode: mode, attempts, lockedAt: now, lastError: null },
    });
    return { kind: "go", attempts, row };
  });
  if (claim.kind === "skip") return "skipped";
  if (claim.kind === "done") {
    if (claim.status !== "PAUSED") {
      const r = await systemDb().shopifyWeightWrite.findUniqueOrThrow({ where: { id } });
      await audit(r, claim.status === "REFUSED" ? "refused" : "dry_run", {
        weightGrams: r.weightGrams,
        storeId: r.storeId,
        request: r.request,
      });
    }
    return claim.status;
  }
  return run(claim, clients, now);
}

async function run(claim: Extract<Claim, { kind: "go" }>, clients: StoreClientFactory, now: Date) {
  const db = systemDb();
  const { row } = claim;
  const finalize = async (data: Prisma.ShopifyWeightWriteUpdateManyMutationInput, status: OutboundStatus) => {
    const res = await db.shopifyWeightWrite.updateMany({
      where: { id: row.id, status: "SENDING" },
      data: { ...data, status },
    });
    return res.count === 1
      ? status
      : (await db.shopifyWeightWrite.findUniqueOrThrow({ where: { id: row.id } })).status;
  };
  const fail = async (reason: string, response?: unknown) => {
    const s = await finalize({ lastError: reason, lastResponse: json(response) }, "FAILED");
    if (s === "FAILED") {
      await openTask(row.accountId, row.productId, "Shopify: the product weight could not be set", reason);
      await audit(row, "failed", { weightGrams: row.weightGrams, lastError: reason });
    }
    return s;
  };
  const retryLater = (detail: string) =>
    claim.attempts >= WEIGHT_WRITE_MAX_ATTEMPTS
      ? fail(`max attempts: ${detail}`)
      : finalize(
          { lastError: detail, nextAttemptAt: new Date(now.getTime() + backoffMs(claim.attempts)) },
          "PENDING",
        );
  const done = async (response: unknown, note: string | null) => {
    const s = await finalize({ sentAt: now, lastResponse: json(response), lastError: note }, "SENT");
    if (s === "SENT") await audit(row, "sent", { weightGrams: row.weightGrams, note });
    return s;
  };

  let reader: ShopifyClient;
  let writer: ShopifyClient;
  try {
    reader = (await clients(row.accountId, row.storeId, {})).client;
    writer = (await clients(row.accountId, row.storeId, { maxRetries: 0 })).client;
  } catch (err) {
    return fail(`no Shopify client: ${scrubText((err as Error).message)}`);
  }
  const read = () =>
    reader.query(
      VARIANT_WEIGHT_READ_QUERY,
      { id: row.variantLink.shopifyVariantGid },
      VariantWeightReadSchema,
    ) as Promise<VariantWeightRead>;
  const gramsOf = (r: VariantWeightRead) =>
    weightToGrams(r.productVariant?.inventoryItem.measurement?.weight ?? null);

  let before: VariantWeightRead;
  try {
    before = await read();
  } catch (err) {
    return retryLater(`read failed: ${scrubText((err as Error).message)}`);
  }
  if (!before.productVariant) return fail("variant_not_found");
  if (gramsOf(before) === row.weightGrams) return done(before.productVariant, "already_set");

  const variables = variantWeightVariables(
    before.productVariant.product.id,
    row.variantLink.shopifyVariantGid,
    row.weightGrams,
  );
  await db.shopifyWeightWrite.updateMany({
    where: { id: row.id, status: "SENDING" },
    data: { request: json({ mutation: VARIANT_WEIGHT_UPDATE_MUTATION, variables }) },
  });
  let answer;
  try {
    answer = await writer.query(VARIANT_WEIGHT_UPDATE_MUTATION, variables, VariantWeightUpdateSchema);
  } catch (err) {
    const detail = scrubText((err as Error).message);
    if (
      err instanceof ShopifyError &&
      (err.code === "auth_failed" ||
        (err.code === "graphql_error" && isDefiniteGraphqlRejection(err.graphqlCodes)))
    )
      return fail(`${err.code}: ${detail}`);
    logger.warn({ weightWriteId: row.id, err: detail }, "shopify weight update outcome unknown");
    try {
      const after = await read();
      if (after.productVariant && gramsOf(after) === row.weightGrams)
        return done(after.productVariant, `recovered by read-back after: ${detail}`);
    } catch {
      // fall through: not known to be set, try again later (setting a weight twice is harmless)
    }
    return retryLater(detail);
  }
  const payload = answer.productVariantsBulkUpdate;
  if (!payload || payload.userErrors.length) {
    const reason = payload?.userErrors.map((e) => e.message).join("; ") || "no result returned";
    return fail(`rejected: ${scrubText(reason)}`, payload);
  }
  return done(payload, null);
}

/** Due rows (all accounts, worker): crashed sends back to PENDING (idempotent), then everything ready. */
export async function sweepWeightWrites(now: Date = new Date(), limit = 200) {
  const db = systemDb();
  const stale = await db.shopifyWeightWrite.updateMany({
    where: { status: "SENDING", lockedAt: { lt: new Date(now.getTime() - WEIGHT_WRITE_STALE_MS) } },
    data: { status: "PENDING", lastError: "worker stopped during the Shopify call" },
  });
  const ready = await db.shopifyWeightWrite.findMany({
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
  return { stale: stale.count, ready: ready.map((r) => r.id) };
}
