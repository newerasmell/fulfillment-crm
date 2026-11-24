import { collectableCod } from "@/lib/cod-rounding";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { INACTIVE_SHIPMENT } from "@/server/override/guards";
import { transition } from "@/server/pipeline";
import type { ScopedActor } from "@/server/stores";

/**
 * „Прикачи към поръчка от Shopify“ (owner request 2026-11-24, optional): a manual shipment sent for a Shopify order
 * (the order could not go the normal way: a warehouse refused it, a cancel in ZOE, …) is attached to that order. The
 * manual shipment becomes the order's live shipment — the order follows its status and tracking, Shopify gets the
 * tracking (the customer gets the updates), the order's open tasks close and it leaves „С грешки“ — and the manual
 * order record is closed (CANCELLED, "attached to …"). Never a second shipment: refused while the Shopify order has a
 * live shipment or a warehouse write on its way.
 */

/** Outbox states of a write still on its way or unknown (a shipment may exist or come). */
const OPEN_WRITE = ["PENDING", "PAUSED", "HELD", "AWAITING_CONFIRMATION", "SENDING", "UNCERTAIN"] as const;
/** The Shopify order's tasks the attached shipment answers (others — Shopify write-backs, payments — stay open). */
const ANSWERED_TASKS = [
  "order_blocked",
  "order_unknown",
  "order_submit_failed",
  "order_stuck",
  "out_of_stock",
  "warehouse_cancel_refused",
  "warehouse_cancel_not_blocked",
  "warehouse_cancel_no_stock_by_hand",
  "reroute_refused",
  "parcel_returning",
] as const;
/** Shipment statuses the Shopify order may take over (a parcel in trouble is not attached). */
const SHIPPING = ["ACCEPTED", "PROCESSING", "SHIPPED", "DELIVERED"] as const;
/** Shopify accepts tracking for the usual write-back only this long after shipping (fulfill/writeback.ts). */
const WRITE_BACK_DAYS = 14;

/** Shopify orders of the manual order's company matching a typed number (for the search box). */
export async function findShopifyOrdersToLink(actor: ScopedActor, manualOrderId: string, q: string) {
  assertCan(actor.role, "orders.fulfill");
  const db = accountDb(actor.accountId);
  const manual = await db.order.findFirst({
    where: { id: manualOrderId, source: "MANUAL", ...scope(actor) },
    select: { companyId: true },
  });
  if (!manual) throw new DomainError("not_found");
  const query = q.trim().replace(/^#/, "");
  if (query.length < 2) return [];
  return db.order.findMany({
    where: {
      source: "SHOPIFY",
      companyId: manual.companyId,
      number: { contains: query, mode: "insensitive" },
      ...scope(actor),
    },
    select: { id: true, number: true, status: true, customerName: true, total: true, currency: true },
    orderBy: { placedAt: "desc" },
    take: 10,
  });
}

function scope(actor: ScopedActor) {
  return actor.companyScope ? { companyId: { in: actor.companyScope } } : {};
}

export async function linkManualToShopifyOrder(
  actor: ScopedActor,
  input: { manualOrderId: string; shopifyOrderId: string; acknowledgeCod?: boolean },
  now: Date = new Date(),
) {
  assertCan(actor.role, "orders.fulfill");
  const result = await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate, lockKey }) => {
    // Lock order as the label / euShipments workers take it: the shipment's keys first, then the order rows (sorted).
    const ms = await tx.manualShipment.findFirst({
      where: { orderId: input.manualOrderId },
      select: { fulfillmentId: true },
    });
    if (!ms) throw new DomainError("not_found");
    // A warehouse manual order's shipment is not always written on its ManualShipment: its live shipment then.
    const fid =
      ms.fulfillmentId ??
      (
        await tx.fulfillment.findFirst({
          where: { orderId: input.manualOrderId, status: { in: [...SHIPPING] } },
          select: { id: true },
          orderBy: { createdAt: "desc" },
        })
      )?.id ??
      null;
    if (!fid) throw new DomainError("manual_not_shipped");
    const pre = { fulfillmentId: fid };
    await lockKey(`labels:fulfillment:${pre.fulfillmentId}`);
    await lockKey(`eushipments:fulfillment:${pre.fulfillmentId}`);
    for (const id of [input.shopifyOrderId, input.manualOrderId].sort()) await lockForUpdate("Order", id);
    const manual = await tx.order.findFirst({
      where: { id: input.manualOrderId, source: "MANUAL", ...scope(actor) },
      select: {
        id: true,
        number: true,
        status: true,
        companyId: true,
        paymentMethod: true,
        codAmount: true,
        currency: true,
        lines: { select: { id: true, productId: true, quantity: true } },
        manualShipment: { select: { id: true, kind: true } },
      },
    });
    if (!manual) throw new DomainError("not_found");
    const f = await tx.fulfillment.findFirst({
      where: { id: pre.fulfillmentId, orderId: manual.id },
      select: { id: true, orderId: true, status: true, shippedAt: true, lines: true },
    });
    if (!f || !manual.manualShipment) throw new DomainError("manual_not_shipped");
    if (!(SHIPPING as readonly string[]).includes(f.status)) throw new DomainError("manual_not_shipped");
    // Nothing of the manual shipment on its way either (a void / cancel / reroute would land on the wrong order).
    const manualWrites = await tx.outboundRequest.count({
      where: { fulfillmentId: f.id, status: { in: [...OPEN_WRITE] } },
    });
    const manualReroute = await tx.orderReroute.count({
      where: { fromFulfillmentId: f.id, status: { in: ["CANCEL_QUEUED"] } },
    });
    if (manualWrites || manualReroute) throw new DomainError("manual_write_pending");

    const order = await tx.order.findFirst({
      where: { id: input.shopifyOrderId, source: "SHOPIFY", ...scope(actor) },
      select: {
        id: true,
        number: true,
        status: true,
        companyId: true,
        cancelledAt: true,
        shopifyFinancialStatus: true,
        paymentMethod: true,
        codAmount: true,
        currency: true,
        codLocalAmount: true,
        codLocalCurrency: true,
        lines: { select: { id: true, productId: true, quantity: true } },
      },
    });
    if (!order) throw new DomainError("not_found");
    if (order.companyId !== manual.companyId) throw new DomainError("other_company");
    if (order.cancelledAt || ["VOIDED", "REFUNDED"].includes(order.shopifyFinancialStatus ?? ""))
      throw new DomainError("order_cancelled_in_shopify");
    // Cancelled in the CRM is final (the pipeline never reopens it): attach nothing to it.
    if (order.status === "CANCELLED" || order.status === "FULFILLED_EXTERNALLY")
      throw new DomainError("order_closed_in_crm");
    // Never two shipments: no live shipment and no warehouse write on its way for the Shopify order.
    const live = await tx.fulfillment.count({
      where: { orderId: order.id, status: { notIn: [...INACTIVE_SHIPMENT] } },
    });
    if (live) throw new DomainError("order_has_shipment");
    const pending = await tx.outboundRequest.count({
      where: { fulfillment: { orderId: order.id }, status: { in: [...OPEN_WRITE] } },
    });
    if (pending) throw new DomainError("order_write_pending");
    const shopifyOpen = await tx.shopifyWriteBack.count({
      where: { orderId: order.id, status: { in: ["SENDING", "UNCERTAIN"] } },
    });
    if (shopifyOpen) throw new DomainError("order_write_pending");

    // The shipment's lines move to the Shopify order's lines by product and must cover the whole order (a partial
    // parcel would leave items unsent with the order shown as shipped); a label parcel (no lines) covers it all.
    const remaining = new Map(order.lines.map((l) => [l.id, l.quantity]));
    const moved = new Map<string, number>();
    if (f.lines.length) {
      const productOf = new Map(manual.lines.map((l) => [l.id, l.productId]));
      for (const fl of f.lines) {
        const productId = productOf.get(fl.orderLineId);
        let left = fl.quantity;
        for (const l of order.lines) {
          if (!productId || l.productId !== productId || left === 0) continue;
          const take = Math.min(left, remaining.get(l.id) ?? 0);
          if (!take) continue;
          remaining.set(l.id, (remaining.get(l.id) ?? 0) - take);
          moved.set(l.id, (moved.get(l.id) ?? 0) + take);
          left -= take;
        }
        if (left) throw new DomainError("lines_do_not_match");
      }
      if ([...remaining.values()].some((q) => q > 0)) throw new DomainError("lines_do_not_match");
    } else for (const l of order.lines) moved.set(l.id, l.quantity);

    // Cash on delivery: what the parcel collects vs what the Shopify order expects (in the parcel's currency).
    const sentCod =
      manual.paymentMethod === "COD" ? collectableCod(Number(manual.codAmount ?? 0), manual.currency) : 0;
    const orderCurrency = order.codLocalCurrency ?? order.currency;
    const expectedCod =
      order.paymentMethod === "COD"
        ? collectableCod(Number(order.codLocalAmount ?? order.codAmount ?? 0), orderCurrency)
        : 0;
    const codDiffers =
      Math.round(sentCod * 100) !== Math.round(expectedCod * 100) ||
      (sentCod > 0 && expectedCod > 0 && manual.currency !== orderCurrency);
    if (codDiffers && !input.acknowledgeCod)
      throw Object.assign(new DomainError("cod_differs"), {
        detail: {
          sent: sentCod,
          sentCurrency: manual.currency,
          expected: expectedCod,
          expectedCurrency: orderCurrency,
        },
      });

    await transition(tx, {
      orderId: order.id,
      to: f.status as (typeof SHIPPING)[number],
      cause: "manual_link",
      actor: { kind: "user", userId: actor.userId },
      source: "manual.link",
      reason: `manual shipment ${manual.number}`,
      mode: "strict",
    });
    await tx.fulfillmentLine.deleteMany({ where: { fulfillmentId: f.id } });
    await tx.fulfillment.update({ where: { id: f.id }, data: { orderId: order.id } });
    // The manual record keeps pointing at its shipment (the link on its page reads it).
    await tx.manualShipment.update({
      where: { id: manual.manualShipment.id },
      data: { fulfillmentId: f.id },
    });
    if (moved.size)
      await tx.fulfillmentLine.createMany({
        data: [...moved].map(([orderLineId, quantity]) => ({
          accountId: actor.accountId,
          fulfillmentId: f.id,
          orderLineId,
          quantity,
        })),
      });
    // The manual record is closed: its shipment now belongs to the Shopify order.
    await transition(tx, {
      orderId: manual.id,
      to: "CANCELLED",
      cause: "manual_link",
      actor: { kind: "user", userId: actor.userId },
      source: "manual.link",
      reason: `attached to ${order.number}`,
      mode: "strict",
    });
    // The Shopify order's tasks the attached shipment answers.
    const open = await tx.alert.findMany({
      where: {
        isTask: true,
        status: { not: "RESOLVED" },
        entityType: "Order",
        entityId: order.id,
        kind: { in: [...ANSWERED_TASKS] },
      },
      select: { id: true },
    });
    // …and those filed on its old (cancelled / failed) shipments: a warehouse refusal or a cancel in ZOE.
    const oldShipments = await tx.fulfillment.findMany({
      where: { orderId: order.id, id: { not: f.id }, status: { in: [...INACTIVE_SHIPMENT] } },
      select: { id: true },
    });
    if (oldShipments.length)
      open.push(
        ...(await tx.alert.findMany({
          where: {
            isTask: true,
            status: { not: "RESOLVED" },
            entityType: "Fulfillment",
            entityId: { in: oldShipments.map((x) => x.id) },
            kind: { in: ["fhb_order_rejected", "fhb_order_cancelled_in_zoe", "eushipments_submit_failed"] },
          },
          select: { id: true },
        })),
      );
    const note = `Attached manual shipment ${manual.number}`;
    for (const a of open) {
      const res = await tx.alert.updateMany({
        where: { id: a.id, status: { not: "RESOLVED" } },
        data: { status: "RESOLVED", resolvedAt: now },
      });
      if (res.count === 1)
        await tx.alertNote.create({
          data: { accountId: actor.accountId, alertId: a.id, userId: actor.userId, action: "resolve", note },
        });
    }
    const task = async (kind: string, title: string) =>
      tx.alert.create({
        data: {
          accountId: actor.accountId,
          kind,
          isTask: true,
          severity: "WARNING",
          title,
          entityType: "Order",
          entityId: order.id,
        },
      });
    // Attached although the cash differs: a person reconciles it.
    if (codDiffers)
      await task(
        "manual_link_cod_differs",
        `${order.number}: the attached shipment ${manual.number} collects ${sentCod} ${manual.currency}, the order expects ${expectedCod} ${orderCurrency} — check the cash on delivery`,
      );
    // Shipped long ago: the usual write-back no longer sends its tracking to Shopify.
    if (f.shippedAt && now.getTime() - f.shippedAt.getTime() > WRITE_BACK_DAYS * 86_400_000)
      await task(
        "manual_link_tracking_by_hand",
        `${order.number}: shipment ${manual.number} shipped over ${WRITE_BACK_DAYS} days ago — add its tracking in Shopify by hand`,
      );
    return {
      orderId: order.id,
      orderNumber: order.number,
      manualOrderId: manual.id,
      manualNumber: manual.number,
      fulfillmentId: f.id,
      closedTasks: open.length,
      codDiffers,
    };
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "manual.link",
    entityType: "Order",
    entityId: result.orderId,
    after: {
      manualOrderId: result.manualOrderId,
      fulfillmentId: result.fulfillmentId,
      codDiffers: result.codDiffers,
    },
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
  });
  return result;
}

/** On the manual order page: the Shopify order its shipment was attached to (if any). */
export async function attachedTo(accountId: string, manualOrderId: string) {
  const m = await accountDb(accountId).manualShipment.findFirst({
    where: { orderId: manualOrderId },
    select: { fulfillment: { select: { orderId: true, order: { select: { id: true, number: true } } } } },
  });
  return m?.fulfillment && m.fulfillment.orderId !== manualOrderId ? m.fulfillment.order : null;
}
