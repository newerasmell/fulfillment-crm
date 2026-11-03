import { Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";
import { fulfillOrder, type FulfillOptions } from "./fulfill";

/**
 * Bulk (and single) Fulfill as a persisted batch: one row per order with its result, so a closed browser
 * never leaves anything partial-silent (SPEC §6.1). The batch page drives `runFulfillBatch` step by step and
 * shows progress; anyone with orders.fulfill can reopen and continue it. Items are claimed with a conditional
 * write (PENDING → RUNNING), so two tabs never process the same item; fulfillOrder itself is idempotent.
 */

export const MAX_BATCH = 200;
/** A RUNNING item older than this was abandoned (crashed request): it may be picked again (idempotent). */
export const STALE_RUNNING_MS = 5 * 60_000;

const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

export async function createFulfillBatch(actor: ScopedActor, orderIds: string[]) {
  assertCan(actor.role, "orders.fulfill");
  const ids = [...new Set(orderIds.filter((x) => typeof x === "string" && x.length > 0 && x.length < 64))];
  if (ids.length === 0) throw new DomainError("empty_selection");
  if (ids.length > MAX_BATCH) throw new DomainError("too_many");
  const db = accountDb(actor.accountId);
  // Only orders that exist in this account and in the member's companies become items.
  const orders = await db.order.findMany({
    where: { id: { in: ids }, ...(actor.companyScope ? { companyId: { in: actor.companyScope } } : {}) },
    select: { id: true },
  });
  const known = new Set(orders.map((o) => o.id));
  const kept = ids.filter((id) => known.has(id));
  if (kept.length === 0) throw new DomainError("not_found");
  const batch = await withAccountTransaction(actor.accountId, async (tx) => {
    const b = await tx.fulfillBatch.create({
      data: { accountId: actor.accountId, createdById: actor.userId, total: kept.length },
    });
    await tx.fulfillBatchItem.createMany({
      data: kept.map((orderId, position) => ({
        accountId: actor.accountId,
        batchId: b.id,
        orderId,
        position,
      })),
    });
    return b;
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "fulfill.batch_created",
    entityType: "FulfillBatch",
    entityId: batch.id,
    after: { orders: kept.length },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return batch;
}

/** Items a restricted member may see and act on: only orders of their companies (same filter everywhere). */
const itemScope = (actor: ScopedActor): Prisma.FulfillBatchItemWhereInput =>
  actor.companyScope ? { order: { companyId: { in: actor.companyScope } } } : {};

async function loadBatch(actor: ScopedActor, batchId: string) {
  const batch = await accountDb(actor.accountId).fulfillBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new DomainError("not_found");
  return batch;
}

async function processItem(actor: ScopedActor, itemId: string, orderId: string, opts: FulfillOptions) {
  const db = accountDb(actor.accountId);
  let r;
  try {
    r = await fulfillOrder(actor, orderId, opts);
  } catch (err) {
    r = {
      status: "FAILED" as const,
      code: err instanceof Error ? (err.name === "ForbiddenError" ? "forbidden" : "error") : "error",
      findings: [],
      connectionId: null,
      liveMode: null,
      requestId: null,
    };
  }
  await db.fulfillBatchItem.update({
    where: { id: itemId },
    data: {
      status: r.status,
      code: r.code,
      findings: r.findings.length ? json(r.findings) : Prisma.DbNull,
      connectionId: r.connectionId,
      liveMode: r.liveMode,
      requestId: r.requestId,
      finishedAt: new Date(),
    },
  });
  return r;
}

/** Processes up to `max` waiting items of a batch; returns how many are still waiting. */
export async function runFulfillBatch(actor: ScopedActor, batchId: string, max = 5, now = new Date()) {
  assertCan(actor.role, "orders.fulfill");
  const batch = await loadBatch(actor, batchId);
  const db = accountDb(actor.accountId);
  for (let i = 0; i < max; i++) {
    const next = await db.fulfillBatchItem.findFirst({
      where: {
        batchId: batch.id,
        ...itemScope(actor),
        OR: [
          { status: "PENDING" },
          { status: "RUNNING", startedAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) } },
        ],
      },
      orderBy: { position: "asc" },
    });
    if (!next) break;
    const claimed = await db.fulfillBatchItem.updateMany({
      where: { id: next.id, status: next.status, startedAt: next.startedAt },
      data: { status: "RUNNING", startedAt: now },
    });
    if (claimed.count !== 1) continue; // another tab took it
    await processItem(actor, next.id, next.orderId, { now });
  }
  // Finished only when every item (of anyone's scope) is done.
  const waiting = await db.fulfillBatchItem.count({
    where: { batchId: batch.id, status: { in: ["PENDING", "RUNNING"] } },
  });
  if (waiting === 0 && !batch.finishedAt)
    await db.fulfillBatch.updateMany({
      where: { id: batch.id, finishedAt: null },
      data: { finishedAt: now },
    });
  return { waiting };
}

const RETRYABLE = ["NEEDS_ACK", "BLOCKED", "FAILED"];

/**
 * Runs one item again (after the operator acknowledged new warnings, or once a block was fixed).
 * `acknowledgedCodes` are the warnings the operator was shown on the row; only those that are also the item's
 * STORED NEEDS_ACK findings count (never a fresh validation), so a warning that appeared later is shown first.
 */
export async function retryFulfillItem(
  actor: ScopedActor,
  batchId: string,
  itemId: string,
  opts: { acknowledgedCodes?: readonly string[] } = {},
) {
  assertCan(actor.role, "orders.fulfill");
  const db = accountDb(actor.accountId);
  const item = await db.fulfillBatchItem.findFirst({
    where: { id: itemId, batchId, ...itemScope(actor) },
  });
  if (!item) throw new DomainError("not_found");
  if (!RETRYABLE.includes(item.status)) throw new DomainError("not_retryable");
  const stored = new Set(
    item.status === "NEEDS_ACK" ? ((item.findings ?? []) as { code?: string }[]).map((f) => f.code) : [],
  );
  const acknowledgedCodes = (opts.acknowledgedCodes ?? []).filter((c) => stored.has(c));
  // Conditional on the state that was read: the stored findings are exactly what is acknowledged.
  const claimed = await db.fulfillBatchItem.updateMany({
    where: {
      id: item.id,
      status: item.status,
      finishedAt: item.finishedAt,
    },
    data: { status: "RUNNING", startedAt: new Date() },
  });
  if (claimed.count !== 1) throw new DomainError("not_retryable");
  return processItem(actor, item.id, item.orderId, { acknowledgedCodes });
}

export type BatchView = Awaited<ReturnType<typeof getFulfillBatch>>;

/** The batch page: per-order result, plus the request state and CANARY info where a request exists. */
export async function getFulfillBatch(actor: ScopedActor, batchId: string) {
  assertCan(actor.role, "orders.fulfill");
  const batch = await loadBatch(actor, batchId);
  const db = accountDb(actor.accountId);
  const items = await db.fulfillBatchItem.findMany({
    where: { batchId: batch.id, ...itemScope(actor) },
    orderBy: { position: "asc" },
    include: { order: { select: { id: true, number: true, customerName: true, status: true } } },
  });
  const requestIds = items.map((i) => i.requestId).filter((x): x is string => !!x);
  const connectionIds = [...new Set(items.map((i) => i.connectionId).filter((x): x is string => !!x))];
  const [requests, connections] = await Promise.all([
    db.outboundRequest.findMany({
      where: { id: { in: requestIds } },
      select: { id: true, status: true, confirmedAt: true, lastError: true },
    }),
    db.fulfillmentConnection.findMany({
      where: { id: { in: connectionIds } },
      select: { id: true, name: true, type: true, liveMode: true },
    }),
  ]);
  const reqOf = new Map(requests.map((r) => [r.id, r]));
  const conOf = new Map(connections.map((c) => [c.id, c]));
  const rows = items.map((i) => {
    const req = i.requestId ? reqOf.get(i.requestId) : undefined;
    const con = i.connectionId ? conOf.get(i.connectionId) : undefined;
    return {
      id: i.id,
      orderId: i.orderId,
      number: i.order.number,
      customerName: i.order.customerName,
      orderStatus: i.order.status,
      status: i.status,
      code: i.code,
      findings: (i.findings ?? []) as unknown as {
        code: string;
        severity: string;
        message_bg: string;
        message_en: string;
      }[],
      connection: con ? { id: con.id, name: con.name, type: con.type, liveMode: con.liveMode } : null,
      request: req
        ? { id: req.id, status: req.status, confirmed: !!req.confirmedAt, lastError: req.lastError }
        : null,
      /** The connection is in CANARY now and the request still waits for its click. */
      needsCanary:
        con?.liveMode === "CANARY" &&
        !!req &&
        !req.confirmedAt &&
        (req.status === "PENDING" || req.status === "AWAITING_CONFIRMATION"),
    };
  });
  const done = rows.filter((r) => r.status !== "PENDING" && r.status !== "RUNNING").length;
  return {
    id: batch.id,
    createdAt: batch.createdAt,
    finishedAt: batch.finishedAt,
    total: rows.length,
    done,
    counts: rows.reduce<Record<string, number>>(
      (acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }),
      {},
    ),
    rows,
  };
}
