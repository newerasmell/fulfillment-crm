/**
 * Validator engine (P4-01). Public interface:
 *   validateOrder(accountId, orderId, { connectionId?, persist? }) → findings + routing, stored as OrderCheck
 *   checkOrder(accountId, orderId, { actor })   → the same inside the pipeline (CHECKING → READY / NEEDS_REVIEW)
 *   checkOrderAs(actor, orderId)                → for people (orders.review, company scope)
 *   latestOrderCheck(accountId, orderId)        → the stored result
 *   enqueueOrderCheck(boss, { accountId, orderId }) → background check (worker)
 *   Finding / fromFhb / fromEu / orderLevelFindings → shapes and the pure order-level rules
 */
export * from "./findings";
export * from "./order-checks";
export * from "./validate";
export * from "./jobs";
