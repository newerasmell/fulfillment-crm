/**
 * The order's page in the store's Shopify admin (owner request 2026-11-11: open the order there in a new tab).
 * `https://{shop}.myshopify.com/admin/orders/{id}` — Shopify redirects it to admin.shopify.com. Null when the order
 * did not come from Shopify.
 */
export function shopifyAdminOrderUrl(domain: string | null | undefined, orderGid: string | null | undefined) {
  const id = /^gid:\/\/shopify\/Order\/(\d+)$/.exec(orderGid ?? "")?.[1];
  if (!id || !domain || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(domain)) return null;
  return `https://${domain.toLowerCase()}/admin/orders/${id}`;
}
