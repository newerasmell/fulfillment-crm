/**
 * Противосаботаж (owner request 2026-11-10): an order with more units of one product, or more units in total, than
 * its product line allows is held (QTY_HOLD) and reserves no stock until a person decides. Pure.
 */
export interface StockGuardRule {
  enabled: boolean;
  maxPerProduct: number | null;
  maxPerOrder: number | null;
}

export interface GuardVerdict {
  hold: boolean;
  /** The largest quantity of one product (variant) and the order total, for the person deciding. */
  maxProductQty: number;
  totalQty: number;
  reasons: ("per_product" | "per_order")[];
}

/** Lines as (variant or product key, quantity); the same key on several lines counts together. */
export function checkStockGuard(
  rule: StockGuardRule | null | undefined,
  lines: { key: string; quantity: number }[],
): GuardVerdict {
  const byKey = new Map<string, number>();
  let totalQty = 0;
  for (const l of lines) {
    const q = Math.max(0, Math.trunc(l.quantity));
    if (!q) continue;
    totalQty += q;
    byKey.set(l.key, (byKey.get(l.key) ?? 0) + q);
  }
  const maxProductQty = Math.max(0, ...byKey.values());
  const reasons: GuardVerdict["reasons"] = [];
  if (rule?.enabled) {
    if (rule.maxPerProduct != null && maxProductQty > rule.maxPerProduct) reasons.push("per_product");
    if (rule.maxPerOrder != null && totalQty > rule.maxPerOrder) reasons.push("per_order");
  }
  return { hold: reasons.length > 0, maxProductQty, totalQty, reasons };
}
