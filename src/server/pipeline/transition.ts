import type { AiLevel, CrmOrderStatus, Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { withAccountTransaction } from "@/server/db/client";
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
  /** An AI decision; `level` is the AiPolicy level that allowed it (approval needs L2). */
  | { kind: "ai"; level: AiLevel; policyId?: string | null };

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

/** Shopify test orders are held on import and must never reach a warehouse by accident. */
export const SHOPIFY_TEST_TAG = "shopify-test";

const GUARDS: Partial<Record<TransitionCause, Guard[]>> = {
  approve: [
    async (_tx, { actor }) => (actor.kind === "ai" && actor.level !== "L2" ? "ai_policy_not_l2" : null),
  ],
  cancel: [
    async (tx, { order }) => {
      const active = await tx.fulfillment.count({
        where: { orderId: order.id, status: { notIn: INACTIVE_SHIPMENT } },
      });
      return active > 0 ? "active_shipment" : null;
    },
  ],
  release: [async (_tx, { order }) => (order.tags.includes(SHOPIFY_TEST_TAG) ? "shopify_test_order" : null)],
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

/** transition() in its own account transaction. */
export function transitionOrder(accountId: string, input: TransitionInput) {
  return withAccountTransaction(accountId, (tx) => transition(tx, input));
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
  opts: { onlyFrom?: readonly CrmOrderStatus[]; meta?: Record<string, unknown> } = {},
) {
  const r = await transition(tx, {
    orderId,
    to,
    cause: "vendor",
    actor: { kind: "system" },
    source,
    mode: "follow",
    ...opts,
  });
  return r.changed;
}

/** Timeline of one order, oldest first (P4-04 order detail). */
export function orderEvents(tx: Tx, orderId: string) {
  return tx.orderEvent.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
}
