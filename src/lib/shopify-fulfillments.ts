/**
 * Which of an order's live Shopify fulfillments the CRM did NOT write (owner report 2026-11-18): only those
 * mean "shipped outside the CRM". Pure: `raw` is the stored Shopify order, `ours` the gids of the order's SENT FULFIL
 * write-backs. Null when the stored order predates the fulfillments field (unknown — callers stay on the safe side).
 */
export function foreignShopifyFulfillments(raw: unknown, ours: ReadonlySet<string>): string[] | null {
  const list = (raw as { fulfillments?: { id?: unknown; status?: unknown }[] | null } | null)?.fulfillments;
  // A full page may hide more (src/integrations/shopify/orders.ts ORDER_FULFILLMENTS_FIRST = 10): unknown.
  if (!Array.isArray(list) || list.length >= 10) return null;
  return list
    .filter((f) => typeof f.id === "string" && f.status !== "CANCELLED")
    .map((f) => f.id as string)
    .filter((id) => !ours.has(id));
}
