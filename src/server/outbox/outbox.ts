import { z } from "zod";
import type { LiveMode, OutboundStatus, Prisma } from "@/generated/prisma/client";
import type { Actor } from "@/server/accounts";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import {
  isUniqueViolation,
  systemDb,
  withAccountTransaction,
  withSystemTransaction,
} from "@/server/db/client";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
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
 * Transports must time out well below STALE_SENDING_MS.
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
 * A concurrent enqueue of the same key fails with a unique violation (P2002): retry the transaction.
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
        attempts: 0,
        evaluatedMode: null,
        lastError: null,
        lastResponse: undefined,
        lockedAt: null,
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

/** Standalone, idempotent enqueue: a lost race on the unique key is retried once and finds the winner. */
export async function enqueueOutbound(input: EnqueueInput) {
  try {
    return await withAccountTransaction(input.accountId, (tx) => enqueueOutboundInTx(tx, input));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return withAccountTransaction(input.accountId, (tx) => enqueueOutboundInTx(tx, input));
  }
}

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

type Plan =
  | { kind: "skip" }
  | { kind: "done"; status: OutboundStatus }
  | {
      kind: "send";
      accountId: string;
      createdById: string | null;
      confirmedById: string | null;
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
 * if allowed, sends it. Safe to call concurrently and repeatedly (row locks + status machine).
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
    const req = await tx.outboundRequest.findUniqueOrThrow({ where: { id } });
    if (!PROCESSABLE.has(req.status)) return { kind: "skip" };
    if (req.nextAttemptAt && req.nextAttemptAt > now) return { kind: "skip" };

    // Serialise evaluations per connection: the CANARY cap below must see every concurrent claim, and a
    // mode change or kill switch (which lock the same row) cannot interleave with an evaluation.
    await tx.$queryRaw`SELECT id FROM "FulfillmentConnection" WHERE id = ${req.connectionId} FOR UPDATE`;
    const connection = await tx.fulfillmentConnection.findUniqueOrThrow({
      where: { id: req.connectionId },
      select: { id: true, type: true, liveMode: true, enabled: true, canaryDailyCap: true },
    });
    const account = await tx.account.findUniqueOrThrow({
      where: { id: req.accountId },
      select: { outboxPaused: true, killSwitchAt: true },
    });
    const transport = resolveTransport(connection);
    const mode = connection.liveMode;
    // Everything that may have reached the vendor today counts: in flight, sent, or unknown outcome.
    const canarySentToday =
      mode === "CANARY"
        ? await tx.outboundRequest.count({
            where: {
              connectionId: req.connectionId,
              evaluatedMode: "CANARY",
              status: { in: ["SENDING", "SENT", "UNCERTAIN"] },
              lockedAt: { gte: startOfUtcDay(now) },
            },
          })
        : 0;
    const decision = evaluateGate({
      mode,
      connectionEnabled: connection.enabled,
      accountPaused: account.outboxPaused,
      globalPaused: globalOutboxPaused(),
      confirmed: !!req.confirmedAt,
      canarySentToday,
      canaryDailyCap: connection.canaryDailyCap,
      supportsTestMode: transport?.supportsTestMode?.(req.operation) ?? false,
      queuedBeforeKillSwitch: !!account.killSwitchAt && req.createdAt <= account.killSwitchAt,
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
          confirmedById: req.confirmedById,
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
  // Every production write is logged with request reference, response, user(s) and mode (INTEGRATION_NOTES §6).
  const audit = (action: string, after: Record<string, unknown>) =>
    recordAudit({
      accountId: plan.accountId,
      userId: plan.confirmedById ?? plan.createdById,
      action,
      entityType: "OutboundRequest",
      entityId: id,
      after: {
        operation: call.operation,
        idempotencyKey: call.idempotencyKey,
        mode: plan.mode,
        testMode: call.testMode,
        createdById: plan.createdById,
        confirmedById: plan.confirmedById,
        ...after,
      },
    });

  /**
   * Writes the outcome only while the row is still SENDING. If the sweep already declared it UNCERTAIN
   * (the call took too long), the late result goes to the audit log for the operator instead.
   */
  const finalize = async (data: Prisma.OutboundRequestUpdateManyMutationInput, status: OutboundStatus) => {
    const res = await db.outboundRequest.updateMany({
      where: { id, status: "SENDING" },
      data: { ...data, status },
    });
    if (res.count === 1) return status;
    const current = await db.outboundRequest.findUniqueOrThrow({ where: { id }, select: { status: true } });
    await audit("outbox.late_result", { wouldBe: status, lastError: data.lastError ?? null });
    return current.status;
  };

  let result;
  try {
    result = await transport.send(call);
  } catch (err) {
    const detail = scrubText(err instanceof Error ? err.message : String(err));
    logger.warn({ requestId: id, operation: call.operation, err: detail }, "outbound send outcome unknown");
    if (call.testMode) {
      // Validate-only call: nothing can have been created, a plain retry is safe.
      return finalize(
        { lastError: detail, nextAttemptAt: new Date(now.getTime() + backoffMs(plan.attempts)) },
        "PENDING",
      );
    }
    if (!transport.readBack) {
      const status = await finalize({ lastError: detail }, "UNCERTAIN");
      if (status === "UNCERTAIN") {
        await createUncertainTask(plan.accountId, id, call.operation, `${detail} (no read-back available)`);
        await audit("outbox.uncertain", { error: detail });
      }
      return status;
    }
    let found;
    try {
      found = await transport.readBack(call);
    } catch (readErr) {
      const rd = scrubText(readErr instanceof Error ? readErr.message : String(readErr));
      const status = await finalize({ lastError: `${detail}; read-back failed: ${rd}` }, "UNCERTAIN");
      if (status === "UNCERTAIN") {
        await createUncertainTask(plan.accountId, id, call.operation, `${detail}; read-back failed: ${rd}`);
        await audit("outbox.uncertain", { error: detail, readBackError: rd });
      }
      return status;
    }
    if (found.found) {
      const status = await finalize(
        {
          sentAt: now,
          lastResponse: json(found.response),
          lastError: `recovered by read-back after: ${detail}`,
        },
        "SENT",
      );
      await audit("outbox.sent", { recoveredByReadBack: true, response: found.response ?? null });
      return status;
    }
    // Confirmed not created at the vendor: retry later, or give up visibly.
    if (plan.attempts >= MAX_ATTEMPTS) {
      const status = await finalize({ lastError: `max attempts: ${detail}` }, "FAILED");
      await audit("outbox.failed", { error: detail });
      return status;
    }
    return finalize(
      { lastError: detail, nextAttemptAt: new Date(now.getTime() + backoffMs(plan.attempts)) },
      "PENDING",
    );
  }

  if (result.outcome === "accepted") {
    const status = await finalize(
      { lastResponse: json(result.response), ...(call.testMode ? {} : { sentAt: now }) },
      call.testMode ? "DRY_RUN_RECORDED" : "SENT",
    );
    await audit(call.testMode ? "outbox.test_validated" : "outbox.sent", {
      response: result.response ?? null,
    });
    return status;
  }
  const error = scrubText(result.error ?? "rejected");
  const status = await finalize({ lastResponse: json(result.response), lastError: error }, "FAILED");
  await audit("outbox.rejected", { error, response: result.response ?? null });
  return status;
}

/**
 * Requests the sweep should hand to the sender now; also turns crashed SENDING rows into UNCERTAIN tasks.
 * Besides PENDING, it re-picks rows the sender parked but may now be able to move: confirmed CANARY requests
 * held by the daily cap, and PAUSED rows once neither the global nor the account pause is on (those queued
 * before a kill switch are held again while their connection is still READ_ONLY — never refused).
 */
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
    where: {
      OR: [
        { status: "PENDING", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        { status: "AWAITING_CONFIRMATION", confirmedAt: { not: null } },
        ...(globalOutboxPaused()
          ? []
          : [{ status: "PAUSED" as const, connection: { account: { outboxPaused: false } } }]),
      ],
    },
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
    const req = await tx.outboundRequest.findUnique({
      where: { id: requestId },
      include: { connection: { select: { liveMode: true } } },
    });
    if (!req) throw new DomainError("not_found");
    if (req.status !== "AWAITING_CONFIRMATION" || req.connection.liveMode !== "CANARY") {
      throw new DomainError("not_confirmable");
    }
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
  const before = await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("FulfillmentConnection");
    const connections = await tx.fulfillmentConnection.findMany({ select: { id: true, liveMode: true } });
    await tx.fulfillmentConnection.updateMany({ data: { liveMode: "READ_ONLY" } });
    await tx.account.update({
      where: { id: actor.accountId },
      data: { outboxPaused: true, killSwitchAt: new Date() },
    });
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

/**
 * Lifts the pause. Paused requests are re-evaluated against each connection's current mode; those queued
 * before the kill switch stay held while their connection is still READ_ONLY.
 */
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

const LiveModeSchema = z.enum(["READ_ONLY", "DRY_RUN", "CANARY", "LIVE"]);

/** Only an OWNER can raise a connection's mode; lowering is allowed to admins. Always audited. */
export async function setConnectionMode(actor: Actor, connectionId: string, rawMode: LiveMode) {
  const mode = LiveModeSchema.parse(rawMode);
  const result = await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    // Locked read: a concurrent kill switch cannot interleave, so "is this a raise?" is decided on the
    // current mode, not a stale one.
    await lockForUpdate("FulfillmentConnection", connectionId);
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
