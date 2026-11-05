import { z } from "zod";
import { logger } from "@/lib/logger";
import { DomainError } from "@/server/accounts";
import { assertCan } from "@/server/auth/rbac";
import { checkOrder } from "@/server/checks";
import { withAccountTransaction } from "@/server/db/client";
import { localCurrencyFor } from "@/server/countries/currency";
import { classifyPayment } from "@/server/shopify/payment";
import { shopifyPaymentOf } from "@/server/shopify/payment-facts";
import type { ScopedActor } from "@/server/stores";
import { EDITABLE_STATUSES } from "./service";

/**
 * "Промени наложения платеж" (owner request 2026-11-05): after a product swap the amount to collect changes. A person
 * sets the order's COD in the order currency (0 = prepaid, nothing to collect). Only while the order is in review
 * (never once anything went to a warehouse); audited; the order is checked again (the approval fingerprint covers
 * payment). The manual value (OrderCodOverride) survives Shopify re-imports and COD-list re-classifications until a
 * person clears it, which puts Shopify's payment back. The AI never calls this (CLAUDE.md: AI never changes COD).
 */

export const SetCodInput = z.object({
  orderId: z.string().min(1).max(64),
  /**
   * In the order currency; 0 = prepaid. A plain decimal only ("12", "12.5", "12,50"): an empty field is NEVER read
   * as 0 (that would silently make a COD order prepaid).
   */
  amount: z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .pipe(z.string().regex(/^\d{1,7}([.,]\d{1,2})?$/))
    .transform((v) => Number(v.replace(",", "."))),
  note: z
    .string()
    .trim()
    .max(300)
    .nullish()
    .transform((v) => v || null),
});

const isEditable = (s: string) => (EDITABLE_STATUSES as readonly string[]).includes(s);

async function recheck(actor: ScopedActor, orderId: string) {
  try {
    return await checkOrder(actor.accountId, orderId, { actor: { kind: "user", userId: actor.userId } });
  } catch (err) {
    logger.warn({ orderId, err: String(err) }, "re-check after a COD change failed");
    return null;
  }
}

export async function setOrderCod(actor: ScopedActor, raw: z.input<typeof SetCodInput>) {
  assertCan(actor.role, "orders.review");
  const input = SetCodInput.parse(raw);
  const cod = input.amount > 0;
  const amount = cod ? input.amount.toFixed(2) : null;
  await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("Order", input.orderId);
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      select: {
        id: true,
        companyId: true,
        status: true,
        paymentMethod: true,
        codAmount: true,
        source: true,
        raw: true,
        currency: true,
        countryCode: true,
        shippingAddress: true,
        codOverride: { select: { id: true } },
      },
    });
    if (!order || (actor.companyScope && !actor.companyScope.includes(order.companyId ?? "")))
      throw new DomainError("not_found");
    if (!isEditable(order.status)) throw new DomainError("not_editable");
    // Nothing to collect while Shopify still shows money owed: only with a stated reason.
    const owed = order.source === "SHOPIFY" ? (shopifyPaymentOf(order.raw)?.outstanding ?? 0) : 0;
    if (!cod && owed > 0.005 && !input.note) throw new DomainError("cod_zero_needs_reason");
    // The amount is in the order currency; a COD to a country with another local currency needs the local
    // amount, which this editor does not take — refused instead of leaving the order blocked.
    const country = (
      ((order.shippingAddress ?? {}) as { countryCode?: string | null }).countryCode ?? order.countryCode
    )?.toUpperCase();
    const setting = country
      ? await tx.countrySetting.findUnique({
          where: { accountId_country: { accountId: actor.accountId, country } },
        })
      : null;
    const local = localCurrencyFor(setting, country);
    if (cod && local && local !== order.currency.toUpperCase())
      throw new DomainError("cod_currency_mismatch");
    const previous = {
      paymentMethod: order.paymentMethod,
      codAmount: order.codAmount?.toString() ?? null,
      shopifyOwed: owed,
    };
    const data = {
      paymentMethod: cod ? ("COD" as const) : ("PREPAID" as const),
      codAmount: amount,
      note: input.note,
      userId: actor.userId,
    };
    await tx.orderCodOverride.upsert({
      where: { accountId_orderId: { accountId: actor.accountId, orderId: order.id } },
      create: { accountId: actor.accountId, orderId: order.id, previous, ...data },
      update: data,
    });
    await tx.order.update({
      where: { id: order.id },
      data: {
        paymentMethod: data.paymentMethod,
        codAmount: amount,
        // A local-currency amount belonged to the old COD; the COD checks ask for it again when needed.
        codLocalAmount: null,
        codLocalCurrency: null,
        codRate: null,
      },
    });
    // The stored check (and any approval of it) no longer applies: approve needs the re-check below.
    await tx.orderCheck.deleteMany({ where: { orderId: order.id } });
    await tx.auditLog.create({
      data: {
        accountId: actor.accountId,
        userId: actor.userId,
        action: "order.cod_changed",
        entityType: "Order",
        entityId: order.id,
        before: previous,
        after: { paymentMethod: data.paymentMethod, codAmount: amount, note: input.note },
        ip: actor.ip ?? null,
        userAgent: actor.userAgent?.slice(0, 300) ?? null,
      },
    });
  });
  return recheck(actor, input.orderId);
}

/** Removes the manual COD: a Shopify order gets Shopify's payment back (store COD list), others their previous one. */
export async function clearOrderCod(actor: ScopedActor, orderId: string) {
  assertCan(actor.role, "orders.review");
  const changed = await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("Order", orderId);
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        companyId: true,
        status: true,
        source: true,
        raw: true,
        paymentMethod: true,
        codAmount: true,
        store: { select: { codGateways: true } },
        codOverride: true,
      },
    });
    if (!order || (actor.companyScope && !actor.companyScope.includes(order.companyId ?? "")))
      throw new DomainError("not_found");
    if (!isEditable(order.status)) throw new DomainError("not_editable");
    if (!order.codOverride) return false;
    let back: { paymentMethod: "COD" | "PREPAID"; codAmount: string | null };
    if (order.source === "SHOPIFY" && order.raw && order.store) {
      const c = classifyPayment(order.raw, order.store.codGateways);
      back = { paymentMethod: c.cod ? "COD" : "PREPAID", codAmount: c.codAmount };
    } else {
      const p = (order.codOverride.previous ?? {}) as { paymentMethod?: string; codAmount?: string | null };
      back = {
        paymentMethod: p.paymentMethod === "COD" ? "COD" : "PREPAID",
        codAmount: p.paymentMethod === "COD" ? (p.codAmount ?? null) : null,
      };
    }
    await tx.orderCodOverride.delete({ where: { id: order.codOverride.id } });
    await tx.order.update({
      where: { id: order.id },
      data: { ...back, codLocalAmount: null, codLocalCurrency: null, codRate: null },
    });
    await tx.orderCheck.deleteMany({ where: { orderId: order.id } });
    await tx.auditLog.create({
      data: {
        accountId: actor.accountId,
        userId: actor.userId,
        action: "order.cod_restored",
        entityType: "Order",
        entityId: order.id,
        before: { paymentMethod: order.paymentMethod, codAmount: order.codAmount?.toString() ?? null },
        after: back,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent?.slice(0, 300) ?? null,
      },
    });
    return true;
  });
  return changed ? recheck(actor, orderId) : null;
}
