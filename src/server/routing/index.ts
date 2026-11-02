/**
 * Routing (P4-02). Public interface:
 *   routeOrder(accountId, orderId)                → RoutingDecision (connection, rule, carrier, stock, explanation)
 *   loadRoutingContext + routeWithContext         → the same for many orders with one rules/connections read
 *   evaluateRouting / checkStock / describeMatch  → the pure engine
 *   list/create/update/delete/moveRoutingRule     → admin (routing.manage, audited)
 */
export * from "./engine";
export * from "./route";
export * from "./rules";
