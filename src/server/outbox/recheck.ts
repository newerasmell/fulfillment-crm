import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { scrubText } from "@/lib/scrub";
import { logger } from "@/lib/logger";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, systemDb } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";
import { globalOutboxPaused, READBACK_FAILED, resolveUncertainTasks, WORKER_STOPPED } from "./outbox";
import type { TransportResolver } from "./transport";

/**
 * "Провери в склада" (owner report 2026-11-11: a deploy restarted the worker inside an euShipments create-order;
 * the request became UNCERTAIN, the order stayed "На опашка", the order was not at the warehouse, and nothing in
 * the CRM could send it again). An OWNER / ADMIN asks the CRM to look the order up at the warehouse — never
 * automatic, so a request a person already handled (entered by hand, sent elsewhere) is never touched on its own:
 *  - only a create-order whose worker stopped mid-call (`WORKER_STOPPED`), whose read-back is a plain lookup by our
 *    deterministic reference (euShipments orders-history, FHB GET /order), on a LIVE / CANARY connection that is on
 *    and not paused, for a shipment still waiting to reach the warehouse, and 15+ min after the call began;
 *  - found at the warehouse → SENT (the vendor effect records the shipment), the task resolved;
 *  - confirmed absent → PENDING: it goes out again through the liveMode gate (CANARY asks for a new click;
 *    euShipments looks orders-history up once more right before every create-order);
 *  - the lookup fails, or the reference is a deleted shipment there → stays UNCERTAIN with the reason.
 * The web only marks the request; the worker asks the warehouse (no vendor call from a route handler).
 */

/** Create-orders whose read-back is a side-effect-free lookup by our deterministic reference. */
export const RECHECKABLE_OPS = new Set(["eushipments.createOrder", "fhb.order.create"]);
/** The call began at least this long ago: far past every vendor timeout and retry of a slow worker. */
export const RECHECK_MIN_AGE_MS = 15 * 60_000;
/** Marker while the worker checks (a lost job can be asked for again after this). */
export const RECHECKING = `${WORKER_STOPPED}; checking at the warehouse`;
/** The reference is a deleted / cancelled shipment at the warehouse: a person decides (never sent again). */
export const DELETED_THERE = `${WORKER_STOPPED}; deleted/cancelled at the warehouse`;
const RECHECK_RETRY_MS = 10 * 60_000;
/** Shipment statuses that mean "on its way to the warehouse, not accepted there". */
const WAITING = new Set(["QUEUED", "SUBMITTING"]);

export const RecheckInput = z.object({ requestId: z.string().min(1).max(64) });

type Why =
  | "not_found"
  | "not_uncertain"
  | "not_recheckable"
  | "too_recent"
  | "mode_not_live"
  | "outbox_paused"
  | "shipment_moved"
  | "checking"
  | "task_resolved"
  | "deleted_there";

/** Why a request cannot be checked at the warehouse now (null = it can). Pure. */
export function recheckRefusal(
  r: {
    status: string;
    operation: string;
    lastError: string | null;
    evaluatedMode: string | null;
    lockedAt: Date | null;
    updatedAt: Date;
    connection: { liveMode: string; enabled: boolean };
    fulfillment: { status: string } | null;
  },
  accountPaused: boolean,
  now: Date,
  /** A person closed the "unknown result" task (handled it by hand: entered in the cabinet, not shipping …). */
  taskResolved = false,
): Why | null {
  if (r.status !== "UNCERTAIN") return "not_uncertain";
  if (!RECHECKABLE_OPS.has(r.operation)) return "not_recheckable";
  // A send that timed out and whose read-back could not decide (e.g. euShipments "not found"): checked the same way.
  const undecided = !!r.lastError?.includes(READBACK_FAILED);
  if (r.lastError === DELETED_THERE || (undecided && /deleted\/cancelled/i.test(r.lastError ?? "")))
    return "deleted_there";
  if (taskResolved) return "task_resolved";
  const checking = r.lastError === RECHECKING;
  if (r.lastError !== WORKER_STOPPED && !checking && !undecided) return "not_recheckable";
  if (checking && now.getTime() - r.updatedAt.getTime() < RECHECK_RETRY_MS) return "checking";
  // The interrupted call was a real one (a DRY_RUN validate-only call is never looked up as if it were real).
  if (r.evaluatedMode !== "LIVE" && r.evaluatedMode !== "CANARY") return "mode_not_live";
  if ((r.connection.liveMode !== "LIVE" && r.connection.liveMode !== "CANARY") || !r.connection.enabled)
    return "mode_not_live";
  if (accountPaused || globalOutboxPaused()) return "outbox_paused";
  if (!r.fulfillment || !WAITING.has(r.fulfillment.status)) return "shipment_moved";
  if (!r.lockedAt || now.getTime() - r.lockedAt.getTime() < RECHECK_MIN_AGE_MS) return "too_recent";
  return null;
}

const select = {
  id: true,
  accountId: true,
  status: true,
  operation: true,
  idempotencyKey: true,
  payload: true,
  lastError: true,
  lastResponse: true,
  evaluatedMode: true,
  lockedAt: true,
  updatedAt: true,
  connection: {
    select: {
      id: true,
      type: true,
      liveMode: true,
      enabled: true,
      account: { select: { outboxPaused: true } },
    },
  },
  fulfillment: { select: { status: true, order: { select: { id: true, companyId: true } } } },
} satisfies Prisma.OutboundRequestSelect;

type RecheckInfo = { error?: string; at?: string; original?: string };
const recheckOf = (v: unknown): RecheckInfo =>
  ((v as { recheck?: RecheckInfo } | null)?.recheck ?? {}) as RecheckInfo;
/** The send's own error before any check (kept across checks). */
const originalOf = (r: { lastError: string | null; lastResponse: unknown }) =>
  (recheckOf(r.lastResponse).original ?? r.lastError ?? "").slice(0, 1000);

/** Whether a person already closed the request's "unknown result" task (and none is open). */
async function taskResolved(accountId: string, requestId: string) {
  const tasks = await systemDb().alert.findMany({
    where: { accountId, entityType: "OutboundRequest", entityId: requestId, kind: "outbox_uncertain" },
    select: { status: true },
  });
  return tasks.length > 0 && tasks.every((t) => t.status === "RESOLVED");
}

/** A note on the request's open "unknown result" task (what the check found). */
async function noteTasks(accountId: string, requestId: string, userId: string, note: string) {
  const db = systemDb();
  const open = await db.alert.findMany({
    where: {
      accountId,
      entityType: "OutboundRequest",
      entityId: requestId,
      kind: "outbox_uncertain",
      status: { not: "RESOLVED" },
    },
    select: { id: true },
  });
  for (const a of open)
    await db.alertNote.create({ data: { accountId, alertId: a.id, userId, action: "note", note } });
}

/** Web: an OWNER / ADMIN asks for the check; marks the request (the worker job does the lookup). Audited. */
export async function requestWarehouseRecheck(
  actor: ScopedActor,
  raw: z.input<typeof RecheckInput>,
  now: Date = new Date(),
) {
  assertCan(actor.role, "stores.manage");
  const { requestId } = RecheckInput.parse(raw);
  const db = accountDb(actor.accountId);
  const r = await db.outboundRequest.findFirst({
    where: { id: requestId, accountId: actor.accountId },
    select,
  });
  const companyId = r?.fulfillment?.order.companyId ?? "";
  if (!r || (actor.companyScope && !actor.companyScope.includes(companyId)))
    throw new DomainError("not_found");
  const why = recheckRefusal(
    r,
    r.connection.account.outboxPaused,
    now,
    await taskResolved(actor.accountId, r.id),
  );
  if (why) throw new DomainError(`recheck_${why}`);
  const claimed = await db.outboundRequest.updateMany({
    where: { id: r.id, accountId: actor.accountId, status: "UNCERTAIN", lastError: r.lastError },
    data: {
      lastError: RECHECKING,
      // The first error of the send (e.g. "timeout; read-back failed: …") is kept: the marker replaces it.
      lastResponse: { recheck: { ...recheckOf(r.lastResponse), original: originalOf(r) } },
    },
  });
  if (claimed.count !== 1) throw new DomainError("recheck_checking");
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "outbox.recheck_requested",
    entityType: "OutboundRequest",
    entityId: r.id,
    after: { operation: r.operation, idempotencyKey: r.idempotencyKey },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return {
    requestId: r.id,
    accountId: actor.accountId,
    orderId: r.fulfillment?.order.id ?? null,
    userId: actor.userId,
  };
}

export interface RecheckJob {
  requestId: string;
  accountId: string;
  userId: string;
}

/** Worker: the lookup at the warehouse for one marked request. Every condition is checked again first. */
export async function runWarehouseRecheck(
  job: RecheckJob,
  resolveTransport: TransportResolver,
  now: Date = new Date(),
): Promise<"SENT" | "PENDING" | "UNCERTAIN" | "skipped"> {
  const db = systemDb();
  const r = await db.outboundRequest.findFirst({
    where: { id: job.requestId, accountId: job.accountId },
    select,
  });
  if (!r || r.lastError !== RECHECKING) return "skipped";
  const back = (lastError: string, checkError?: string) =>
    db.outboundRequest.updateMany({
      where: { id: r.id, accountId: r.accountId, status: "UNCERTAIN", lastError: RECHECKING },
      data: {
        lastError: lastError.slice(0, 2000),
        // What the last check said, shown on the order (the request's own response stays empty: never answered).
        ...(checkError
          ? {
              lastResponse: {
                recheck: {
                  error: checkError.slice(0, 500),
                  at: now.toISOString(),
                  ...(recheckOf(r.lastResponse).original
                    ? { original: recheckOf(r.lastResponse).original }
                    : {}),
                },
              },
            }
          : {}),
      },
    });
  // Conditions again (mode lowered, kill switch, shipment moved since the click): give the request back unchanged.
  const why = recheckRefusal(
    { ...r, lastError: WORKER_STOPPED },
    r.connection.account.outboxPaused,
    now,
    await taskResolved(r.accountId, r.id),
  );
  const transport = resolveTransport(r.connection);
  if (why || !transport?.readBack) {
    await back(WORKER_STOPPED);
    return "UNCERTAIN";
  }
  let found;
  try {
    found = await transport.readBack({
      operation: r.operation,
      idempotencyKey: r.idempotencyKey,
      payload: r.payload,
      testMode: false,
    });
  } catch (err) {
    const detail = scrubText(err instanceof Error ? err.message : String(err));
    logger.warn({ requestId: r.id, err: detail }, "warehouse recheck failed");
    // Deleted there: a person decides. Otherwise back to the plain marker: pressed again once the warehouse answers.
    const deleted = /deleted\/cancelled/i.test(detail);
    await back(deleted ? DELETED_THERE : WORKER_STOPPED, detail);
    await noteTasks(r.accountId, r.id, job.userId, `Проверка в склада: неуспешна — ${detail}`.slice(0, 1000));
    await recordAudit({
      accountId: r.accountId,
      userId: job.userId,
      action: "outbox.recheck_failed",
      entityType: "OutboundRequest",
      entityId: r.id,
      after: { error: detail },
    });
    return "UNCERTAIN";
  }
  const json = (v: unknown) =>
    v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue);
  const moved = await db.outboundRequest.updateMany({
    where: { id: r.id, accountId: r.accountId, status: "UNCERTAIN", lastError: RECHECKING },
    data: found.found
      ? {
          status: "SENT",
          sentAt: now,
          lastResponse: json(found.response),
          lastError: `found at the warehouse (check) after: ${WORKER_STOPPED}`,
        }
      : {
          status: "PENDING",
          nextAttemptAt: null,
          // A CANARY request needs a new click for the new send.
          confirmedAt: null,
          confirmedById: null,
          lastError: `not at the warehouse (check) after: ${WORKER_STOPPED}`,
        },
  });
  if (moved.count !== 1) return "skipped";
  await recordAudit({
    accountId: r.accountId,
    userId: job.userId,
    action: found.found ? "outbox.sent" : "outbox.recheck_absent",
    entityType: "OutboundRequest",
    entityId: r.id,
    after: { operation: r.operation, idempotencyKey: r.idempotencyKey, recoveredByReadBack: found.found },
  });
  if (found.found) await resolveUncertainTasks(r.accountId, r.id, "found at the warehouse: marked sent", now);
  else
    await noteTasks(
      r.accountId,
      r.id,
      job.userId,
      "Проверка в склада: поръчката я няма — изпраща се отново (при „Канарче“ чака потвърждение).",
    );
  return found.found ? "SENT" : "PENDING";
}

/** The order's create-orders with an unknown result, per shipment, and whether "Провери в склада" can run now. */
export async function uncertainCreatesOf(actor: ScopedActor, orderId: string, now: Date = new Date()) {
  const db = accountDb(actor.accountId);
  const rows = await db.outboundRequest.findMany({
    where: {
      accountId: actor.accountId,
      status: "UNCERTAIN",
      operation: { in: [...RECHECKABLE_OPS] },
      fulfillment: {
        orderId,
        ...(actor.companyScope ? { order: { companyId: { in: actor.companyScope } } } : {}),
      },
    },
    select: { ...select, fulfillmentId: true },
    orderBy: { createdAt: "asc" },
  });
  const out = [];
  for (const r of rows)
    out.push({
      requestId: r.id,
      fulfillmentId: r.fulfillmentId,
      refusal: recheckRefusal(
        r,
        r.connection.account.outboxPaused,
        now,
        await taskResolved(r.accountId, r.id),
      ),
      lastCheckError: (r.lastResponse as { recheck?: { error?: string } } | null)?.recheck?.error ?? null,
      canConfirmAbsent: r.operation === "eushipments.createOrder",
    });
  return out;
}

/**
 * "Проверих в кабинета — няма я, изпрати": after a check that could not find it (orders-history does not list every
 * order — owner report 2026-11-12), an OWNER / ADMIN who looked in the warehouse's cabinet sends it again. Only after
 * such a check, under the same conditions as the check itself. Through the gate (CANARY asks for a new click).
 */
export async function confirmAbsentAndResend(
  actor: ScopedActor,
  raw: z.input<typeof RecheckInput>,
  now: Date = new Date(),
) {
  assertCan(actor.role, "stores.manage");
  const { requestId } = RecheckInput.parse(raw);
  const db = accountDb(actor.accountId);
  const r = await db.outboundRequest.findFirst({
    where: { id: requestId, accountId: actor.accountId },
    select,
  });
  const companyId = r?.fulfillment?.order.companyId ?? "";
  if (!r || (actor.companyScope && !actor.companyScope.includes(companyId)))
    throw new DomainError("not_found");
  const why = recheckRefusal(
    r,
    r.connection.account.outboxPaused,
    now,
    await taskResolved(actor.accountId, r.id),
  );
  if (why) throw new DomainError(`recheck_${why}`);
  // euShipments only: its lookup cannot prove absence. FHB's GET /order can (absent → sent again on its own).
  if (r.operation !== "eushipments.createOrder") throw new DomainError("recheck_not_recheckable");
  if (!(r.lastResponse as { recheck?: { error?: string } } | null)?.recheck?.error)
    throw new DomainError("recheck_first");
  const moved = await db.outboundRequest.updateMany({
    where: { id: r.id, accountId: actor.accountId, status: "UNCERTAIN", lastError: WORKER_STOPPED },
    data: {
      status: "PENDING",
      nextAttemptAt: null,
      confirmedAt: null,
      confirmedById: null,
      lastError: `not in the warehouse's cabinet (checked by a person) after: ${WORKER_STOPPED}`,
    },
  });
  if (moved.count !== 1) throw new DomainError("recheck_checking");
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "outbox.resend_confirmed_absent",
    entityType: "OutboundRequest",
    entityId: r.id,
    after: { operation: r.operation, idempotencyKey: r.idempotencyKey },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  await noteTasks(
    actor.accountId,
    r.id,
    actor.userId,
    "Проверено в кабинета: поръчката я няма — изпраща се отново.",
  );
  return { requestId: r.id, accountId: actor.accountId, orderId: r.fulfillment?.order.id ?? null };
}
