import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { assertCan } from "@/server/auth/rbac";
import { checkOrder } from "@/server/checks";
import { withAccountTransaction } from "@/server/db/client";
import { transition } from "@/server/pipeline";
import { hasStoreTag, shopifyTagsOf } from "@/server/shopify/order-tag-match";
import type { ScopedActor } from "@/server/stores";

/**
 * Противосаботаж decisions (owner request 2026-11-10) on an order held for its quantity (QTY_HOLD):
 *  - "Одобри": the order enters review from the start (or waits for its store's tag) and from then on reserves its
 *    units, so they leave every store of the line within about a minute;
 *  - "Откажи": the order is cancelled in the CRM; it never reserved anything, so no store's stock moves.
 * orders.review; audited through the status change; the hold task is resolved by the status change itself.
 */

const Reason = z.string().trim().max(300).nullish();

async function heldOrder(
  tx: Parameters<Parameters<typeof withAccountTransaction>[1]>[0],
  actor: ScopedActor,
  orderId: string,
) {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, companyId: true, storeId: true, raw: true, tags: true, source: true },
  });
  if (!order || (actor.companyScope && !actor.companyScope.includes(order.companyId ?? "")))
    throw new DomainError("not_found");
  if (order.status !== "QTY_HOLD") throw new DomainError("not_qty_hold");
  return order;
}

export async function approveQtyHold(actor: ScopedActor, orderId: string, rawReason?: string | null) {
  assertCan(actor.role, "orders.review");
  const reason = Reason.parse(rawReason) || "quantity approved";
  const to = await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("Order", orderId);
    const order = await heldOrder(tx, actor, orderId);
    // A store that takes only tagged orders: without the tag it waits for it (and still reserves nothing).
    const gate =
      order.storeId && order.source === "SHOPIFY"
        ? await tx.storeOrderTag.findFirst({ where: { storeId: order.storeId }, select: { tag: true } })
        : null;
    const target =
      gate && !hasStoreTag(shopifyTagsOf(order.raw, order.tags), gate.tag)
        ? ("AWAITING_TAG" as const)
        : ("IMPORTED" as const);
    await transition(tx, {
      orderId,
      to: target,
      cause: "qty_release",
      actor: { kind: "user", userId: actor.userId },
      source: "qty_hold",
      reason,
      mode: "strict",
    });
    return target;
  });
  if (to === "IMPORTED")
    await checkOrder(actor.accountId, orderId, { actor: { kind: "user", userId: actor.userId } });
  return { status: to };
}

export async function rejectQtyHold(actor: ScopedActor, orderId: string, rawReason?: string | null) {
  assertCan(actor.role, "orders.review");
  const reason = Reason.parse(rawReason) || "quantity rejected (anti-sabotage)";
  await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("Order", orderId);
    await heldOrder(tx, actor, orderId);
    await transition(tx, {
      orderId,
      to: "CANCELLED",
      cause: "cancel",
      actor: { kind: "user", userId: actor.userId },
      source: "qty_hold",
      reason,
      mode: "strict",
    });
  });
  return { status: "CANCELLED" as const };
}
