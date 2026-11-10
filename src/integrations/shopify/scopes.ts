/**
 * Access scopes the CRM needs from every store's Shopify app (Dev Dashboard → Create version → API access → Scopes).
 * The store page shows this exact comma-separated list to copy, and the connection test compares it with what the
 * app was really granted (currentAppInstallation.accessScopes).
 */
export const REQUIRED_SCOPES = [
  "read_orders",
  // Order tags (out_of_stock → waiting_for_stock → Confirmed, "Липсващи артикули"); write_ includes read_.
  "write_orders",
  "read_customers",
  "read_products",
  "write_products",
  "read_inventory",
  "write_inventory",
  "read_locations",
  "read_merchant_managed_fulfillment_orders",
  "write_merchant_managed_fulfillment_orders",
  "read_fulfillments",
  "write_fulfillments",
] as const;

export const REQUIRED_SCOPES_TEXT = REQUIRED_SCOPES.join(",");

/** Required scopes the app does not hold. A write_X grant includes read_X (Shopify access scopes). */
export function missingScopes(granted: string[]): string[] {
  const have = new Set(granted.map((s) => s.trim().toLowerCase()));
  return REQUIRED_SCOPES.filter(
    (s) => !have.has(s) && !(s.startsWith("read_") && have.has(`write_${s.slice(5)}`)),
  );
}
