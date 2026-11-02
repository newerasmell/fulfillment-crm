/**
 * Order pipeline (P4-03, SPEC §6.1). Public interface for the review queue, Fulfill and AI layers:
 *
 *   transition(tx, input) / transitionOrder(accountId, input) — the only way to change Order.status
 *   queueGate(tx, input)                                       — the submit gate (APPROVED/SUBMIT_FAILED → QUEUED)
 *   recordInitialStatus(tx, ...)                               — first timeline entry of a new order
 *   followShipment(tx, orderId, status, source)                — vendor-driven, forward-only moves
 *   registerGuard(cause, guard)                                — extra preconditions for a cause
 *   RULES / CAUSES / isAllowed / allowedTransitions / nextSteps — the rule table (pure)
 *   orderFingerprint / currentOrderFingerprint                 — the order data a check validated
 */
export * from "./rules";
export * from "./transition";
export * from "./fingerprint";
