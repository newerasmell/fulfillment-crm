/** Pure: payment facts of a stored Shopify order payload (no imports, safe for every pre-flight). */

/** Gateways and the amount still owed, from the stored Shopify order payload. */
export function shopifyPaymentOf(raw: unknown): { gateways: string[]; outstanding: number | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as {
    paymentGatewayNames?: unknown;
    totalOutstandingSet?: { shopMoney?: { amount?: unknown } } | null;
  };
  const gateways = Array.isArray(r.paymentGatewayNames)
    ? r.paymentGatewayNames.filter((g): g is string => typeof g === "string")
    : [];
  const amount = Number(r.totalOutstandingSet?.shopMoney?.amount);
  return { gateways, outstanding: Number.isFinite(amount) ? amount : null };
}
