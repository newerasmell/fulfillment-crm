import type { LiveMode, OutboundStatus, Prisma } from "@/generated/prisma/client";
import type { Actor } from "@/server/accounts";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { systemDb, withAccountTransaction, withSystemTransaction } from "@/server/db/client";
import { logger } from "@/lib/logger";
import { evaluateGate, isRaise } from "./gate";
import type { OutboundCall, OutboundTransport, TransportResolver } from "./transport";

/**
 * Outbox: every vendor write is a row in OutboundRequest, created idempotently and sent by the worker.
 * Duplicate-shipment safety (CLAUDE.md):
 *  - (connectionId, idempotencyKey) is unique, so the same write cannot be queued twice;
 *  - a request is claimed under a row lock and marked SENDING before the call, so a crash mid-call leaves
 *    evidence instead of a silent retry;
 *  - an unknown outcome (timeout/5xx) is resolved by reading back at the vendor before any retry, and
 *    becomes UNCERTAIN + an operator task when no read-back exists. UNCERTAIN is never retried automatically.
 */

export const MAX_ATTEMPTS = 5;
export const STALE_SENDING_MS = 10 * 60_000;
const backoffMs = (attempt: number) => Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));

/** Statuses the sender may (re)evaluate. Everything else is terminal or in flight. */
const PROCESSABLE = new Set<OutboundStatus>(["PENDING", "PAUSED", "AWAITING_CONFIRMATION"]);
/** An existing row in one of these states may be re-armed by a new enqueue (nothing was created at the vendor). */
const REARMABLE = new Set<OutboundStatus>(["DRY_RUN_RECORDED", "REFUSED", "FAILED"]);

export const globalOutboxPaused = () => process.env.OUTBOX_PAUSED === "1";

export interface EnqueueInput {
  accountId: string;
  connectionId: string;
  operation: string;
  idempotencyKey: string;
  payload: Prisma.InputJsonValue;
  fulfillmentId?: string | null;
  createdById?: string | null;
}

/**
 * Queues a vendor write inside the caller's account transaction (so it commits together with the state
 * change that caused it). Returns the existing request when the same key was queued before.
 */
export async function enqueueOutboundInTx(tx: Prisma.TransactionClient, input: EnqueueInput) {
  const existing = await tx.outboundRequest.findUnique({
    where: {
      connectionId_idempotencyKey: { connectionId: input.connectionId, idempotencyKey: input.idempotencyKey },
    },
  });
  if (existing && !REARMABLE.has(existing.status)) return { request: existing, created: false };
  if (existing) {
    const request = await tx.outboundRequest.update({
      where: { id: existing.id },
      data: {
        payload: input.payload,
        status: "PENDING",
        lastError: null,
        nextAttemptAt: null,
        confirmedAt: null,
        confirmedById: null,
        createdById: input.createdById ?? existing.createdById,
      },
    });
    return { request, created: true };
  }
  const request = await tx.outboundRequest.create({
    data: {
      accountId: input.accountId,
      connectionId: input.connectionId,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      fulfillmentId: input.fulfillmentId ?? null,
      createdById: input.createdById ?? null,
    },
  });
  return { request, created: true };
}

export function enqueueOutbound(input: EnqueueInput) {
  return withAccountTransaction(input.accountId, (tx) => enqueueOutboundInTx(tx, input));
}

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

type Plan =
  | { kind: "skip" }
  | { kind: "done"; status: OutboundStatus }
  | {
      kind: "send";
      accountId: string;
      createdById: string | null;
      mode: LiveMode;
      attempts: number;
      transport: OutboundTransport;
      call: OutboundCall;
    };

async function createUncertainTask(accountId: string, requestId: string, operation: string, detail: string) {
  await systemDb().alert.create({
    data: {
      accountId,
      kind: "outbox_uncertain",
      isTask: true,
      severity: "CRITICAL",
      title: `Unknown result of ${operation} — check at the warehouse before doing anything`,
      body: detail.slice(0, 2000),
      entityType: "OutboundRequest",
      entityId: requestId,
    },
  });
}

/**
 * Processes one outbound request: evaluates the liveMode gate with the connection's CURRENT mode and,
 * if allowed, sends it. Safe to call concurrently and repeatedly (row lock + status machine).
 */
export async function processOutbound(
  id: string,
  resolveTransport: TransportResolver,
  now: Date = new Date(),
): Promise<OutboundStatus | "skipped"> {
  const plan: Plan = await withSystemTransaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "OutboundRequest" WHERE id = ${id} FOR UPDATE SKIP LOCKED`;
    if (locked.length === 0) return { kind: "skip" };
    const req = await tx.outboundRequest.findUniqueOrThrow({
      where: { id },
      include: {
        connection: { select: { id: true, type: true, liveMode: true, enabled: true, canaryDailyCap: true } },
      },
    });
    if (!PROCESSABLE.has(req.status)) return { kind: "skip" };
    if (req.nextAttemptAt && req.nextAttemptAt > now) return { kind: "skip" };

    const account = await tx.account.findUniqueOrThrow({
      where: { id: req.accountId },
      select: { outboxPaused: true },
    });
    const transport = resolveTransport(req.connection);
    const mode = req.connection.liveMode;
    const canarySentToday =
      mode === "CANARY"
        ? await tx.outboundRequest.count({
            where: {
              connectionId: req.connectionId,
              status: "SENT",
              evaluatedMode: "CANARY",
              sentAt: { gte: startOfUtcDay(now) },
            },
          })
        : 0;
    const decision = evaluateGate({
      mode,
      connectionEnabled: req.connection.enabled,
      accountPaused: account.outboxPaused,
      globalPaused: globalOutboxPaused(),
      confirmed: !!req.confirmedAt,
      canarySentToday,
      canaryDailyCap: req.connection.canaryDailyCap,
      supportsTestMode: transport?.supportsTestMode?.(req.operation) ?? false,
    });

    const finish = async (status: OutboundStatus, lastError: string | null = null) => {
      await tx.outboundRequest.update({ where: { id }, data: { status, evaluatedMode: mode, lastError } });
      return { kind: "done" as const, status };
    };

    switch (decision.action) {
      case "pause":
        return finish("PAUSED", decision.reason);
      case "refuse":
        return finish("REFUSED", decision.reason);
      case "record_dry_run":
        return finish("DRY_RUN_RECORDED");
      case "await_confirmation":
        return finish("AWAITING_CONFIRMATION", decision.reason);
      case "send":
      case "send_test_mode": {
        if (!transport) {
          await tx.outboundRequest.update({
            where: { id },
            data: {
              status: "PENDING",
              evaluatedMode: mode,
              lastError: "no_transport",
              nextAttemptAt: new Date(now.getTime() + 5 * 60_000),
            },
          });
          return { kind: "done", status: "PENDING" };
        }
        const attempts = req.attempts + 1;
        await tx.outboundRequest.update({
          where: { id },
          data: { status: "SENDING", evaluatedMode: mode, attempts, lockedAt: now, lastError: null },
        });
        return {
          kind: "send",
          accountId: req.accountId,
          createdById: req.createdById,
          mode,
          attempts,
          transport,
          call: {
            operation: req.operation,
            idempotencyKey: req.idempotencyKey,
            payload: req.payload,
            testMode: decision.action === "send_test_mode",
          },
        };
      }
    }
  });

  if (plan.kind === "skip") return "skipped";
  if (plan.kind === "done") return plan.status;
  return send(id, plan, now);
}

async function send(id: string, plan: Extract<Plan, { kind: "send" }>, now: Date): Promise<OutboundStatus> {
  const db = systemDb();
  const { call, transport } = plan;
  const json = (v: unknown) =>
    v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue);
  const audit = (action: string, after: Record<string, unknown>) =>
    recordAudit({
      accountId: plan.accountId,
      userId: plan.createdById,
      action,
      entityType: "OutboundRequest",
      entityId: id,
      after: { operation: call.operation, mode: plan.mode, testMode: call.testMode, ...after },
    });

  let result;
  try {
    result = await transport.send(call);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn({ requestId: id, operation: call.operation, err: detail }, "outbound send outcome unknown");
    if (call.testMode) {
      // Validate-only call: nothing can have been created, a plain retry is safe.
      await db.outboundRequest.update({
        where: { id },
        data: {
          status: "PENDING",
          lastError: detail,
          nextAttemptAt: new Date(now.getTime() + backoffMs(plan.attempts)),
        },
      });
      return "PENDING";
    }
    if (!transport.readBack) {
      await db.outboundRequest.update({ where: { id }, data: { status: "UNCERTAIN", lastError: detail } });
      await createUncertainTask(plan.accountId, id, call.operation, `${detail} (no read-back available)`);
      await audit("outbox.uncertain", { error: detail });
      return "UNCERTAIN";
    }
    let found;
    try {
      found = await transport.readBack(call);
    } catch (readErr) {
      const rd = readErr instanceof Error ? readErr.message : String(readErr);
      await db.outboundRequest.update({
        where: { id },
        data: { status: "UNCERTAIN", lastError: `${detail}; read-back failed: ${rd}` },
      });
      await createUncertainTask(plan.accountId, id, call.operation, `${detail}; read-back failed: ${rd}`);
      await audit("outbox.uncertain", { error: detail, readBackError: rd });
      return "UNCERTAIN";
    }
    if (found.found) {
      await db.outboundRequest.update({
        where: { id },
        data: {
          status: "SENT",
          sentAt: now,
          lastResponse: json(found.response),
          lastError: `recovered by read-back after: ${detail}`,
        },
      });
      await audit("outbox.sent", { recoveredByReadBack: true });
      return "SENT";
    }
    // Confirmed not created at the vendor: retry later, or give up visibly.
    const exhausted = plan.attempts >= MAX_ATTEMPTS;
    await db.outboundRequest.update({
      where: { id },
      data: exhausted
        ? { status: "FAILED", lastError: `max attempts: ${detail}` }
        : {
            status: "PENDING",
            lastError: detail,
            nextAttemptAt: new Date(now.getTime() + backoffMs(plan.attempts)),
          },
    });
    if (exhausted) await audit("outbox.failed", { error: detail });
    return exhausted ? "FAILED" : "PENDING";
  }

  if (result.outcome === "accepted") {
    const status: OutboundStatus = call.testMode ? "DRY_RUN_RECORDED" : "SENT";
    await db.outboundRequest.update({
      where: { id },
      data: { status, lastResponse: json(result.response), ...(call.testMode ? {} : { sentAt: now }) },
    });
    await audit(call.testMode ? "outbox.test_validated" : "outbox.sent", {});
    return status;
  }
  await db.outboundRequest.update({
    where: { id },
    data: { status: "FAILED", lastResponse: json(result.response), lastError: result.error ?? "rejected" },
  });
  await audit("outbox.rejected", { error: result.error ?? "rejected" });
  return "FAILED";
}

/** Requests the sweep should hand to the sender now; also turns crashed SENDING rows into UNCERTAIN tasks. */
export async function sweepOutbox(
  now: Date = new Date(),
  limit = 200,
): Promise<{ id: string; accountId: string }[]> {
  const db = systemDb();
  const stale = await db.outboundRequest.findMany({
    where: { status: "SENDING", lockedAt: { lt: new Date(now.getTime() - STALE_SENDING_MS) } },
    select: { id: true, accountId: true, operation: true },
  });
  for (const s of stale) {
    const moved = await db.outboundRequest.updateMany({
      where: { id: s.id, status: "SENDING" },
      data: { status: "UNCERTAIN", lastError: "worker stopped during the vendor call" },
    });
    if (moved.count === 1)
      await createUncertainTask(s.accountId, s.id, s.operation, "worker stopped during the vendor call");
  }
  const due = await db.outboundRequest.findMany({
    where: { status: "PENDING", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    select: { id: true, accountId: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  return due;
}

/** CANARY: an operator confirms one exact request after seeing its payload. */
export async function confirmCanary(actor: Actor, requestId: string) {
  assertCan(actor.role, "outbox.confirmCanary");
  const updated = await withAccountTransaction(actor.accountId, async (tx) => {
    const req = await tx.outboundRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new DomainError("not_found");
    if (req.status !== "AWAITING_CONFIRMATION" && req.status !== "PENDING")
      throw new DomainError("not_confirmable");
    return tx.outboundRequest.update({
      where: { id: requestId },
      data: { confirmedAt: new Date(), confirmedById: actor.userId, status: "PENDING", nextAttemptAt: null },
    });
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "outbox.canary_confirm",
    entityType: "OutboundRequest",
    entityId: requestId,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return updated;
}

/** Kill switch: every connection of the account back to READ_ONLY and the outbox paused. Nothing is dropped. */
export async function killSwitch(actor: Actor) {
  assertCan(actor.role, "outbox.killSwitch");
  const before = await withAccountTransaction(actor.accountId, async (tx) => {
    const connections = await tx.fulfillmentConnection.findMany({ select: { id: true, liveMode: true } });
    await tx.fulfillmentConnection.updateMany({ data: { liveMode: "READ_ONLY" } });
    await tx.account.update({ where: { id: actor.accountId }, data: { outboxPaused: true } });
    return connections;
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "outbox.kill_switch",
    entityType: "Account",
    entityId: actor.accountId,
    before: { connections: before },
    after: { liveMode: "READ_ONLY", outboxPaused: true },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}

/** Lifts the pause; paused requests are re-evaluated against each connection's current mode. */
export async function resumeOutbox(actor: Actor) {
  assertCan(actor.role, "outbox.killSwitch");
  await withAccountTransaction(actor.accountId, async (tx) => {
    await tx.account.update({ where: { id: actor.accountId }, data: { outboxPaused: false } });
    await tx.outboundRequest.updateMany({
      where: { status: "PAUSED" },
      data: { status: "PENDING", nextAttemptAt: null },
    });
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "outbox.resume",
    entityType: "Account",
    entityId: actor.accountId,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}

/** Only an OWNER can raise a connection's mode; lowering is allowed to admins. Always audited. */
export async function setConnectionMode(actor: Actor, connectionId: string, mode: LiveMode) {
  const result = await withAccountTransaction(actor.accountId, async (tx) => {
    const c = await tx.fulfillmentConnection.findUnique({ where: { id: connectionId } });
    if (!c) throw new DomainError("not_found");
    assertCan(actor.role, isRaise(c.liveMode, mode) ? "connections.raiseMode" : "connections.manage");
    const updated = await tx.fulfillmentConnection.update({
      where: { id: connectionId },
      data: { liveMode: mode },
    });
    return { before: c.liveMode, after: updated.liveMode };
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "connection.mode_change",
    entityType: "FulfillmentConnection",
    entityId: connectionId,
    before: { liveMode: result.before },
    after: { liveMode: result.after },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return result;
}
