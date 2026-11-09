import type { AiLevel, CrmOrderStatus, Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { withAccountTransaction } from "@/server/db/client";
import { hasStoreTag, shopifyTagsOf } from "@/server/shopify/order-tag-match";
import { currentOrderFingerprint, storedFingerprint } from "./fingerprint";
import { isAllowed, type ActorKind, type TransitionCause } from "./rules";

/**
 * THE way to change Order.status (SPEC §6.1). Every move is checked against the rule table (./rules.ts) and
 * the cause's guard, applied with a compare-and-set on the current status (a concurrent change is never
 * overwritten), and recorded as an OrderEvent (timeline) in the same transaction; moves made by a person
 * are also written to the AuditLog.
 *
 * Usage (inside an account transaction you already hold):
 *   await transition(tx, { orderId, to: "APPROVED", cause: "approve", actor: { kind: "user", userId } });
 * or on its own:
 *   await transitionOrder(accountId, { ... });
 *
 * Modes: "strict" (default for people and AI) throws TransitionError when the move is not allowed;
 * "follow" (default for system/vendor updates, which arrive late, repeated or out of order) returns
 * { changed: false } instead — e.g. a late "Shipped" after "Delivered" simply does nothing.
 */

export type PipelineActor =
  | { kind: "user"; userId: string }
  | { kind: "system" }
  /**
   * An AI decision. `policyId` names the AiPolicy that allowed it; the approve guard loads that policy and
   * trusts only what is stored there (`level` is informational, recorded on the event).
   */
  | { kind: "ai"; level: AiLevel; policyId: string };

export interface TransitionInput {
  orderId: string;
  to: CrmOrderStatus;
  cause: TransitionCause;
  actor: PipelineActor;
  /** Code path that moved it, e.g. "shopify.import", "eushipments.history" (stored on the event). */
  source?: string;
  /** Operator's free-text reason / reason code (stored on the event and the audit entry). */
  reason?: string | null;
  meta?: Record<string, unknown>;
  /** Narrows the rule table for this call (a caller whose own precondition is stricter). Never widens it. */
  onlyFrom?: readonly CrmOrderStatus[];
  mode?: "strict" | "follow";
}

export type RefusalReason = "not_found" | "not_allowed" | "guard" | "race";

export type TransitionResult =
  | { changed: true; from: CrmOrderStatus; to: CrmOrderStatus; eventId: string }
  | {
      changed: false;
      from: CrmOrderStatus | null;
      to: CrmOrderStatus;
      /** "same" = already in the target status (no event written). */
      reason: RefusalReason | "same";
      /** Guard code when reason = "guard". */
      guard?: string;
    };

export class TransitionError extends DomainError {
  constructor(
    public readonly reason: RefusalReason,
    public readonly from: CrmOrderStatus | null,
    public readonly to: CrmOrderStatus,
    public readonly guard?: string,
  ) {
    super(
      reason === "not_found"
        ? "not_found"
        : reason === "guard"
          ? `transition_guard:${guard}`
          : `transition_${reason}`,
      `order transition ${from ?? "?"} → ${to} refused: ${guard ?? reason}`,
    );
    this.name = "TransitionError";
  }
}

type Tx = Prisma.TransactionClient;

export interface GuardContext {
  order: { id: string; accountId: string; status: CrmOrderStatus; tags: string[] };
  to: CrmOrderStatus;
  actor: PipelineActor;
  meta?: Record<string, unknown>;
}

/** Returns a guard code when the move must not happen, null when it may. */
export type Guard = (tx: Tx, ctx: GuardContext) => Promise<string | null>;

/** Shipment states in which something is (or may be) live at a warehouse. */
const INACTIVE_SHIPMENT: CrmOrderStatus[] = ["SUBMIT_FAILED", "CANCELLED"];

/** Statuses an order reaches only after a warehouse had it (cancel from here needs the extra guard). */
const AFTER_VENDOR: CrmOrderStatus[] = ["BLOCKED", "EXCEPTION", "UNKNOWN"];

/** Shopify test orders are held on import and must never reach a warehouse by accident. */
export const SHOPIFY_TEST_TAG = "shopify-test";

/** AiPolicy.decisionType whose L2 level allows the AI to approve orders (SPEC §7.4). */
export const AI_APPROVAL_DECISION = "order_approval";

/**
 * "Само поръчки с таг": an order of a store that requires a tag may be approved, queued, released or restarted only
 * with that tag (the backstop for every path — AI autopilot, bulk fulfil, a hold released, a crash mid re-sort).
 */
const storeTagGuard: Guard = async (tx, { order }) => {
  const o = await tx.order.findUnique({
    where: { id: order.id },
    select: { storeId: true, source: true, raw: true, tags: true },
  });
  if (!o?.storeId || o.source !== "SHOPIFY") return null;
  const gate = await tx.storeOrderTag.findFirst({
    where: { accountId: order.accountId, storeId: o.storeId },
    select: { tag: true },
  });
  return gate && !hasStoreTag(shopifyTagsOf(o.raw, o.tags), gate.tag) ? "store_tag_missing" : null;
};

const GUARDS: Partial<Record<TransitionCause, Guard[]>> = {
  approve: [
    // AI approval only when an enabled AiPolicy at L2 for order approval exists in this account — loaded
    // here, never taken from the caller.
    async (tx, { actor }) => {
      if (actor.kind !== "ai") return null;
      if (!actor.policyId) return "ai_policy_missing";
      const policy = await tx.aiPolicy.findFirst({
        where: { id: actor.policyId },
        select: { level: true, enabled: true, decisionType: true },
      });
      if (!policy || policy.decisionType !== AI_APPROVAL_DECISION) return "ai_policy_missing";
      if (!policy.enabled) return "ai_policy_disabled";
      return policy.level === "L2" ? null : "ai_policy_not_l2";
    },
    // Validate before sending: the stored pre-flight check (src/server/checks) must exist, have no hard
    // finding, have validated the order data as it is NOW (fingerprint) and — when the caller names the
    // warehouse it approves for — that warehouse.
    async (tx, { order, meta }) => {
      const check = await tx.orderCheck.findFirst({
        where: { orderId: order.id },
        select: { hardCount: true, normalised: true, connectionId: true },
      });
      if (!check) return "no_check";
      if (check.hardCount > 0) return "hard_findings";
      const stored = storedFingerprint(check.normalised);
      if (!stored || stored !== (await currentOrderFingerprint(tx, order.id))) return "check_stale";
      const connectionId = typeof meta?.connectionId === "string" ? meta.connectionId : null;
      if (connectionId && connectionId !== check.connectionId) return "check_connection_mismatch";
      return null;
    },
    storeTagGuard,
  ],
  // A check that ran while a shipment became active (should be impossible: the queue gate refuses CHECKING)
  // must not pull the order back to READY / NEEDS_REVIEW, where it would no longer follow its shipment.
  check_result: [
    async (tx, { order }) => {
      const active = await tx.fulfillment.count({
        where: { orderId: order.id, status: { notIn: INACTIVE_SHIPMENT } },
      });
      return active > 0 ? "active_shipment" : null;
    },
  ],
  cancel: [
    async (tx, { order }) => {
      const active = await tx.fulfillment.count({
        where: { orderId: order.id, status: { notIn: INACTIVE_SHIPMENT } },
      });
      return active > 0 ? "active_shipment" : null;
    },
    // After the warehouse blocked / cancelled it: a vendor write of this order that is still on its way or whose
    // outcome is unknown may yet leave something live there — resolve it first.
    async (tx, { order }) => {
      if (!(AFTER_VENDOR as readonly string[]).includes(order.status)) return null;
      const open = await tx.outboundRequest.count({
        where: {
          fulfillment: { orderId: order.id },
          status: { in: ["PENDING", "PAUSED", "AWAITING_CONFIRMATION", "HELD", "SENDING", "UNCERTAIN"] },
        },
      });
      return open > 0 ? "vendor_request_open" : null;
    },
  ],
  // P4-09: the old shipment must be cancelled (in the same transaction) before the order is approved again.
  reroute: [
    async (tx, { order }) => {
      const active = await tx.fulfillment.count({
        where: { orderId: order.id, status: { notIn: INACTIVE_SHIPMENT } },
      });
      return active > 0 ? "active_shipment" : null;
    },
  ],
  // Set aside for a missing store tag only while nothing is (or may be) live at a warehouse.
  tag_missing: [
    async (tx, { order }) => {
      const active = await tx.fulfillment.count({
        where: { orderId: order.id, status: { notIn: INACTIVE_SHIPMENT } },
      });
      return active > 0 ? "active_shipment" : null;
    },
    async (tx, { order }) => {
      const open = await tx.outboundRequest.count({
        where: {
          fulfillment: { orderId: order.id },
          status: { in: ["PENDING", "PAUSED", "AWAITING_CONFIRMATION", "HELD", "SENDING", "UNCERTAIN"] },
        },
      });
      return open > 0 ? "vendor_request_open" : null;
    },
  ],
  release: [
    async (_tx, { order }) => (order.tags.includes(SHOPIFY_TEST_TAG) ? "shopify_test_order" : null),
    storeTagGuard,
  ],
  restart: [storeTagGuard],
  queue: [storeTagGuard],
};

/**
 * Adds a guard for a cause (other modules register theirs at import time, e.g. the validator engine's
 * "no hard findings" guard for approve). Guards run in registration order; the first refusal wins.
 */
export function registerGuard(cause: TransitionCause, guard: Guard) {
  (GUARDS[cause] ??= []).push(guard);
}

const actorKind = (a: PipelineActor): ActorKind => a.kind;

const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

/** Applies one pipeline move inside the caller's account transaction. See the module comment. */
export async function transition(tx: Tx, input: TransitionInput): Promise<TransitionResult> {
  const mode = input.mode ?? (input.actor.kind === "system" ? "follow" : "strict");
  const refuse = (reason: RefusalReason, from: CrmOrderStatus | null, guard?: string): TransitionResult => {
    if (mode === "strict") throw new TransitionError(reason, from, input.to, guard);
    return { changed: false, from, to: input.to, reason, ...(guard ? { guard } : {}) };
  };

  // A concurrent writer may change the status between our read and the compare-and-set: re-evaluate.
  for (let attempt = 0; attempt < 3; attempt++) {
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      select: { id: true, accountId: true, status: true, tags: true },
    });
    if (!order) return refuse("not_found", null);
    const from = order.status;
    if (from === input.to) return { changed: false, from, to: input.to, reason: "same" };
    if (
      !isAllowed(input.cause, from, input.to, actorKind(input.actor)) ||
      (input.onlyFrom && !input.onlyFrom.includes(from))
    )
      return refuse("not_allowed", from);
    for (const guard of GUARDS[input.cause] ?? []) {
      const code = await guard(tx, { order, to: input.to, actor: input.actor, meta: input.meta });
      if (code) return refuse("guard", from, code);
    }
    const moved = await tx.order.updateMany({
      where: { id: order.id, status: from },
      data: { status: input.to },
    });
    if (moved.count !== 1) continue;

    const userId = input.actor.kind === "user" ? input.actor.userId : null;
    const event = await tx.orderEvent.create({
      data: {
        accountId: order.accountId,
        orderId: order.id,
        fromStatus: from,
        toStatus: input.to,
        cause: input.cause,
        actorType: input.actor.kind,
        userId,
        source: input.source ?? null,
        reason: input.reason?.slice(0, 1000) ?? null,
        meta:
          input.meta || input.actor.kind === "ai"
            ? json({ ...input.meta, ...aiMeta(input.actor) })
            : undefined,
      },
      select: { id: true },
    });
    if (userId) {
      await tx.auditLog.create({
        data: {
          accountId: order.accountId,
          userId,
          action: "order.status",
          entityType: "Order",
          entityId: order.id,
          before: { status: from },
          after: json({ status: input.to, cause: input.cause, reason: input.reason ?? null }),
        },
      });
    }
    return { changed: true, from, to: input.to, eventId: event.id };
  }
  return refuse("race", null);
}

const aiMeta = (a: PipelineActor) =>
  a.kind === "ai" ? { aiLevel: a.level, aiPolicyId: a.policyId ?? null } : {};

/**
 * transition() in its own account transaction, with the Order row locked first: cancel / hold / approve
 * serialise with a concurrent submit (which locks the same row) so a guard never reads a state the other
 * writer is about to change.
 */
export function transitionOrder(accountId: string, input: TransitionInput) {
  return withAccountTransaction(accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("Order", input.orderId);
    return transition(tx, input);
  });
}

/**
 * The first timeline entry: the status an order was created with (no transition happened). Call it in the
 * same transaction as the order's create.
 */
export async function recordInitialStatus(
  tx: Tx,
  input: {
    accountId: string;
    orderId: string;
    status: CrmOrderStatus;
    actor: PipelineActor;
    source?: string;
  },
) {
  await tx.orderEvent.create({
    data: {
      accountId: input.accountId,
      orderId: input.orderId,
      fromStatus: null,
      toStatus: input.status,
      cause: "created",
      actorType: input.actor.kind,
      userId: input.actor.kind === "user" ? input.actor.userId : null,
      source: input.source ?? null,
    },
  });
}

/**
 * The order follows one of its shipments (vendor status maps, COD payouts). Forward only, never touches
 * operator states; returns true when the order moved.
 */
export async function followShipment(
  tx: Tx,
  orderId: string,
  to: CrmOrderStatus,
  source: string,
  opts: {
    onlyFrom?: readonly CrmOrderStatus[];
    meta?: Record<string, unknown>;
    /** The shipment the vendor status is about: a shipment replaced by a reroute is never followed (P4-09). */
    fulfillmentId?: string;
  } = {},
) {
  const { fulfillmentId, ...rest } = opts;
  if (fulfillmentId && (await isRerouteOwnedShipment(tx, fulfillmentId))) return false;
  const r = await transition(tx, {
    orderId,
    to,
    cause: "vendor",
    actor: { kind: "system" },
    source,
    mode: "follow",
    ...rest,
  });
  return r.changed;
}

/**
 * A shipment that a confirmed reroute replaced (P4-09): the old warehouse confirmed its cancellation and the order
 * moved on to another warehouse. Late vendor statuses of it are recorded on the shipment's timeline only — they
 * never reactivate it and never move the order (which now follows its new shipment).
 */
export async function isSupersededShipment(tx: Tx, fulfillmentId: string) {
  const r = await tx.orderReroute.findFirst({
    where: { fromFulfillmentId: fulfillmentId, status: "DONE" },
    select: { id: true },
  });
  return !!r;
}

/**
 * A shipment whose order status belongs to the reroute flow (P4-09): replaced by a confirmed reroute, OR with an
 * open one (CANCEL_QUEUED). While the cancel is on its way the vendor may already report the shipment
 * deleted/cancelled (euShipments "Deleted" → CANCELLED); following that would strand the order in CANCELLED, which
 * the reroute can no longer move to APPROVED. The shipment row still records the vendor status; only the order
 * waits for the reroute's outcome (DONE → APPROVED; REFUSED → it catches up with the shipment's status).
 */
export async function isRerouteOwnedShipment(tx: Tx, fulfillmentId: string) {
  const r = await tx.orderReroute.findFirst({
    where: { fromFulfillmentId: fulfillmentId, status: { in: ["CANCEL_QUEUED", "DONE"] } },
    select: { id: true },
  });
  return !!r;
}

/** Timeline of one order, oldest first (P4-04 order detail). */
export function orderEvents(tx: Tx, orderId: string) {
  return tx.orderEvent.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
}

/**
 * The submit gate (FHB submit, euShipments queue): call it inside the submit transaction, with the Order row
 * locked (`lockForUpdate("Order", orderId)`), BEFORE any Fulfillment or outbox row is written. Moves the
 * order APPROVED / SUBMIT_FAILED → QUEUED in strict mode, so a cancelled, held, unchecked or unapproved order
 * (or one being checked right now) throws TransitionError and the whole submit rolls back.
 *
 * An order that is already QUEUED passes only when the caller re-arms that very shipment (`rearmQueued`:
 * the same connection's QUEUED Fulfillment whose request never left — dry run, mode gate); a second
 * shipment for a queued order is refused.
 */
export async function queueGate(
  tx: Tx,
  input: {
    orderId: string;
    userId: string;
    source: string;
    connectionId: string;
    rearmQueued: boolean;
  },
): Promise<TransitionResult> {
  const r = await transition(tx, {
    orderId: input.orderId,
    to: "QUEUED",
    cause: "queue",
    actor: { kind: "user", userId: input.userId },
    source: input.source,
    mode: "strict",
    onlyFrom: ["APPROVED", "SUBMIT_FAILED"],
    meta: { connectionId: input.connectionId },
  });
  if (!r.changed && !input.rearmQueued) throw new TransitionError("not_allowed", r.from, "QUEUED");
  return r;
}
