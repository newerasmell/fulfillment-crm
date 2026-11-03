import type { CrmOrderStatus } from "@/generated/prisma/client";

/**
 * The CRM order pipeline (SPEC §6.1) as data. Pure: no database. `transition()` (./transition.ts) is the only
 * code that changes Order.status, and it accepts a move only when a rule below allows it for that cause and
 * actor, then runs the cause's guard (./transition.ts GUARDS).
 *
 *   IMPORTED → CHECKING → NEEDS_REVIEW | READY → APPROVED → QUEUED → SUBMITTING → ACCEPTED → PROCESSING
 *   → SHIPPED → DELIVERED → COD_PAID, with RETURNING → RETURN_RECEIVED, EXCEPTION, SUBMIT_FAILED and the side
 *   states ON_HOLD, BLOCKED, CANCELLED, UNKNOWN, FULFILLED_EXTERNALLY.
 *
 * Vendor-driven moves are forward only (a late or repeated vendor status never moves an order back) and never
 * touch operator states (ON_HOLD, a CRM CANCELLED) — the same table the euShipments status code used before.
 */

export type ActorKind = "user" | "system" | "ai";

export type TransitionCause =
  /**
   * Pre-flight checks start (validator engine). Also a re-check after an edit or a failed submit. Not from
   * APPROVED: re-checking an approved order is reopen (→ NEEDS_REVIEW) first, so a check can never run while
   * the order may be submitted.
   */
  | "check_start"
  /** Pre-flight checks finished: hard findings → NEEDS_REVIEW, otherwise READY. */
  | "check_result"
  /** Operator (or an AI policy at L2) approves the order for fulfilment. */
  | "approve"
  /** Back to review (e.g. the operator wants to change something after approving). */
  | "reopen"
  /** Operator hold before anything was queued. */
  | "hold"
  /** Operator releases a hold: the order starts over at IMPORTED and is checked again. */
  | "release"
  /**
   * Operator restarts an order the warehouse blocked or cancelled (e.g. cancelled by hand in ZOE): back to IMPORTED
   * and checked again, only while no shipment of it is active anywhere (guarded in review/service.ts).
   */
  | "restart"
  /**
   * Operator cancels in the CRM (never AI, never once a shipment is active at a warehouse). From BLOCKED / EXCEPTION /
   * UNKNOWN only when no shipment is active and no vendor write of the order is pending or uncertain.
   */
  | "cancel"
  /** Shopify import: cancelled in Shopify before approval. */
  | "shopify_cancelled"
  /** Shopify import: fulfilled in Shopify before approval (shipped outside the CRM). */
  | "shopify_fulfilled"
  /** A vendor order was queued in the outbox (FHB submit / euShipments queue). */
  | "queue"
  /** The outbox sender started the vendor call. */
  | "submitting"
  /** The vendor definitely refused the create. */
  | "submit_failed"
  /** The order follows its shipment's vendor status (FHB status map, euShipments history/COD). */
  | "vendor"
  /**
   * Shopify import changed the order's data (address, phone, COD, lines…) while it was being checked or
   * waiting for review: it starts over at IMPORTED and the check sweep validates it again.
   */
  | "data_changed"
  /**
   * Reroute after sending (P4-09): the old warehouse CONFIRMED (read-back) that it cancelled the shipment, so the
   * order returns to APPROVED bound to the new warehouse (src/server/override/reroute.ts). Guarded: no active
   * shipment may be left.
   */
  | "reroute";

/** Every cause, for exhaustive tests and docs. */
export const CAUSES: readonly TransitionCause[] = [
  "check_start",
  "check_result",
  "approve",
  "reopen",
  "hold",
  "release",
  "restart",
  "cancel",
  "shopify_cancelled",
  "shopify_fulfilled",
  "queue",
  "submitting",
  "submit_failed",
  "vendor",
  "data_changed",
  "reroute",
];

export interface TransitionRule {
  cause: TransitionCause;
  from: readonly CrmOrderStatus[];
  to: readonly CrmOrderStatus[];
  actors: readonly ActorKind[];
}

/** CRM-side states before approval; Shopify changes still apply directly (see shopify/statuses.ts). */
const PRE_APPROVAL: CrmOrderStatus[] = ["IMPORTED", "CHECKING", "NEEDS_REVIEW", "READY", "ON_HOLD"];

/** Our side has not handed anything to a vendor that is (or may be) live there. */
const PRE_VENDOR: CrmOrderStatus[] = ["APPROVED", "QUEUED", "SUBMITTING", "SUBMIT_FAILED", "UNKNOWN"];

/**
 * Vendor-driven targets and the Order statuses they may come from (forward only). Unchanged from the
 * euShipments status code (wave 1), which now goes through transition().
 */
export const VENDOR_FROM: Partial<Record<CrmOrderStatus, readonly CrmOrderStatus[]>> = {
  ACCEPTED: PRE_VENDOR,
  PROCESSING: [...PRE_VENDOR, "ACCEPTED", "BLOCKED", "EXCEPTION"],
  SHIPPED: [...PRE_VENDOR, "ACCEPTED", "PROCESSING", "BLOCKED", "EXCEPTION"],
  DELIVERED: [...PRE_VENDOR, "ACCEPTED", "PROCESSING", "SHIPPED", "BLOCKED", "EXCEPTION"],
  RETURNING: [...PRE_VENDOR, "ACCEPTED", "PROCESSING", "SHIPPED", "DELIVERED", "BLOCKED", "EXCEPTION"],
  RETURN_RECEIVED: [
    ...PRE_VENDOR,
    "ACCEPTED",
    "PROCESSING",
    "SHIPPED",
    "DELIVERED",
    "RETURNING",
    "BLOCKED",
    "EXCEPTION",
  ],
  BLOCKED: [...PRE_VENDOR, "ACCEPTED", "PROCESSING", "EXCEPTION"],
  EXCEPTION: [...PRE_VENDOR, "ACCEPTED", "PROCESSING", "SHIPPED", "BLOCKED"],
  CANCELLED: [...PRE_VENDOR, "ACCEPTED", "PROCESSING", "BLOCKED", "EXCEPTION"],
  COD_PAID: ["DELIVERED"],
};

const ALL: ActorKind[] = ["user", "system", "ai"];

export const RULES: readonly TransitionRule[] = [
  {
    cause: "check_start",
    from: ["IMPORTED", "NEEDS_REVIEW", "READY", "SUBMIT_FAILED"],
    to: ["CHECKING"],
    actors: ALL,
  },
  { cause: "check_result", from: ["CHECKING"], to: ["NEEDS_REVIEW", "READY"], actors: ALL },
  // AI approval additionally needs an L2 policy (guard in transition.ts).
  { cause: "approve", from: ["NEEDS_REVIEW", "READY"], to: ["APPROVED"], actors: ["user", "ai"] },
  { cause: "reopen", from: ["APPROVED"], to: ["NEEDS_REVIEW"], actors: ["user"] },
  {
    cause: "hold",
    from: ["IMPORTED", "CHECKING", "NEEDS_REVIEW", "READY", "APPROVED", "SUBMIT_FAILED"],
    to: ["ON_HOLD"],
    actors: ["user"],
  },
  { cause: "release", from: ["ON_HOLD"], to: ["IMPORTED"], actors: ["user"] },
  { cause: "restart", from: ["BLOCKED", "EXCEPTION", "UNKNOWN"], to: ["IMPORTED"], actors: ["user"] },
  // Also "Откажи поръчката" for an order the warehouse blocked / cancelled (BLOCKED, EXCEPTION, UNKNOWN): guarded in
  // transition.ts — no active shipment and no vendor write of the order still on its way or uncertain.
  {
    cause: "cancel",
    from: [
      "IMPORTED",
      "CHECKING",
      "NEEDS_REVIEW",
      "READY",
      "APPROVED",
      "SUBMIT_FAILED",
      "ON_HOLD",
      "BLOCKED",
      "EXCEPTION",
      "UNKNOWN",
    ],
    to: ["CANCELLED"],
    actors: ["user"],
  },
  { cause: "shopify_cancelled", from: PRE_APPROVAL, to: ["CANCELLED"], actors: ["system"] },
  { cause: "shopify_fulfilled", from: PRE_APPROVAL, to: ["FULFILLED_EXTERNALLY"], actors: ["system"] },
  // Only an approved order (or one whose submit was refused) is queued: the submit paths use this rule as
  // their gate, in strict mode and before any Fulfillment / outbox row exists.
  {
    cause: "queue",
    from: ["APPROVED", "SUBMIT_FAILED"],
    to: ["QUEUED"],
    actors: ["user", "system"],
  },
  { cause: "submitting", from: ["QUEUED"], to: ["SUBMITTING"], actors: ["system"] },
  { cause: "submit_failed", from: ["QUEUED", "SUBMITTING"], to: ["SUBMIT_FAILED"], actors: ["system"] },
  {
    cause: "data_changed",
    from: ["CHECKING", "NEEDS_REVIEW", "READY"],
    to: ["IMPORTED"],
    actors: ["system"],
  },
  // Only after the old warehouse confirmed the cancellation (P4-09); the order is still "at" the old warehouse.
  {
    cause: "reroute",
    from: ["ACCEPTED", "BLOCKED", "EXCEPTION", "UNKNOWN"],
    to: ["APPROVED"],
    actors: ["system"],
  },
  ...Object.entries(VENDOR_FROM).map(([to, from]): TransitionRule => ({
    cause: "vendor",
    from: from!,
    to: [to as CrmOrderStatus],
    actors: ["system"],
  })),
];

/** Is `from → to` allowed for this cause and actor kind (before guards)? */
export function isAllowed(
  cause: TransitionCause,
  from: CrmOrderStatus,
  to: CrmOrderStatus,
  actor: ActorKind,
) {
  return RULES.some(
    (r) => r.cause === cause && r.actors.includes(actor) && r.from.includes(from) && r.to.includes(to),
  );
}

/** Every (cause, from, to) the pipeline allows — for tests, docs and UIs that offer the next steps. */
export function allowedTransitions() {
  const out: {
    cause: TransitionCause;
    from: CrmOrderStatus;
    to: CrmOrderStatus;
    actors: readonly ActorKind[];
  }[] = [];
  for (const r of RULES)
    for (const from of r.from)
      for (const to of r.to) out.push({ cause: r.cause, from, to, actors: r.actors });
  return out;
}

/** What an actor may do next from a status (the decision bar shows these). */
export function nextSteps(from: CrmOrderStatus, actor: ActorKind) {
  return allowedTransitions().filter((t) => t.from === from && t.actors.includes(actor));
}

/** Terminal for the CRM: nothing moves these any more (a reship is a new Fulfillment, not a new status). */
export const TERMINAL: ReadonlySet<CrmOrderStatus> = new Set([
  "CANCELLED",
  "FULFILLED_EXTERNALLY",
  "COD_PAID",
]);
