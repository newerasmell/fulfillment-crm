/**
 * Order pipeline (P4-03, SPEC §6.1). Public interface for the review queue, Fulfill and AI layers:
 *
 *   transition(tx, input) / transitionOrder(accountId, input) — the only way to change Order.status
 *   recordInitialStatus(tx, ...)                               — first timeline entry of a new order
 *   followShipment(tx, orderId, status, source)                — vendor-driven, forward-only moves
 *   registerGuard(cause, guard)                                — extra preconditions for a cause
 *   RULES / isAllowed / allowedTransitions / nextSteps         — the rule table (pure)
 */
export * from "./rules";
export * from "./transition";
