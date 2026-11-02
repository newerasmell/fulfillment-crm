import type { LiveMode, OutboundStatus, Prisma } from "@/generated/prisma/client";
import { SERVICE_NAMES } from "@/integrations/eushipments/schemas";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { validateOrder, type Finding } from "@/server/checks";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { queueEuOrder } from "@/server/eushipments/write";
import { FhbPreflightError, submitFhbOrder } from "@/server/fhb/orders";
import { FINGERPRINT_SELECT, orderFingerprint, storedFingerprint, TransitionError } from "@/server/pipeline";
import { routeOrder } from "@/server/routing";
import type { ScopedActor } from "@/server/stores";

/**
 * Fulfill one order (P4-06): the APPROVED order goes to the warehouse it was approved for, through the
 * existing vendor queue functions (submitFhbOrder / queueEuOrder) into the outbox. Nothing is sent here: the
 * outbox sender decides by the connection's CURRENT liveMode (READ_ONLY refuses, DRY_RUN records, CANARY waits
 * for a click and the daily cap, LIVE sends).
 *
 * Duplicate safety is in the database, not the UI: the vendor functions move the order APPROVED → QUEUED with
 * the pipeline's strict queue gate under the Order row lock, the Fulfillment is unique per (connection,
 * externalId) and the outbox per (connection, idempotencyKey). A double click, two operators, or bulk and single
 * on the same order therefore end in ONE shipment and ONE request; the loser gets `already_submitted`.
 */

export type FulfillItemStatus = "QUEUED" | "BLOCKED" | "NEEDS_ACK" | "SKIPPED" | "FAILED";

export interface FulfillResult {
  status: FulfillItemStatus;
  code: string | null;
  findings: Finding[];
  connectionId: string | null;
  liveMode: LiveMode | null;
  requestId: string | null;
}

/** Order statuses Fulfill acts on. QUEUED only re-arms a request that never left (dry run, refused). */
const FULFILLABLE = new Set(["APPROVED", "SUBMIT_FAILED", "QUEUED"]);

const result = (status: FulfillItemStatus, code: string | null, extra: Partial<FulfillResult> = {}) => ({
  status,
  code,
  findings: [],
  connectionId: null,
  liveMode: null,
  requestId: null,
  ...extra,
});

/** Codes from the vendor functions that mean "someone else already queued / sent it". */
const ALREADY = new Set(["fhb_already_submitted", "duplicate_reference", "transition_not_allowed"]);

export interface FulfillOptions {
  /** The operator saw the new soft warnings (not in the reviewed check) and sends anyway. */
  acknowledge?: boolean;
  now?: Date;
}

/** Fulfill one order. Never throws for an order-level problem: the result says what happened. */
export async function fulfillOrder(
  actor: ScopedActor,
  orderId: string,
  opts: FulfillOptions = {},
): Promise<FulfillResult> {
  assertCan(actor.role, "orders.fulfill");
  const db = accountDb(actor.accountId);
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      ...FINGERPRINT_SELECT,
      id: true,
      status: true,
      companyId: true,
      check: { select: { connectionId: true, findings: true, hardCount: true, normalised: true } },
      fulfillments: { where: { status: "QUEUED" }, select: { connectionId: true } },
    },
  });
  if (!order || (actor.companyScope && !actor.companyScope.includes(order.companyId ?? "")))
    return result("FAILED", "not_found");
  if (!FULFILLABLE.has(order.status)) return result("SKIPPED", `status_${order.status.toLowerCase()}`);

  // The warehouse the order was approved for (its stored check), or the shipment already queued.
  const connectionId = order.fulfillments[0]?.connectionId ?? order.check?.connectionId ?? null;
  if (!order.check || !connectionId) return result("BLOCKED", "no_connection");
  if (storedFingerprint(order.check.normalised) !== orderFingerprint(order))
    return result("BLOCKED", "check_stale", { connectionId });
  const connection = await db.fulfillmentConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, type: true, liveMode: true, enabled: true },
  });
  if (!connection) return result("BLOCKED", "no_connection");
  const base = { connectionId, liveMode: connection.liveMode };
  if (!connection.enabled) return result("BLOCKED", "connection_disabled", base);
  // An extra early refusal; the outbox sender is still the gate that counts.
  if (connection.liveMode === "READ_ONLY") return result("BLOCKED", "connection_read_only", base);

  // Validate again NOW (stock and vendor rules move), for the approved warehouse.
  const [routing, fresh] = await Promise.all([
    routeOrder(actor.accountId, orderId),
    validateOrder(actor.accountId, orderId, { connectionId, persist: false, now: opts.now }),
  ]);
  const hard = fresh.findings.filter((f) => f.severity === "hard");
  if (hard.length) return result("BLOCKED", "hard_findings", { ...base, findings: hard });
  const reviewed = new Set(((order.check.findings ?? []) as unknown as Finding[]).map((f) => f.code));
  const newSoft = fresh.findings.filter((f) => f.severity === "soft" && !reviewed.has(f.code));
  if (newSoft.length && !opts.acknowledge)
    return result("NEEDS_ACK", "new_warnings", { ...base, findings: newSoft });

  const carrier = routing.connectionId === connectionId ? routing.carrier : null;
  try {
    if (connection.type === "FHB_V3") {
      const r = await submitFhbOrder(actor, {
        orderId,
        connectionId,
        parcelService: carrier?.parcelService ?? null,
        // Every soft finding was seen: at review (stored check) or just now (acknowledge).
        acknowledgeWarnings: true,
      });
      return result("QUEUED", null, { ...base, requestId: r.request.id, liveMode: r.liveMode });
    }
    if (connection.type === "EUSHIPMENTS") {
      const courierId = carrier?.courierId ? Number(carrier.courierId) : NaN;
      const serviceName = (SERVICE_NAMES as readonly string[]).includes(carrier?.serviceName ?? "")
        ? (carrier!.serviceName as (typeof SERVICE_NAMES)[number])
        : undefined;
      const acknowledged = fresh.findings
        .filter((f) => f.source === "eushipments" && f.severity === "soft")
        .map((f) => f.code.replace(/^eushipments\./, ""));
      const r = await queueEuOrder(
        actor,
        {
          orderId,
          connectionId,
          ...(Number.isInteger(courierId) && courierId > 0 ? { courierId } : {}),
          ...(serviceName ? { serviceName } : {}),
          acknowledged,
        },
        opts.now,
      );
      if (r.status === "queued") return result("QUEUED", null, { ...base, requestId: r.requestId });
      return result(r.status === "blocked" ? "BLOCKED" : "NEEDS_ACK", `eushipments_${r.status}`, {
        ...base,
        findings: r.findings.map((f) => ({
          code: `eushipments.${f.code}`,
          severity: f.severity === "block" ? "hard" : "soft",
          source: "eushipments",
          field: f.field,
          message_bg: f.message_bg,
          message_en: f.message_en,
        })),
      });
    }
    return result("BLOCKED", "connection_type_unsupported", base);
  } catch (err) {
    if (err instanceof FhbPreflightError)
      return result("BLOCKED", err.code, {
        ...base,
        findings: err.findings.map((f) => ({
          code: f.code,
          severity: f.severity,
          source: "fhb",
          field: f.field,
          message_bg: f.message_bg,
          message_en: f.message_en,
        })),
      });
    if (err instanceof TransitionError) return result("SKIPPED", "already_submitted", base);
    if (err instanceof DomainError)
      return result(
        ALREADY.has(err.code) ? "SKIPPED" : "FAILED",
        ALREADY.has(err.code) ? "already_submitted" : err.code,
        base,
      );
    throw err;
  }
}

// ───────────────────────── CANARY confirmation ─────────────────────────

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** What the CANARY dialog shows: the exact stored payload and today's remaining cap. */
export interface CanaryView {
  requestId: string;
  status: OutboundStatus;
  operation: string;
  confirmed: boolean;
  payload: Prisma.JsonValue;
  cap: number;
  usedToday: number;
  remaining: number;
}

/** Sends that count against today's cap, exactly as the outbox sender counts them. */
async function canaryUsedToday(accountId: string, connectionId: string, now: Date) {
  return accountDb(accountId).outboundRequest.count({
    where: {
      connectionId,
      evaluatedMode: "CANARY",
      status: { in: ["SENDING", "SENT", "UNCERTAIN"] },
      lockedAt: { gte: startOfUtcDay(now) },
    },
  });
}

async function scopedRequest(actor: ScopedActor, requestId: string) {
  const req = await accountDb(actor.accountId).outboundRequest.findUnique({
    where: { id: requestId },
    include: {
      connection: { select: { id: true, liveMode: true, canaryDailyCap: true } },
      fulfillment: { select: { order: { select: { companyId: true } } } },
    },
  });
  const companyId = req?.fulfillment?.order.companyId ?? "";
  if (!req || !req.fulfillment || (actor.companyScope && !actor.companyScope.includes(companyId)))
    throw new DomainError("not_found");
  return req;
}

/** The CANARY dialog for one queued request (permission: outbox.confirmCanary — the confirmer sees what is sent). */
export async function canaryView(
  actor: ScopedActor,
  requestId: string,
  now = new Date(),
): Promise<CanaryView> {
  assertCan(actor.role, "outbox.confirmCanary");
  const req = await scopedRequest(actor, requestId);
  const used = await canaryUsedToday(actor.accountId, req.connectionId, now);
  return {
    requestId: req.id,
    status: req.status,
    operation: req.operation,
    confirmed: !!req.confirmedAt,
    payload: req.payload,
    cap: req.connection.canaryDailyCap,
    usedToday: used,
    remaining: Math.max(0, req.connection.canaryDailyCap - used),
  };
}

/**
 * CANARY: the operator confirms ONE exact request after seeing its payload. Like the outbox's confirmCanary,
 * but also accepts a request the sender has not evaluated yet (PENDING), so the click can follow Fulfill
 * directly. Same lock order (connection, then request) and a conditional write; the sender still applies the
 * daily cap and re-checks the mode. A re-armed request (new payload) clears the confirmation in the outbox.
 */
export async function confirmFulfillCanary(actor: ScopedActor, requestId: string) {
  assertCan(actor.role, "outbox.confirmCanary");
  const head = await scopedRequest(actor, requestId);
  await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("FulfillmentConnection", head.connectionId);
    const c = await tx.fulfillmentConnection.findUniqueOrThrow({
      where: { id: head.connectionId },
      select: { liveMode: true },
    });
    if (c.liveMode !== "CANARY") throw new DomainError("not_confirmable");
    const res = await tx.outboundRequest.updateMany({
      where: { id: requestId, status: { in: ["PENDING", "AWAITING_CONFIRMATION"] }, confirmedAt: null },
      data: { confirmedAt: new Date(), confirmedById: actor.userId, status: "PENDING", nextAttemptAt: null },
    });
    if (res.count !== 1) throw new DomainError("not_confirmable");
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
}
