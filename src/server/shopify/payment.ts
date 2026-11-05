import type { CrmOrderStatus } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { DomainError } from "@/server/accounts";
import { assertCan } from "@/server/auth/rbac";
import { checkOrder } from "@/server/checks";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { transition } from "@/server/pipeline";
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
    // A person's manual COD (OrderCodOverride) is never re-classified.
    where: { storeId, source: "SHOPIFY", status: { in: RECLASSIFIABLE }, codOverride: { is: null } },
    select: { id: true, raw: true, paymentMethod: true, codAmount: true },
  });
  const changed: string[] = [];
  for (const o of orders) {
    const next = classifyPayment(o.raw, store.codGateways);
    const method = next.cod ? "COD" : "PREPAID";
    if (method === o.paymentMethod) continue;
    let moved = false;
    try {
      moved = await withAccountTransaction(accountId, async (tx, { lockForUpdate }) => {
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
        // An approval covered the old payment: the order goes back to review (approved again by a person).
        if (fresh.status === "APPROVED") {
          if (!userId) throw new DomainError("approved_needs_person");
          await transition(tx, {
            orderId: o.id,
            to: "NEEDS_REVIEW",
            cause: "reopen",
            actor: { kind: "user", userId },
            source: "payment.reclassify",
            reason: "payment_reclassified",
          });
        }
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
    } catch (err) {
      // One order that cannot move (e.g. an approval without a person) never stops the others.
      logger.warn({ orderId: o.id, err: String(err) }, "payment re-classification skipped");
      continue;
    }
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

/** Gateways that are never cash on delivery (Shopify's own handles): refused as a COD method. */
const NEVER_COD = new Set(["shopify_payments", "gift_card", "paypal", "manual", "shop_pay", "bogus"]);
export const MAX_COD_GATEWAYS = 20;

/**
 * "„<метод>“ е наложен платеж" on an order with order.payment_unclear: ONE gateway of the order, chosen by the
 * person, joins its store's COD list; the store's open orders (this one included) are re-classified.
 */
export async function markOrderGatewayCod(actor: ScopedActor, orderId: string, rawGateway: string) {
  assertCan(actor.role, "stores.manage");
  const db = accountDb(actor.accountId);
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { id: true, companyId: true, storeId: true, raw: true, source: true },
  });
  if (!order || !order.storeId || (actor.companyScope && !actor.companyScope.includes(order.companyId ?? "")))
    throw new DomainError("not_found");
  const gateway = String(rawGateway ?? "").trim();
  const gateways =
    shopifyPaymentOf(order.raw)
      ?.gateways.map((g) => g.trim())
      .filter(Boolean) ?? [];
  if (order.source !== "SHOPIFY" || !gateways.some((g) => g.toLowerCase() === gateway.toLowerCase()))
    throw new DomainError("no_gateway");
  if (NEVER_COD.has(gateway.toLowerCase())) throw new DomainError("gateway_never_cod");
  const added = await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("Store", order.storeId!);
    const store = await tx.store.findUniqueOrThrow({
      where: { id: order.storeId! },
      select: { id: true, codGateways: true },
    });
    if (store.codGateways.some((g) => g.trim().toLowerCase() === gateway.toLowerCase())) return false;
    if (store.codGateways.length >= MAX_COD_GATEWAYS) throw new DomainError("cod_list_full");
    const next = [...store.codGateways, gateway];
    await tx.store.update({ where: { id: store.id }, data: { codGateways: next } });
    await tx.auditLog.create({
      data: {
        accountId: actor.accountId,
        userId: actor.userId,
        action: "store.cod_gateways_added",
        entityType: "Store",
        entityId: store.id,
        before: { codGateways: store.codGateways },
        after: { codGateways: next, fromOrder: order.id },
        ip: actor.ip ?? null,
        userAgent: actor.userAgent?.slice(0, 300) ?? null,
      },
    });
    return true;
  });
  const changed = await reclassifyStorePayments(actor.accountId, order.storeId, actor.userId);
  return { added, changed: changed.length };
}
