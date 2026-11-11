import { normalizeTag } from "@/integrations/shopify/order-tags";

/**
 * The store's required tag matches one of the order's Shopify tags — the same comparison everywhere (normalizeTag):
 * case, spaces, underscores and hyphens do not matter ("confirmed" = "Confirmed", "Ready to ship" = "ready_to_ship").
 */
export function hasStoreTag(tags: readonly string[] | null | undefined, required: string) {
  const want = normalizeTag(required);
  return !!want && (tags ?? []).some((t) => normalizeTag(t) === want);
}

/** Shopify's tags of an order from its stored payload (falls back to the order's own tags). */
export function shopifyTagsOf(raw: unknown, fallback: readonly string[]): string[] {
  const t = (raw as { tags?: unknown } | null)?.tags;
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [...fallback];
}
