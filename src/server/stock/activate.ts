import type { OutboundStatus, Prisma } from "@/generated/prisma/client";
import type { ShopifyClient } from "@/integrations/shopify/client";
import { ShopifyError } from "@/integrations/shopify/errors";
import { isDefiniteGraphqlRejection } from "@/integrations/shopify/fulfillments";
import {
  ACTIVATE_BATCH,
  ACTIVATE_MUTATION,
  ActivatePayload,
  activationIdempotencyKey,
  READBACK_QUERY,
  ReadBack,
  type ActivateVariables,
} from "@/integrations/shopify/inventory";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, systemDb, withAccountTransaction, withSystemTransaction } from "@/server/db/client";
import { globalOutboxPaused } from "@/server/outbox/outbox";
import { shopifyClientForStore } from "@/server/shopify/store-client";
import type { ScopedActor } from "@/server/stores";
import type { PushClients } from "./push";

/**
 * "Активирай продуктите в тази локация" (owner request 2026-11-03, INTEGRATION_NOTES §6). A linked variant whose
 * Shopify inventory item is not stocked at a mapped location is skipped by the push (not_stocked_at_location); this
 * stocks it there with inventoryActivate — without available/onHand, so the level starts at 0 and the next push
 * sets the warehouse number. Why inventoryActivate and not inventoryBulkToggleActivation: the bulk one toggles ONE
 * item across many locations (we need many items at one location, so it batches nothing for us), it can also
 * DEACTIVATE (which removes stock at a location), and its reference does not document @idempotent; inventoryActivate
 * only creates a level and its 2026-10 reference documents the required @idempotent key with an exact example.
 *
 * Outbox discipline as the push (src/server/stock/push.ts):
 *  - the sender evaluates the store's CURRENT inventoryPushMode at send time: DISABLED → REFUSED (nothing read or
 *    sent), DRY_RUN → the exact requests (built at creation, shown on the page) are recorded, nothing sent, LIVE →
 *    sent — but only when the owner also confirmed it in LIVE (createdMode): a job confirmed as a dry run whose
 *    store was raised to LIVE meanwhile is REFUSED (mode_raised_after_confirm), the owner clicks again; the account
 *    kill switch / OUTBOX_PAUSED park it as PAUSED; an unmapped location is REFUSED;
 *  - Shopify throttling (THROTTLED / HTTP 429: the request was not executed) stops the run and re-arms it shortly
 *    with the same keys without spending an attempt; lockedAt is refreshed per item (a long run is not re-armed
 *    under a live worker) and a worker whose claim was taken over stops;
 *  - claimed under a row lock (double processing is skipped); at most one open job per store + location;
 *  - every item carries a deterministic @idempotent key per (store, item, location); the write client never
 *    retries by itself; an unknown outcome is resolved by reading the item's level at the location back;
 *  - an item that already has a level there is a success ("already"), never an error.
 */

export const ACTIVATION_MAX_ATTEMPTS = 5;
export const ACTIVATION_STALE_MS = 10 * 60_000;
/** Delay before a throttled run continues (Shopify restores 100+ points/s; one inventoryActivate costs 10). */
export const THROTTLE_BACKOFF_MS = 30_000;
const OPEN: OutboundStatus[] = ["PENDING", "SENDING", "PAUSED"];
const backoffMs = (attempt: number) => Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

const defaultClients: PushClients = (accountId, storeId, opts) =>
  shopifyClientForStore(accountId, storeId, opts);

export interface ActivationCandidate {
  variantLinkId: string;
  sku: string | null;
  title: string;
  inventoryItemGid: string;
}

/**
 * Pure: per mapped location gid, the linked variants (productId set) whose inventory item is tracked and known from
 * another location's level but has no level at this location. One entry per inventory item.
 */
export function selectActivationCandidates(
  locationGids: string[],
  links: {
    id: string;
    sku: string | null;
    title: string;
    productId: string | null;
    inventoryLevels: { locationGid: string; inventoryItemGid: string; tracked: boolean }[];
  }[],
): Map<string, ActivationCandidate[]> {
  const out = new Map<string, ActivationCandidate[]>(locationGids.map((g) => [g, []]));
  for (const link of links) {
    if (!link.productId) continue;
    const known = link.inventoryLevels[0];
    if (!known || !link.inventoryLevels.every((l) => l.tracked)) continue;
    for (const gid of locationGids) {
      if (link.inventoryLevels.some((l) => l.locationGid === gid)) continue;
      const list = out.get(gid)!;
      if (list.some((c) => c.inventoryItemGid === known.inventoryItemGid)) continue;
      list.push({
        variantLinkId: link.id,
        sku: link.sku,
        title: link.title,
        inventoryItemGid: known.inventoryItemGid,
      });
    }
  }
  return out;
}

/** Candidates of every mapped, active location of a store (keyed by Shopify location gid). */
export async function activationCandidates(accountId: string, storeId: string) {
  const db = accountDb(accountId);
  const [locations, links] = await Promise.all([
    db.storeLocation.findMany({
      where: { storeId, connectionId: { not: null }, isActive: true },
      select: { shopifyLocationGid: true },
    }),
    db.storeVariantLink.findMany({
      where: { storeId, productId: { not: null } },
      select: {
        id: true,
        sku: true,
        title: true,
        productId: true,
        inventoryLevels: {
          select: { locationGid: true, inventoryItemGid: true, tracked: true },
          orderBy: { locationGid: "asc" },
        },
      },
      orderBy: { sku: "asc" },
    }),
  ]);
  return selectActivationCandidates(
    locations.map((l) => l.shopifyLocationGid),
    links,
  );
}

export interface StoredActivationRequest {
  mutation: string;
  items: { lineId: string; variables: ActivateVariables }[];
}

/**
 * Queues the activation of every current candidate at one mapped location (OWNER only, audited). `expected` is the
 * count the owner confirmed; when the candidates changed meanwhile nothing is queued. One open job per store +
 * location (the open one is returned).
 */
export async function createInventoryActivation(
  actor: ScopedActor,
  input: { storeId: string; locationId: string; expected?: number },
  now: Date = new Date(),
) {
  assertCan(actor.role, "inventory.activate");
  const db = accountDb(actor.accountId);
  const store = await db.store.findUnique({
    where: { id: input.storeId },
    select: { id: true, companyId: true, inventoryPushMode: true, archivedAt: true },
  });
  if (!store || (actor.companyScope && (!store.companyId || !actor.companyScope.includes(store.companyId))))
    throw new DomainError("not_found");
  if (store.archivedAt) throw new DomainError("store_archived");
  if (store.inventoryPushMode === "DISABLED") throw new DomainError("inventory_push_disabled");
  const loc = await db.storeLocation.findFirst({
    where: { id: input.locationId, storeId: store.id },
    select: { shopifyLocationGid: true, connectionId: true, isActive: true },
  });
  if (!loc) throw new DomainError("not_found");
  if (!loc.connectionId || !loc.isActive) throw new DomainError("location_not_mapped");
  const gid = loc.shopifyLocationGid;
  const candidates = (await activationCandidates(actor.accountId, store.id)).get(gid) ?? [];
  const result = await withAccountTransaction(actor.accountId, async (tx, { lockKey }) => {
    await lockKey(`inventory-activation:${store.id}:${gid}`);
    const open = await tx.inventoryActivation.findFirst({
      where: { storeId: store.id, locationGid: gid, status: { in: OPEN } },
      select: { id: true },
    });
    if (open) return { activationId: open.id, created: false as const, reason: "activation_open" };
    if (candidates.length === 0)
      return { activationId: null, created: false as const, reason: "nothing_to_activate" };
    if (input.expected !== undefined && input.expected !== candidates.length)
      return { activationId: null, created: false as const, reason: "activation_count_changed" };
    const job = await tx.inventoryActivation.create({
      data: {
        accountId: actor.accountId,
        storeId: store.id,
        locationGid: gid,
        createdById: actor.userId,
        createdMode: store.inventoryPushMode,
        createdAt: now,
        lines: {
          create: candidates.map((c) => ({
            variantLinkId: c.variantLinkId,
            inventoryItemGid: c.inventoryItemGid,
            idempotencyKey: activationIdempotencyKey(store.id, c.inventoryItemGid, gid, 0),
          })),
        },
      },
      select: { id: true, lines: { select: { id: true, inventoryItemGid: true, idempotencyKey: true } } },
    });
    const request: StoredActivationRequest = {
      mutation: ACTIVATE_MUTATION,
      items: job.lines
        .sort((a, b) => a.inventoryItemGid.localeCompare(b.inventoryItemGid))
        .map((l) => ({
          lineId: l.id,
          variables: {
            inventoryItemId: l.inventoryItemGid,
            locationId: gid,
            idempotencyKey: l.idempotencyKey,
          },
        })),
    };
    await tx.inventoryActivation.update({ where: { id: job.id }, data: { request: json(request) } });
    return { activationId: job.id, created: true as const, reason: null };
  });
  if (result.created)
    await recordAudit({
      accountId: actor.accountId,
      userId: actor.userId,
      action: "inventory.activation_queued",
      entityType: "InventoryActivation",
      entityId: result.activationId!,
      after: { storeId: store.id, locationGid: gid, items: candidates.length, mode: store.inventoryPushMode },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  return { ...result, items: candidates.length };
}

type Claim =
  | { kind: "skip" }
  | { kind: "done"; status: OutboundStatus }
  | {
      kind: "go";
      attempts: number;
      row: { id: string; accountId: string; storeId: string; locationGid: string };
    };

export type ActivationResult = { status: OutboundStatus; refreshInventory: boolean } | "skipped";

async function audit(row: { id: string; accountId: string; storeId: string }, what: string, after: object) {
  await recordAudit({
    accountId: row.accountId,
    action: `inventory.activation_${what}`,
    entityType: "InventoryActivation",
    entityId: row.id,
    after: { storeId: row.storeId, ...after },
  });
}

async function openTask(accountId: string, storeId: string, body: string) {
  const db = systemDb();
  const kind = "inventory_activation_failed";
  const open = await db.alert.findFirst({
    where: { accountId, kind, entityType: "Store", entityId: storeId, status: { not: "RESOLVED" } },
    select: { id: true },
  });
  if (open) return;
  await db.alert.create({
    data: {
      accountId,
      kind,
      isTask: true,
      severity: "WARNING",
      title: "Shopify: activating products at a location needs an operator",
      body: scrubText(body, 2000),
      entityType: "Store",
      entityId: storeId,
    },
  });
}

/** Processes one activation job. Safe to call concurrently and repeatedly (row lock + status machine). */
export async function processInventoryActivation(
  id: string,
  clients: PushClients = defaultClients,
  now: Date = new Date(),
): Promise<ActivationResult> {
  const claim: Claim = await withSystemTransaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "InventoryActivation" WHERE id = ${id} FOR UPDATE SKIP LOCKED`;
    if (locked.length === 0) return { kind: "skip" };
    const row = await tx.inventoryActivation.findUniqueOrThrow({
      where: { id },
      include: {
        store: { select: { inventoryPushMode: true, archivedAt: true } },
        account: { select: { outboxPaused: true } },
      },
    });
    if (row.status !== "PENDING" && row.status !== "PAUSED") return { kind: "skip" };
    if (row.nextAttemptAt && row.nextAttemptAt > now) return { kind: "skip" };
    const mode = row.store.inventoryPushMode;
    if (globalOutboxPaused() || row.account.outboxPaused) {
      await tx.inventoryActivation.update({
        where: { id },
        data: { status: "PAUSED", evaluatedMode: mode, lastError: "paused" },
      });
      return { kind: "done", status: "PAUSED" };
    }
    const loc = await tx.storeLocation.findFirst({
      where: {
        accountId: row.accountId,
        storeId: row.storeId,
        shopifyLocationGid: row.locationGid,
        connectionId: { not: null },
        isActive: true,
      },
      select: { id: true },
    });
    const refused = row.store.archivedAt
      ? "store_archived"
      : mode === "DISABLED"
        ? "inventory_push_disabled"
        : !loc
          ? "location_not_mapped"
          : mode === "LIVE" && row.createdMode !== "LIVE"
            ? "mode_raised_after_confirm" // confirmed as a dry run: a live write needs a new OWNER click
            : null;
    if (refused) {
      await tx.inventoryActivation.update({
        where: { id },
        data: { status: "REFUSED", evaluatedMode: mode, lastError: refused },
      });
      return { kind: "done", status: "REFUSED" };
    }
    if (mode === "DRY_RUN") {
      // The exact requests were stored at creation (they do not depend on Shopify state): record, send nothing.
      await tx.inventoryActivationLine.updateMany({
        where: { activationId: id, status: "planned" },
        data: { status: "dry_run" },
      });
      await tx.inventoryActivation.update({
        where: { id },
        data: { status: "DRY_RUN_RECORDED", evaluatedMode: mode, lastError: null },
      });
      return { kind: "done", status: "DRY_RUN_RECORDED" };
    }
    const attempts = row.attempts + 1;
    await tx.inventoryActivation.update({
      where: { id },
      data: { status: "SENDING", evaluatedMode: mode, attempts, lockedAt: now, lastError: null },
    });
    return { kind: "go", attempts, row };
  });
  if (claim.kind === "skip") return "skipped";
  if (claim.kind === "done") {
    if (claim.status === "DRY_RUN_RECORDED") {
      const row = await systemDb().inventoryActivation.findUniqueOrThrow({
        where: { id },
        select: { id: true, accountId: true, storeId: true, _count: { select: { lines: true } } },
      });
      await audit(row, "dry_run", { items: row._count.lines });
    }
    return { status: claim.status, refreshInventory: false };
  }
  return run(claim, clients, now);
}

type LineState = "activated" | "already" | "failed" | "pending" | "throttled";

async function run(claim: Extract<Claim, { kind: "go" }>, clients: PushClients, now: Date) {
  const db = systemDb();
  const { row } = claim;
  const finalize = async (
    data: Prisma.InventoryActivationUpdateManyMutationInput,
    status: OutboundStatus,
  ) => {
    const res = await db.inventoryActivation.updateMany({
      where: { id: row.id, status: "SENDING", attempts: claim.attempts },
      data: { ...data, status },
    });
    if (res.count === 1) return status;
    return (await db.inventoryActivation.findUniqueOrThrow({ where: { id: row.id } })).status;
  };
  const retryLater = async (detail: string): Promise<ActivationResult> => {
    if (claim.attempts >= ACTIVATION_MAX_ATTEMPTS) {
      const s = await finalize({ lastError: `max attempts: ${detail}`.slice(0, 2000) }, "FAILED");
      if (s === "FAILED") await openTask(row.accountId, row.storeId, detail);
      return { status: s, refreshInventory: false };
    }
    const s = await finalize(
      {
        lastError: detail.slice(0, 2000),
        nextAttemptAt: new Date(now.getTime() + backoffMs(claim.attempts)),
      },
      "PENDING",
    );
    return { status: s, refreshInventory: false };
  };

  /** Throttled: nothing was executed; come back shortly with the same keys and give the attempt back. */
  const retryThrottled = async (): Promise<ActivationResult> => {
    const s = await finalize(
      {
        attempts: claim.attempts - 1,
        lastError: "THROTTLED: waiting for the Shopify rate limit",
        nextAttemptAt: new Date(now.getTime() + THROTTLE_BACKOFF_MS),
      },
      "PENDING",
    );
    return { status: s, refreshInventory: false };
  };
  /** Keeps the claim fresh during a long run; false when another worker took the job over (stop then). */
  const heartbeat = async () =>
    (
      await db.inventoryActivation.updateMany({
        where: { id: row.id, status: "SENDING", attempts: claim.attempts },
        data: { lockedAt: new Date(Math.max(now.getTime(), Date.now())) },
      })
    ).count === 1;

  let reader: ShopifyClient;
  let writer: ShopifyClient;
  try {
    reader = (await clients(row.accountId, row.storeId, {})).client;
    writer = (await clients(row.accountId, row.storeId, { maxRetries: 0 })).client;
  } catch (err) {
    const detail = `no Shopify client: ${scrubText((err as Error).message)}`;
    const s = await finalize({ lastError: detail }, "FAILED");
    if (s === "FAILED") await openTask(row.accountId, row.storeId, detail);
    return { status: s, refreshInventory: false };
  }

  /** Whether each item has a level at the location now (null = the item does not exist at Shopify). */
  const readLevels = async (items: string[]) => {
    const out = new Map<string, boolean | null>();
    for (let i = 0; i < items.length; i += ACTIVATE_BATCH) {
      const chunk = items.slice(i, i + ACTIVATE_BATCH);
      const r = await reader.query(READBACK_QUERY, { ids: chunk, locationId: row.locationGid }, ReadBack);
      chunk.forEach((item, j) => {
        const node = r.nodes[j];
        out.set(item, !node?.id ? null : !!node.inventoryLevel);
      });
    }
    return out;
  };
  const currentStatus = async () =>
    (await db.inventoryActivation.findUnique({ where: { id: row.id }, select: { status: true } }))?.status;
  const setLine = (lineId: string, data: Prisma.InventoryActivationLineUpdateInput) =>
    db.inventoryActivationLine.update({ where: { id: lineId }, data });

  const open = await db.inventoryActivationLine.findMany({
    where: { activationId: row.id, status: "planned" },
    orderBy: { inventoryItemGid: "asc" },
  });
  const failures: string[] = [];
  let pending = 0;
  const lost = async (): Promise<ActivationResult> => ({
    status: (await currentStatus()) ?? "SENDING",
    refreshInventory: false,
  });
  for (let i = 0; i < open.length; i += ACTIVATE_BATCH) {
    const batch = open.slice(i, i + ACTIVATE_BATCH);
    if (!(await heartbeat())) return lost();
    let before: Map<string, boolean | null>;
    try {
      before = await readLevels(batch.map((l) => l.inventoryItemGid));
    } catch (err) {
      return retryLater(`read failed: ${scrubText((err as Error).message)}`);
    }
    for (const line of batch) {
      if (!(await heartbeat())) return lost();
      const has = before.get(line.inventoryItemGid);
      if (has === null) {
        await setLine(line.id, { status: "failed", error: "inventory_item_not_found" });
        failures.push(`${line.inventoryItemGid}: inventory_item_not_found`);
        continue;
      }
      if (has) {
        // Already stocked there: a success, never an error (activated by us when an earlier attempt was unknown).
        await setLine(line.id, { status: line.attempted ? "activated" : "already" });
        continue;
      }
      const state = await sendOne(line);
      if (state === "throttled")
        return pending > 0 ? retryLater(`THROTTLED after ${pending} unknown outcome(s)`) : retryThrottled();
      if (state === "pending") pending++;
    }
  }

  async function sendOne(line: (typeof open)[number]): Promise<LineState> {
    const variables: ActivateVariables = {
      inventoryItemId: line.inventoryItemGid,
      locationId: row.locationGid,
      idempotencyKey: line.idempotencyKey,
    };
    const wasAttempted = line.attempted;
    await setLine(line.id, { attempted: true });
    const levelNow = async () => (await readLevels([line.inventoryItemGid])).get(line.inventoryItemGid);
    let answer: ActivatePayload;
    try {
      answer = await writer.query(ACTIVATE_MUTATION, { ...variables }, ActivatePayload);
    } catch (err) {
      const detail = scrubText((err as Error).message);
      const codes = err instanceof ShopifyError ? err.graphqlCodes : [];
      if (
        err instanceof ShopifyError &&
        (err.code === "throttled" || err.status === 429 || codes.includes("THROTTLED"))
      ) {
        // Rate limited: Shopify did not execute it. The line stays planned with the same key.
        await setLine(line.id, { error: "THROTTLED" });
        return "throttled";
      }
      if (codes.includes("IDEMPOTENCY_CONCURRENT_REQUEST")) {
        await setLine(line.id, { error: "IDEMPOTENCY_CONCURRENT_REQUEST" });
        return "pending"; // the same key is still being processed: ask again later with the same key
      }
      if (codes.includes("IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED")) {
        // Shopify says the earlier attempt with this key failed: nothing was applied, a new key is safe.
        const generation = line.generation + 1;
        await setLine(line.id, {
          generation,
          idempotencyKey: activationIdempotencyKey(
            row.storeId,
            line.inventoryItemGid,
            row.locationGid,
            generation,
          ),
          error: "IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED",
        });
        return "pending";
      }
      if (
        err instanceof ShopifyError &&
        (err.code === "auth_failed" ||
          (err.code === "graphql_error" && isDefiniteGraphqlRejection(codes)) ||
          codes.includes("IDEMPOTENCY_KEY_PARAMETER_MISMATCH"))
      ) {
        // Rejected before execution (e.g. missing write_inventory scope): nothing applied.
        const message = `${err.code}: ${detail}`.slice(0, 500);
        await setLine(line.id, { status: "failed", error: message });
        failures.push(message);
        return "failed";
      }
      logger.warn({ activationId: row.id, err: detail }, "inventoryActivate outcome unknown");
      try {
        if (await levelNow()) {
          await setLine(line.id, { status: "activated", error: null });
          return "activated";
        }
      } catch {
        // read-back failed too: retried later with the same key (Shopify dedupes on it)
      }
      await setLine(line.id, { error: `unknown outcome: ${detail}`.slice(0, 500) });
      return "pending";
    }
    const payload = answer.inventoryActivate;
    const errors = payload?.userErrors ?? [];
    if (payload?.inventoryLevel && errors.length === 0) {
      await setLine(line.id, { status: "activated", error: null });
      return "activated";
    }
    const message = errors.map((e) => e.message).join("; ") || "no inventory level returned";
    // A userError while the level exists (e.g. "already stocked") is a success; otherwise it is a real failure.
    try {
      if (await levelNow()) {
        await setLine(line.id, { status: wasAttempted ? "activated" : "already", error: null });
        return wasAttempted ? "activated" : "already";
      }
    } catch {
      await setLine(line.id, { error: `read-back failed after: ${message}`.slice(0, 500) });
      return "pending";
    }
    await setLine(line.id, { status: "failed", error: message.slice(0, 500) });
    failures.push(message);
    return "failed";
  }

  if (pending > 0) return retryLater(failures.join("; ") || `waiting for Shopify (${pending} item(s))`);
  const counts = await db.inventoryActivationLine.groupBy({
    by: ["status"],
    where: { activationId: row.id },
    _count: { _all: true },
  });
  const n = (s: string) => counts.find((c) => c.status === s)?._count._all ?? 0;
  const ok = n("activated") + n("already");
  const summary = { activated: n("activated"), already: n("already"), failed: n("failed") };
  if (ok === 0 && summary.failed > 0) {
    const detail = failures.join("; ").slice(0, 2000) || "every item failed";
    const s = await finalize({ lastError: detail }, "FAILED");
    if (s === "FAILED") await openTask(row.accountId, row.storeId, detail);
    await audit(row, "failed", summary);
    return { status: s, refreshInventory: false };
  }
  const s = await finalize(
    { sentAt: now, lastError: summary.failed ? failures.join("; ").slice(0, 2000) : null },
    "SENT",
  );
  await audit(row, "sent", summary);
  return { status: s, refreshInventory: s === "SENT" && ok > 0 };
}

/** Cron: crashed sends are re-armed (each item re-sends under the same key, so it is safe); due jobs returned. */
export async function sweepInventoryActivations(now: Date = new Date(), limit = 100) {
  const db = systemDb();
  const stale = await db.inventoryActivation.updateMany({
    where: { status: "SENDING", lockedAt: { lt: new Date(now.getTime() - ACTIVATION_STALE_MS) } },
    data: { status: "PENDING", lastError: "worker stopped during the Shopify call", nextAttemptAt: null },
  });
  const ready = await db.inventoryActivation.findMany({
    where: {
      OR: [
        { status: "PENDING", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        ...(globalOutboxPaused() ? [] : [{ status: "PAUSED" as const, account: { outboxPaused: false } }]),
      ],
    },
    select: { id: true, accountId: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  return { stale: stale.count, ready };
}

/** Activation jobs of one store for the inventory page (newest first). */
export function storeActivations(accountId: string, storeId: string, take = 10) {
  return accountDb(accountId).inventoryActivation.findMany({
    where: { storeId },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      locationGid: true,
      status: true,
      evaluatedMode: true,
      lastError: true,
      attempts: true,
      createdAt: true,
      sentAt: true,
      request: true,
      lines: {
        select: { id: true, variantLinkId: true, inventoryItemGid: true, status: true, error: true },
        orderBy: { inventoryItemGid: "asc" },
      },
    },
  });
}
