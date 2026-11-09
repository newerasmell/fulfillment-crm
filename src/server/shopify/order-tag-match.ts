/** The store's required tag matches one of the order's Shopify tags: trimmed, case-insensitive ("confirmed" = "Confirmed"). */
export function hasStoreTag(tags: readonly string[] | null | undefined, required: string) {
  const want = required.trim().toLowerCase();
  return !!want && (tags ?? []).some((t) => t.trim().toLowerCase() === want);
}

/** Shopify's tags of an order from its stored payload (falls back to the order's own tags). */
export function shopifyTagsOf(raw: unknown, fallback: readonly string[]): string[] {
  const t = (raw as { tags?: unknown } | null)?.tags;
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [...fallback];
}
