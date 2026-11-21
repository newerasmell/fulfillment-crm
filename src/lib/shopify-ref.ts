/**
 * The Shopify order number typed on a manual order (owner request 2026-11-21), kept as the tag `shopify:<NUMBER>` so
 * the order list and the global search find the manual order by it. "#" dropped, upper case.
 */
export const SHOPIFY_REF_PREFIX = "shopify:";
export const normaliseShopifyRef = (n: string) => n.trim().replace(/^#+/, "").trim().toUpperCase();
export const shopifyRefTag = (n: string) => `${SHOPIFY_REF_PREFIX}${normaliseShopifyRef(n)}`;
export const shopifyRefOf = (tags: readonly string[]) =>
  tags.find((t) => t.startsWith(SHOPIFY_REF_PREFIX))?.slice(SHOPIFY_REF_PREFIX.length) ?? null;
