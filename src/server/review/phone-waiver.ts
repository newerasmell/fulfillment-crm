import { z } from "zod";
import { logger } from "@/lib/logger";
import { DomainError } from "@/server/accounts";
import { assertCan } from "@/server/auth/rbac";
import { checkOrder } from "@/server/checks/validate";
import { withAccountTransaction } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";
import { EDITABLE_STATUSES } from "./service";
import { compactPhone, internationalPhone, orderPhoneOf } from "@/lib/phone-waiver";

export { WAIVABLE_PHONE_CODES } from "@/lib/phone-waiver";

/**
 * "Позволи за тази поръчка" for a phone (owner request 2026-11-18): a phone that does not fit the destination
 * country's rule (a foreign number confirmed with the customer) is sent as written, in international form, for this
 * one order. Anyone who reviews orders may allow it, with a reason; audited. Bound to the exact phone: when the
 * order's phone changes the waiver no longer applies and the check blocks again. Never for anything but the phone.
 */

export const AllowPhoneInput = z.object({
  orderId: z.string().min(1).max(64),
  reason: z.string().trim().min(3).max(300),
  /** The phone the person saw in the dialog (compacted): refused if the order's phone changed meanwhile. */
  phoneKey: z.string().trim().min(1).max(32),
});

async function recheck(actor: ScopedActor, orderId: string) {
  try {
    return await checkOrder(actor.accountId, orderId, { actor: { kind: "user", userId: actor.userId } });
  } catch (err) {
    logger.warn({ orderId, err: String(err) }, "re-check after a phone waiver change failed");
    return null;
  }
}

async function loadEditable(
  tx: Parameters<Parameters<typeof withAccountTransaction>[1]>[0],
  actor: ScopedActor,
  orderId: string,
) {
  const order = await tx.order.findFirst({
    where: { id: orderId, accountId: actor.accountId },
    select: { id: true, companyId: true, status: true, phone: true, shippingAddress: true },
  });
  if (!order || (actor.companyScope && !actor.companyScope.includes(order.companyId ?? "")))
    throw new DomainError("not_found");
  if (!(EDITABLE_STATUSES as readonly string[]).includes(order.status)) throw new DomainError("not_editable");
  return order;
}

/** Allows this order's current phone as written (international form). Returns what will be sent. */
export async function allowOrderPhone(actor: ScopedActor, raw: z.input<typeof AllowPhoneInput>) {
  assertCan(actor.role, "orders.review");
  const input = AllowPhoneInput.parse(raw);
  const sent = await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("Order", input.orderId);
    const order = await loadEditable(tx, actor, input.orderId);
    const phone = orderPhoneOf(order);
    const sentPhone = internationalPhone(phone);
    // Only a number with its country code can be sent as written; a local one needs fixing on the order.
    if (!sentPhone) throw new DomainError("phone_not_international");
    if (compactPhone(phone) !== compactPhone(input.phoneKey)) throw new DomainError("phone_changed");
    const data = {
      phoneKey: compactPhone(phone),
      sentPhone,
      reason: input.reason,
      createdById: actor.userId,
      createdAt: new Date(),
    };
    await tx.orderPhoneWaiver.upsert({
      where: { accountId_orderId: { accountId: actor.accountId, orderId: order.id } },
      create: { accountId: actor.accountId, orderId: order.id, ...data },
      update: data,
    });
    // The stored check no longer applies: approve needs the re-check below.
    await tx.orderCheck.deleteMany({ where: { accountId: actor.accountId, orderId: order.id } });
    await tx.auditLog.create({
      data: {
        accountId: actor.accountId,
        userId: actor.userId,
        action: "order.phone_waived",
        entityType: "Order",
        entityId: order.id,
        before: { phone: phone ?? null },
        after: { sentPhone, reason: input.reason },
        ip: actor.ip ?? null,
        userAgent: actor.userAgent?.slice(0, 300) ?? null,
      },
    });
    return sentPhone;
  });
  await recheck(actor, input.orderId);
  return { sentPhone: sent };
}

/** Takes the waiver back: the phone is checked by the country's rule again. */
export async function revokeOrderPhone(actor: ScopedActor, orderId: string) {
  assertCan(actor.role, "orders.review");
  z.string().min(1).max(64).parse(orderId);
  await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("Order", orderId);
    const order = await loadEditable(tx, actor, orderId);
    const removed = await tx.orderPhoneWaiver.deleteMany({
      where: { accountId: actor.accountId, orderId: order.id },
    });
    if (!removed.count) return;
    await tx.orderCheck.deleteMany({ where: { accountId: actor.accountId, orderId: order.id } });
    await tx.auditLog.create({
      data: {
        accountId: actor.accountId,
        userId: actor.userId,
        action: "order.phone_waiver_revoked",
        entityType: "Order",
        entityId: order.id,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent?.slice(0, 300) ?? null,
      },
    });
  });
  await recheck(actor, orderId);
}
