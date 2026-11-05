import type { CrmOrderStatus } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { checkOrder } from "@/server/checks";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";
import { isCod } from "./orders";
import { shopifyPaymentOf } from "./payment-facts";

export { shopifyPaymentOf };

/**
 * Payment method of Shopify orders (owner report 2026-11-05: every store has its own custom payment methods in the
 * local language, e.g. a Greek "cash on delivery" name the CRM did not know, so a COD order was recorded PREPAID and
 * would have shipped with no cash to collect). Rules:
 *  - COD = a gateway the store lists as COD (Store.codGateways, matched case-insensitively) AND money still owed;
 *  - a PREPAID order with money still owed is a HARD finding (order.payment_unclear) — never shipped as prepaid;
 *  - when a store's COD list changes (settings, or "this method is cash on delivery" on an order), its Shopify orders
 *    that have not left for a warehouse are re-classified from the stored Shopify payload and checked again
 *    (the approval fingerprint covers payment, so an earlier approval no longer applies).
 */

/** Statuses whose payment may still be re-classified: nothing was handed to a warehouse yet. */
export const RECLASSIFIABLE: CrmOrderStatus[] = [
  "IMPORTED",
  "CHECKING",
  "NEEDS_REVIEW",
  "READY",
  "ON_HOLD",
  "APPROVED",
  "SUBMIT_FAILED",
];

/** COD or PREPAID for a stored Shopify payload under the store's COD list (same rule as the import). */
export function classifyPayment(raw: unknown, codGateways: string[]) {
  const p = shopifyPaymentOf(raw);
  const owed = p?.outstanding ?? 0;
  const cod = !!p && isCod(p.gateways, codGateways) && owed > 0;
  return { cod, codAmount: cod ? owed.toFixed(2) : null };
}

/**
 * Re-classifies the store's Shopify orders that have not left for a warehouse, after its COD list changed. Returns
 * the ids that changed (each audited and checked again).
 */
export async function reclassifyStorePayments(accountId: string, storeId: string, userId: string | null) {
  const db = accountDb(accountId);
  const store = await db.store.findUnique({ where: { id: storeId }, select: { codGateways: true } });
  if (!store) return [];
  const orders = await db.order.findMany({
    where: { storeId, source: "SHOPIFY", status: { in: RECLASSIFIABLE } },
    select: { id: true, raw: true, paymentMethod: true, codAmount: true },
  });
  const changed: string[] = [];
  for (const o of orders) {
    const next = classifyPayment(o.raw, store.codGateways);
    const method = next.cod ? "COD" : "PREPAID";
    if (method === o.paymentMethod) continue;
    const moved = await withAccountTransaction(accountId, async (tx, { lockForUpdate }) => {
      await lockForUpdate("Order", o.id);
      const fresh = await tx.order.findUnique({
        where: { id: o.id },
        select: { status: true, paymentMethod: true },
      });
      if (!fresh || !RECLASSIFIABLE.includes(fresh.status) || fresh.paymentMethod === method) return false;
      await tx.order.update({
        where: { id: o.id },
        data: {
          paymentMethod: method,
          codAmount: next.codAmount,
          // A local-currency amount belonged to the old classification; the COD checks ask for it again.
          codLocalAmount: null,
          codLocalCurrency: null,
          codRate: null,
        },
      });
      await tx.auditLog.create({
        data: {
          accountId,
          userId,
          action: "order.payment_reclassified",
          entityType: "Order",
          entityId: o.id,
          before: { paymentMethod: o.paymentMethod, codAmount: o.codAmount?.toString() ?? null },
          after: { paymentMethod: method, codAmount: next.codAmount },
        },
      });
      return true;
    });
    if (!moved) continue;
    changed.push(o.id);
    try {
      await checkOrder(accountId, o.id, {
        actor: userId ? { kind: "user", userId } : { kind: "system" },
      });
    } catch (err) {
      logger.warn({ orderId: o.id, err: String(err) }, "re-check after payment re-classification failed");
    }
  }
  return changed;
}

/**
 * "Този метод е наложен платеж" on an order with order.payment_unclear: adds the order's gateways to its store's
 * COD list and re-classifies the store's open orders (this one included).
 */
export async function markOrderGatewaysCod(actor: ScopedActor, orderId: string) {
  assertCan(actor.role, "stores.manage");
  const db = accountDb(actor.accountId);
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { id: true, companyId: true, storeId: true, raw: true, source: true },
  });
  if (!order || !order.storeId || (actor.companyScope && !actor.companyScope.includes(order.companyId ?? "")))
    throw new DomainError("not_found");
  const gateways =
    shopifyPaymentOf(order.raw)
      ?.gateways.map((g) => g.trim())
      .filter(Boolean) ?? [];
  if (order.source !== "SHOPIFY" || !gateways.length) throw new DomainError("no_gateway");
  const store = await db.store.findUniqueOrThrow({
    where: { id: order.storeId },
    select: { id: true, codGateways: true },
  });
  const known = new Set(store.codGateways.map((g) => g.trim().toLowerCase()));
  const added = gateways.filter((g) => !known.has(g.toLowerCase()));
  if (added.length) {
    const next = [...store.codGateways, ...added].slice(0, 20);
    await db.store.update({ where: { id: store.id }, data: { codGateways: next } });
    await recordAudit({
      accountId: actor.accountId,
      userId: actor.userId,
      action: "store.cod_gateways_added",
      entityType: "Store",
      entityId: store.id,
      before: { codGateways: store.codGateways },
      after: { codGateways: next, fromOrder: order.id },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  }
  const changed = await reclassifyStorePayments(actor.accountId, store.id, actor.userId);
  return { added, changed: changed.length };
}
