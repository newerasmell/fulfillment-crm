import { Prisma, type OutboundStatus } from "@/generated/prisma/client";
import type { ShopifyClient, ShopifyClientOptions } from "@/integrations/shopify/client";
import { ShopifyError } from "@/integrations/shopify/errors";
import { isDefiniteGraphqlRejection } from "@/integrations/shopify/fulfillments";
import {
  availableOf,
  DEFINITE_PUSH_ERRORS,
  PUSH_BATCH,
  PUSH_MUTATION,
  PUSH_REASON,
  PushPayload,
  pushIdempotencyKey,
  READBACK_PAGE,
  READBACK_QUERY,
  ReadBack,
  type PushInput,
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
import { crmReservations, isStale, reservationKey, sellableOf } from "./levels";
import { getStockSettings, staleHoursFor } from "./settings";
import { storedSuspiciousItemIds, suspiciousItemIds } from "@/server/products/suspicious";
import { selectActivationCandidates } from "./activate";

/**
 * Shopify inventory push (P5-03, SPEC §4, INTEGRATION_NOTES §6). Sellable stock of the warehouse a Shopify
 * location stands for (StoreLocation.connectionId), minus the store's safety buffer, is SET as the location's
 * "available" quantity with inventorySetQuantities. Its own outbox (InventoryPush) with the outbox discipline:
 *  - the sender evaluates the store's CURRENT inventoryPushMode at send time: DISABLED → REFUSED (nothing read or
 *    sent), DRY_RUN → reads Shopify and records the exact {mutation, variables}, LIVE → sends; the account kill
 *    switch / OUTBOX_PAUSED park it as PAUSED;
 *  - every batch carries a deterministic @idempotent key (required since 2026-04) and compare-and-set
 *    (changeFromQuantity = what Shopify had right before the send), and a retry re-sends the STORED variables
 *    with the same key, so one push is applied at most once and never over a quantity that moved meanwhile;
 *  - an unknown outcome is resolved by reading the quantities back; the write client never retries by itself;
 *  - at most one open push per store; never a push from a stale, missing or unmapped snapshot.
 */

export const PUSH_MAX_ATTEMPTS = 5;
export const PUSH_STALE_MS = 10 * 60_000;
/**
 * A push whose request was not built yet carries targets computed when it was created. Older than this (e.g. parked
 * PAUSED overnight behind the kill switch), or when a fresh plan gives other numbers, it is never sent: it ends
 * FAILED with lastError "plan_expired" and the next sweep plans a fresh one.
 */
export const PUSH_PLAN_TTL_MS = 30 * 60_000;
export const PLAN_EXPIRED = "plan_expired";
const OPEN: OutboundStatus[] = ["PENDING", "SENDING", "PAUSED"];
const backoffMs = (attempt: number) => Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;
export const referenceUri = (pushId: string) => `gid://fulfillment-crm/InventoryPush/${pushId}`;

export type PushClients = (
  accountId: string,
  storeId: string,
  opts: ShopifyClientOptions,
) => Promise<{ client: ShopifyClient }>;
const defaultClients: PushClients = (accountId, storeId, opts) =>
  shopifyClientForStore(accountId, storeId, opts);

export type SkipReason =
  | "unlinked"
  | "not_stocked_at_location"
  | "untracked"
  | "not_at_warehouse"
  | "no_snapshot"
  | "stale_snapshot"
  /** The variant's (or the warehouse product's) link names a different product — "Съмнителни връзки". */
  | "suspicious_link";

export interface PlanLine {
  variantLinkId: string;
  productId: string;
  sku: string | null;
  title: string;
  connectionId: string;
  locationGid: string;
  locationName: string;
  inventoryItemGid: string;
  sellable: number;
  target: number;
  /** Shopify available from the mirror (the sender reads it again right before sending). */
  shopifyNow: number;
  /** When that mirror value was read from Shopify. */
  shopifyFetchedAt: Date;
}

/** One variant × mapped location the plan does NOT push, with the reason (the stock board explains differences). */
export interface PlanSkip {
  variantLinkId: string;
  sku: string | null;
  locationGid: string;
  locationName: string;
  connectionId: string;
  reason: SkipReason;
}

/** What a push of this store would set now, from the local mirrors (the dry-run preview). */
export async function planInventoryPush(
  accountId: string,
  storeId: string,
  now: Date = new Date(),
  /** Only these masters' variants (the stock board explaining one page); default the whole store. */
  opts: {
    productIds?: string[];
    /**
     * "stored": suspicious links from the last computed flags (screens that only preview — a store with thousands
     * of variants made the live name check time out page loads, owner report 2026-11-09). Default "live": the
     * push itself always checks the current names.
     */
    suspicious?: "live" | "stored";
  } = {},
) {
  const db = accountDb(accountId);
  const store = await db.store.findUnique({
    where: { id: storeId },
    select: { id: true, name: true, inventoryBuffer: true, inventoryPushMode: true },
  });
  if (!store) throw new DomainError("not_found");
  const [settings, reservations, locations, links] = await Promise.all([
    getStockSettings(accountId),
    crmReservations(accountId),
    db.storeLocation.findMany({
      where: { storeId, connectionId: { not: null }, isActive: true },
      select: {
        shopifyLocationGid: true,
        name: true,
        connection: { select: { id: true, name: true, type: true } },
      },
    }),
    db.storeVariantLink.findMany({
      where: { storeId, ...(opts.productIds ? { productId: { in: opts.productIds } } : {}) },
      select: {
        id: true,
        sku: true,
        title: true,
        productId: true,
        inventoryLevels: {
          select: {
            locationGid: true,
            inventoryItemGid: true,
            tracked: true,
            available: true,
            fetchedAt: true,
          },
        },
      },
      orderBy: { sku: "asc" },
    }),
  ]);
  const productIds = [...new Set(links.map((l) => l.productId).filter((x): x is string => !!x))];
  const vps = await db.vendorProduct.findMany({
    where: {
      productId: { in: productIds },
      connectionId: { in: locations.map((l) => l.connection!.id) },
      archived: false,
    },
    select: { id: true, connectionId: true, productId: true, stockLevel: true },
    orderBy: { id: "asc" },
  });
  const vpOf = new Map<string, (typeof vps)[number]>();
  for (const v of vps) {
    const k = reservationKey(v.connectionId, v.productId!);
    if (!vpOf.has(k)) vpOf.set(k, v);
  }
  const lines: PlanLine[] = [];
  const skips: PlanSkip[] = [];
  const skipped: Record<SkipReason, number> = {
    unlinked: 0,
    not_stocked_at_location: 0,
    untracked: 0,
    not_at_warehouse: 0,
    no_snapshot: 0,
    stale_snapshot: 0,
    suspicious_link: 0,
  };
  // Live from the current names (never a stale flag): a link whose names disagree is not pushed until confirmed.
  const suspicious =
    opts.suspicious === "stored"
      ? await storedSuspiciousItemIds(accountId, {
          storeId,
          connectionIds: [...new Set(vps.map((v) => v.connectionId))],
        })
      : await suspiciousItemIds(accountId, {
          variants: { storeId, ...(opts.productIds ? { productId: { in: opts.productIds } } : {}) },
          // The same set as the vps read above, by its filter (a list of thousands of ids is slow to plan).
          vendors: {
            productId: { in: productIds },
            connectionId: { in: locations.map((l) => l.connection!.id) },
          },
        });
  /**
   * Per Shopify location gid, the inventory items "Активирай продуктите в тази локация" would activate there (the
   * hint next to the button): the same predicate and count as the button (tracked, one per inventory item), not the
   * raw not_stocked_at_location count of variant × location skips.
   */
  const notStockedByLocation: Record<string, number> = Object.fromEntries(
    [
      ...selectActivationCandidates(
        locations.map((l) => l.shopifyLocationGid),
        links,
      ),
    ].map(([gid, list]) => [gid, list.length]),
  );
  const skip = (
    link: { id: string; sku: string | null },
    loc: (typeof locations)[number],
    reason: SkipReason,
  ) => {
    skipped[reason]++;
    skips.push({
      variantLinkId: link.id,
      sku: link.sku,
      locationGid: loc.shopifyLocationGid,
      locationName: loc.name,
      connectionId: loc.connection!.id,
      reason,
    });
  };
  for (const link of links) {
    for (const loc of locations) {
      if (!link.productId) {
        skip(link, loc, "unlinked");
        continue;
      }
      const level = link.inventoryLevels.find((l) => l.locationGid === loc.shopifyLocationGid);
      if (!level) {
        skip(link, loc, "not_stocked_at_location");
        continue;
      }
      if (!level.tracked) {
        skip(link, loc, "untracked");
        continue;
      }
      const c = loc.connection!;
      const vp = vpOf.get(reservationKey(c.id, link.productId));
      if (!vp) {
        skip(link, loc, "not_at_warehouse");
        continue;
      }
      if (suspicious.has(link.id) || suspicious.has(vp.id)) {
        skip(link, loc, "suspicious_link");
        continue;
      }
      if (!vp.stockLevel) {
        skip(link, loc, "no_snapshot");
        continue;
      }
      if (isStale(vp.stockLevel.snapshotAt, staleHoursFor(settings, c.type), now)) {
        skip(link, loc, "stale_snapshot");
        continue;
      }
      const sellable = sellableOf(vp.stockLevel, reservations.get(reservationKey(c.id, link.productId)) ?? 0);
      lines.push({
        variantLinkId: link.id,
        productId: link.productId,
        sku: link.sku,
        title: link.title,
        connectionId: c.id,
        locationGid: loc.shopifyLocationGid,
        locationName: loc.name,
        inventoryItemGid: level.inventoryItemGid,
        sellable,
        target: Math.max(0, sellable - store.inventoryBuffer),
        shopifyNow: level.available,
        shopifyFetchedAt: level.fetchedAt,
      });
    }
  }
  return {
    store,
    mappedLocations: locations.length,
    lines,
    changes: lines.filter((l) => l.target !== l.shopifyNow),
    skipped,
    skips,
    notStockedByLocation,
  };
}

type Creator = { kind: "user"; actor: ScopedActor } | { kind: "system" };

/**
 * Queues a push of the lines that differ. One open push per store (the existing one is returned); a store with
 * DISABLED push is refused here already (the sender checks the mode again at send time).
 */
export async function createInventoryPush(storeId: string, by: Creator, now: Date = new Date()) {
  const accountId = by.kind === "user" ? by.actor.accountId : null;
  if (by.kind === "user") assertCan(by.actor.role, "inventory.push");
  const acc = accountId ?? (await systemDb().store.findUniqueOrThrow({ where: { id: storeId } })).accountId;
  const db = accountDb(acc);
  const store = await db.store.findUnique({
    where: { id: storeId },
    select: { companyId: true, inventoryPushMode: true, archivedAt: true },
  });
  if (!store) throw new DomainError("not_found");
  if (
    by.kind === "user" &&
    by.actor.companyScope &&
    (!store.companyId || !by.actor.companyScope.includes(store.companyId))
  )
    throw new DomainError("not_found");
  if (store.archivedAt) throw new DomainError("store_archived");
  if (store.inventoryPushMode === "DISABLED") throw new DomainError("inventory_push_disabled");
  const plan = await planInventoryPush(acc, storeId, now);
  const result = await withAccountTransaction(acc, async (tx, { lockKey }) => {
    await lockKey(`inventory-push:${storeId}`);
    const open = await tx.inventoryPush.findFirst({
      where: { storeId, status: { in: OPEN } },
      select: { id: true },
    });
    if (open) return { pushId: open.id, created: false as const, reason: "push_open" };
    if (plan.changes.length === 0)
      return { pushId: null, created: false as const, reason: "nothing_to_push" };
    const push = await tx.inventoryPush.create({
      data: {
        accountId: acc,
        storeId,
        trigger: by.kind === "user" ? "manual" : "cron",
        buffer: plan.store.inventoryBuffer,
        createdById: by.kind === "user" ? by.actor.userId : null,
        lines: {
          create: plan.changes.map((l) => ({
            variantLinkId: l.variantLinkId,
            productId: l.productId,
            connectionId: l.connectionId,
            locationGid: l.locationGid,
            inventoryItemGid: l.inventoryItemGid,
            sellable: l.sellable,
            target: l.target,
          })),
        },
      },
      select: { id: true },
    });
    return { pushId: push.id, created: true as const, reason: null };
  });
  if (result.created && by.kind === "user")
    await recordAudit({
      accountId: acc,
      userId: by.actor.userId,
      action: "inventory.push_queued",
      entityType: "InventoryPush",
      entityId: result.pushId!,
      after: { storeId, lines: plan.changes.length, buffer: plan.store.inventoryBuffer },
      ip: by.actor.ip,
      userAgent: by.actor.userAgent,
    });
  return { ...result, changes: plan.changes.length };
}

interface StoredBatch {
  idempotencyKey: string;
  generation: number;
  input: PushInput;
  /** Line ids in the order of input.quantities. */
  lineIds: string[];
  done: boolean;
}
interface StoredRequest {
  mutation: string;
  batches: StoredBatch[];
}

type Claim =
  | { kind: "skip" }
  | { kind: "done"; status: OutboundStatus }
  | {
      kind: "go";
      mode: "DRY_RUN" | "LIVE";
      attempts: number;
      row: { id: string; accountId: string; storeId: string; request: Prisma.JsonValue };
    };

async function openTask(accountId: string, storeId: string, kind: string, title: string, body: string) {
  const db = systemDb();
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
      title,
      body: scrubText(body, 2000),
      entityType: "Store",
      entityId: storeId,
    },
  });
}

/** Processes one push. Safe to call concurrently and repeatedly (row lock + status machine). */
export async function processInventoryPush(
  id: string,
  clients: PushClients = defaultClients,
  now: Date = new Date(),
): Promise<OutboundStatus | "skipped"> {
  const claim: Claim = await withSystemTransaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "InventoryPush" WHERE id = ${id} FOR UPDATE SKIP LOCKED`;
    if (locked.length === 0) return { kind: "skip" };
    const row = await tx.inventoryPush.findUniqueOrThrow({
      where: { id },
      include: {
        store: { select: { inventoryPushMode: true, archivedAt: true } },
        account: { select: { outboxPaused: true } },
      },
    });
    if (row.status !== "PENDING" && row.status !== "PAUSED") return { kind: "skip" };
    if (row.nextAttemptAt && row.nextAttemptAt > now) return { kind: "skip" };
    const mode = row.store.inventoryPushMode;
    if (row.request === null && now.getTime() - row.createdAt.getTime() > PUSH_PLAN_TTL_MS) {
      // Never re-arm old targets: the warehouse numbers may have moved since (re-planned by the next sweep).
      await tx.inventoryPush.update({
        where: { id },
        data: { status: "FAILED", evaluatedMode: mode, lastError: PLAN_EXPIRED },
      });
      return { kind: "done", status: "FAILED" };
    }
    if (globalOutboxPaused() || row.account.outboxPaused) {
      await tx.inventoryPush.update({
        where: { id },
        data: { status: "PAUSED", evaluatedMode: mode, lastError: "paused" },
      });
      return { kind: "done", status: "PAUSED" };
    }
    if (mode === "DISABLED" || row.store.archivedAt) {
      await tx.inventoryPush.update({
        where: { id },
        data: {
          status: "REFUSED",
          evaluatedMode: mode,
          lastError: row.store.archivedAt ? "store_archived" : "inventory_push_disabled",
        },
      });
      return { kind: "done", status: "REFUSED" };
    }
    const attempts = row.attempts + 1;
    await tx.inventoryPush.update({
      where: { id },
      data: { status: "SENDING", evaluatedMode: mode, attempts, lockedAt: now, lastError: null },
    });
    return { kind: "go", mode, attempts, row };
  });
  if (claim.kind === "skip") return "skipped";
  if (claim.kind === "done") return claim.status;
  return run(claim, clients, now);
}

async function run(claim: Extract<Claim, { kind: "go" }>, clients: PushClients, now: Date) {
  const db = systemDb();
  const { row, mode } = claim;
  const finalize = async (data: Prisma.InventoryPushUpdateManyMutationInput, status: OutboundStatus) => {
    const res = await db.inventoryPush.updateMany({
      where: { id: row.id, status: "SENDING" },
      data: { ...data, status },
    });
    if (res.count === 1) return status;
    return (await db.inventoryPush.findUniqueOrThrow({ where: { id: row.id } })).status;
  };
  const retryLater = async (detail: string) => {
    if (claim.attempts >= PUSH_MAX_ATTEMPTS) {
      const s = await finalize({ lastError: `max attempts: ${detail}` }, "FAILED");
      if (s === "FAILED")
        await openTask(
          row.accountId,
          row.storeId,
          "inventory_push_failed",
          "Shopify inventory push did not go through",
          detail,
        );
      return s;
    }
    return finalize(
      { lastError: detail, nextAttemptAt: new Date(now.getTime() + backoffMs(claim.attempts)) },
      "PENDING",
    );
  };
  const fail = async (detail: string, response?: unknown) => {
    const s = await finalize({ lastError: detail, lastResponse: json(response) }, "FAILED");
    if (s === "FAILED")
      await openTask(
        row.accountId,
        row.storeId,
        "inventory_push_failed",
        "Shopify inventory push needs an operator",
        detail,
      );
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
  const lines = await db.inventoryPushLine.findMany({ where: { pushId: row.id }, orderBy: { id: "asc" } });
  const readAvailable = async (subset: typeof lines) => {
    const out = new Map<string, number | null>();
    const byLocation = new Map<string, typeof lines>();
    for (const l of subset) byLocation.set(l.locationGid, [...(byLocation.get(l.locationGid) ?? []), l]);
    for (const [locationId, group] of byLocation) {
      for (let i = 0; i < group.length; i += READBACK_PAGE) {
        const chunk = group.slice(i, i + READBACK_PAGE);
        const r = await reader.query(
          READBACK_QUERY,
          { ids: chunk.map((l) => l.inventoryItemGid), locationId },
          ReadBack,
        );
        chunk.forEach((l, j) => {
          const node = r.nodes[j];
          out.set(l.id, node?.tracked === false ? null : availableOf(node?.inventoryLevel?.quantities));
        });
      }
    }
    return out;
  };

  let request = (row.request as StoredRequest | null) ?? null;
  if (!request) {
    // The targets were computed at create time: they must still be what a plan gives now, or nothing is sent.
    let fresh: Awaited<ReturnType<typeof planInventoryPush>>;
    try {
      fresh = await planInventoryPush(row.accountId, row.storeId, now);
    } catch (err) {
      return finalize({ lastError: `${PLAN_EXPIRED}: ${scrubText((err as Error).message)}` }, "FAILED");
    }
    const freshOf = new Map(fresh.lines.map((l) => [`${l.variantLinkId}|${l.locationGid}`, l]));
    const moved = lines.some((l) => {
      const f = freshOf.get(`${l.variantLinkId}|${l.locationGid}`);
      return !f || f.target !== l.target || f.connectionId !== l.connectionId;
    });
    if (moved) return finalize({ lastError: PLAN_EXPIRED }, "FAILED");
    // First attempt: read what Shopify has right now; this becomes the compare-and-set value.
    let current: Map<string, number | null>;
    try {
      current = await readAvailable(lines);
    } catch (err) {
      return retryLater(`read failed: ${scrubText((err as Error).message)}`);
    }
    const toSend: typeof lines = [];
    for (const l of lines) {
      const before = current.get(l.id) ?? null;
      if (before === null) {
        await db.inventoryPushLine.update({
          where: { id: l.id },
          data: { status: "failed", error: "not_stocked_or_untracked" },
        });
      } else if (before === l.target) {
        await db.inventoryPushLine.update({
          where: { id: l.id },
          data: { status: "unchanged", shopifyBefore: before },
        });
      } else {
        await db.inventoryPushLine.update({ where: { id: l.id }, data: { shopifyBefore: before } });
        toSend.push({ ...l, shopifyBefore: before });
      }
    }
    const batches: StoredBatch[] = [];
    for (let i = 0; i < toSend.length; i += PUSH_BATCH) {
      const chunk = toSend.slice(i, i + PUSH_BATCH);
      const n = batches.length;
      batches.push({
        idempotencyKey: pushIdempotencyKey(row.id, n, 0),
        generation: 0,
        lineIds: chunk.map((l) => l.id),
        done: false,
        input: {
          name: "available",
          reason: PUSH_REASON,
          referenceDocumentUri: referenceUri(row.id),
          quantities: chunk.map((l) => ({
            inventoryItemId: l.inventoryItemGid,
            locationId: l.locationGid,
            quantity: l.target,
            changeFromQuantity: l.shopifyBefore!,
          })),
        },
      });
    }
    request = { mutation: PUSH_MUTATION, batches };
    if (mode === "DRY_RUN") {
      await db.inventoryPushLine.updateMany({
        where: { pushId: row.id, id: { in: toSend.map((l) => l.id) } },
        data: { status: "dry_run" },
      });
      const s = await finalize({ request: json(request) }, "DRY_RUN_RECORDED");
      await audit(row, "dry_run", { lines: toSend.length });
      return s;
    }
    // LIVE: store the exact variables BEFORE the first send, so every retry re-sends the same thing.
    await db.inventoryPush.updateMany({
      where: { id: row.id, status: "SENDING" },
      data: { request: json(request) },
    });
  }
  if (mode === "DRY_RUN") {
    // A request stored by an earlier LIVE attempt while the store went back to DRY_RUN: nothing more is sent.
    return finalize({ lastError: "store_back_in_dry_run" }, "DRY_RUN_RECORDED");
  }

  let pending = false;
  let staleLines = 0;
  let failures: string[] = [];
  for (const b of request.batches) {
    if (b.done) continue;
    const variables = { input: b.input, idempotencyKey: b.idempotencyKey };
    let answer;
    try {
      answer = await writer.query(PUSH_MUTATION, variables, PushPayload);
    } catch (err) {
      const detail = scrubText((err as Error).message);
      if (
        err instanceof ShopifyError &&
        (err.code === "auth_failed" ||
          (err.code === "graphql_error" && isDefiniteGraphqlRejection(err.graphqlCodes)))
      ) {
        // Rejected before execution (e.g. missing write_inventory scope): nothing applied.
        await db.inventoryPushLine.updateMany({
          where: { id: { in: b.lineIds } },
          data: { status: "failed", error: `${err.code}: ${detail}`.slice(0, 500) },
        });
        b.done = true;
        failures.push(`${err.code}: ${detail}`);
        continue;
      }
      logger.warn({ pushId: row.id, err: detail }, "inventorySetQuantities outcome unknown");
      // Unknown outcome: read back; lines at their target are applied, the rest is retried with the same key.
      try {
        const after = await readAvailable(lines.filter((l) => b.lineIds.includes(l.id)));
        const applied = lines.filter((l) => b.lineIds.includes(l.id) && after.get(l.id) === l.target);
        if (applied.length === b.lineIds.length) {
          await db.inventoryPushLine.updateMany({
            where: { id: { in: b.lineIds } },
            data: { status: "applied" },
          });
          b.done = true;
          continue;
        }
      } catch {
        // read-back failed too: retried later with the same key and variables (Shopify dedupes on the key)
      }
      pending = true;
      failures.push(detail);
      continue;
    }
    const payload = answer.inventorySetQuantities;
    const errors = payload?.userErrors ?? [];
    if (payload?.inventoryAdjustmentGroup && errors.length === 0) {
      await db.inventoryPushLine.updateMany({
        where: { id: { in: b.lineIds } },
        data: { status: "applied" },
      });
      b.done = true;
      continue;
    }
    const codes = errors.map((e) => e.code ?? "");
    if (codes.includes("IDEMPOTENCY_CONCURRENT_REQUEST")) {
      pending = true; // the same key is still being processed: ask again later
      continue;
    }
    if (codes.includes("IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED")) {
      // Shopify says the earlier attempt with this key failed: a new key, same compare-and-set values.
      b.generation += 1;
      b.idempotencyKey = pushIdempotencyKey(row.id, request.batches.indexOf(b), b.generation);
      pending = true;
      continue;
    }
    // Any other userError (stale compare value, invalid item…): nothing to retry blindly. Mark the lines and let
    // the next push start from fresh numbers.
    const stale = codes.some((c) => c === "CHANGE_FROM_QUANTITY_STALE" || c === "COMPARE_QUANTITY_STALE");
    const message =
      errors.map((e) => `${e.code ?? "?"}: ${e.message}`).join("; ") || "no adjustment returned";
    await db.inventoryPushLine.updateMany({
      where: { id: { in: b.lineIds } },
      data: { status: stale ? "stale" : "failed", error: message.slice(0, 500) },
    });
    b.done = true;
    if (stale) staleLines += b.lineIds.length;
    if (!stale || codes.some((c) => DEFINITE_PUSH_ERRORS.has(c))) failures.push(message);
  }
  await db.inventoryPush.updateMany({
    where: { id: row.id, status: "SENDING" },
    data: { request: json(request) },
  });
  if (pending) return retryLater(failures.join("; ") || "waiting for Shopify");
  failures = failures.filter(Boolean);
  if (failures.length) {
    await audit(row, "failed", { failures: failures.slice(0, 5) });
    return fail(failures.join("; ").slice(0, 2000));
  }
  if (staleLines > 0) {
    const applied = await db.inventoryPushLine.count({ where: { pushId: row.id, status: "applied" } });
    if (applied === 0) {
      // Nothing was set: Shopify moved under every batch. Not SENT; the next push starts from fresh numbers.
      const s = await finalize({ lastError: `stale_only: ${staleLines} line(s)` }, "FAILED");
      await audit(row, "stale", { lines: staleLines });
      return s;
    }
  }
  const s = await finalize({ sentAt: now }, "SENT");
  await audit(row, "sent", { batches: request.batches.length, ...(staleLines ? { staleLines } : {}) });
  return s;
}

async function audit(row: { id: string; accountId: string; storeId: string }, what: string, after: object) {
  await recordAudit({
    accountId: row.accountId,
    action: `inventory.push_${what}`,
    entityType: "InventoryPush",
    entityId: row.id,
    after: { storeId: row.storeId, ...after },
  });
}

/**
 * Cron: crashed sends are re-armed (a retry re-sends the stored variables under the same idempotency key, so it
 * is safe), stores with push DRY_RUN/LIVE and a mapped location get a fresh push, and due pushes are returned.
 */
export async function sweepInventoryPushes(now: Date = new Date(), limit = 100) {
  const db = systemDb();
  const stale = await db.inventoryPush.updateMany({
    where: { status: "SENDING", lockedAt: { lt: new Date(now.getTime() - PUSH_STALE_MS) } },
    data: { status: "PENDING", lastError: "worker stopped during the Shopify call", nextAttemptAt: null },
  });
  // Old plans that were never built (parked PAUSED / backing off) give way to a fresh plan in this same sweep.
  await db.inventoryPush.updateMany({
    where: {
      status: { in: ["PENDING", "PAUSED"] },
      request: { equals: Prisma.DbNull },
      createdAt: { lt: new Date(now.getTime() - PUSH_PLAN_TTL_MS) },
    },
    data: { status: "FAILED", lastError: PLAN_EXPIRED },
  });
  const stores = await db.store.findMany({
    where: {
      inventoryPushMode: { not: "DISABLED" },
      archivedAt: null,
      locations: { some: { connectionId: { not: null }, isActive: true } },
    },
    select: { id: true, connectionStatus: true },
  });
  let created = 0;
  for (const s of stores) {
    if ((s.connectionStatus as { ok?: boolean }).ok !== true) continue;
    try {
      const r = await createInventoryPush(s.id, { kind: "system" }, now);
      if (r.created) created++;
    } catch (err) {
      logger.warn({ storeId: s.id, err: (err as Error).message }, "inventory push not created");
    }
  }
  const ready = await db.inventoryPush.findMany({
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
  return { stale: stale.count, created, ready };
}

/** Push history of one store for the store page. */
export function storePushes(accountId: string, storeId: string, take = 10) {
  return accountDb(accountId).inventoryPush.findMany({
    where: { storeId },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      trigger: true,
      status: true,
      evaluatedMode: true,
      buffer: true,
      lastError: true,
      attempts: true,
      createdAt: true,
      sentAt: true,
      request: true,
      lines: {
        select: {
          id: true,
          variantLinkId: true,
          locationGid: true,
          sellable: true,
          target: true,
          shopifyBefore: true,
          status: true,
          error: true,
        },
      },
    },
  });
}
