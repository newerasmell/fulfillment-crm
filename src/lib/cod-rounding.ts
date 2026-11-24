/**
 * Cash on delivery is collected in whole units in some currencies (owner decision 2026-11-11: HUF to the whole
 * forint, normal rounding — 32 825,10 → 32 825, 32 825,60 → 32 826). Shopify computes such amounts with decimals;
 * what goes to the warehouse (and what the CRM expects back) is the collectable amount. Pure.
 * CZK too (2026-11-24): FHB refused a Czech order with COD 2185,10 CZK (`INVALID_COD_VALUE_ERROR`); Czech crowns
 * have no smaller coin and carriers collect whole crowns.
 */
export const WHOLE_UNIT_COD_CURRENCIES: ReadonlySet<string> = new Set(["HUF", "CZK"]);

export function collectableCod(amount: number, currency: string | null | undefined): number {
  if (!currency || !WHOLE_UNIT_COD_CURRENCIES.has(currency.toUpperCase())) return amount;
  // Half up, also for x.5 that binary floats store as x.4999…
  return Math.floor(amount + 0.5 + 1e-9);
}
