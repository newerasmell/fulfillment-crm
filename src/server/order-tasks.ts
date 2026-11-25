import { z } from "zod";
import { logger } from "@/lib/logger";
import type { Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, systemDb, withAccountTransaction } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";
import { CANCEL_OPERATIONS, warehouseCancelMeta } from "@/server/override/cancel-effects";

/**
 * "Провери задачите" on the order page (owner request 2026-11-13): the order's open tasks are checked against what
 * the CRM records NOW, and those whose cause is gone are closed (with a note naming why). A task whose cause still
 * holds, or whose kind has no rule here, stays open — nothing is guessed. Each verdict and its close run in one
 * transaction with the order row locked, and the verdict is checked once more after the close (writers record
 * failures without that lock): a task whose cause came back meanwhile is reopened.
 *
 * Rules (per kind):
 *  - warehouse_cancel_refused / reroute_refused ("the warehouse refused the cancel, the shipment stays there"):
 *    closed when every shipment whose cancel was refused (the refusal events / refused re-routes of the order) is
 *    SUBMIT_FAILED or CANCELLED by the warehouse's own word — never one the CRM gave up on "not found" (no proof).
 *    With no such shipment on record: stays.
 *  - shopify_writeback_failed: no failed Shopify write-back left (a FULFIL row always counts — it may have left
 *    something in Shopify; TRACKING / EVENT rows of a shipment that is gone do not);
 *  - shopify_writeback_uncertain: no write-back with an unknown result left;
 *  - shopify_writeback_orphaned: every Shopify fulfillment of a cancelled shipment was taken over (SENT, not a dry
 *    run) by a shipment that is still live, or cancelled in Shopify by the CRM (a CANCEL write-back SENT).
 *  - order_submit_failed / order_blocked / order_unknown / order_stuck (the alert sweep's tasks): closed once the
 *    order has left that status (the sweep would close them at its next run).
 * Never closed here: reroute_uncertain and warehouse_cancel_not_blocked (only a person who checked can say).
 */

const GONE_NOT_FOUND = "not found at euShipments";
const ORPHANED = "shipment_cancelled_after_fulfil";
const REFUSED_CANCEL = new Set(["warehouse_cancel_refused", "reroute_refused"]);
/** A shipment that left the warehouse for the customer. */
const SHIPPED_ON = new Set(["SHIPPED", "DELIVERED", "COD_PAID"]);
/**
 * Order states in which nothing will be shipped from the CRM ("check before shipping" no longer applies). Not SHIPPED
 * and later: a shipment that left unchecked is exactly what the task warns about.
 */
const DONE_SHIPPING = new Set(["FULFILLED_EXTERNALLY", "CANCELLED"]);
/** A shipment that will not ship: cancelled / never accepted, or re-routed away. */
const goneShipment = {
  OR: [
    { status: { in: ["CANCELLED", "SUBMIT_FAILED"] } },
    { reroutesFrom: { some: { status: { in: ["CANCEL_QUEUED", "DONE"] } } } },
  ],
} satisfies Prisma.FulfillmentWhereInput;
/** Proven not to ship (for closing a task): never one given up on "not found", nor a re-route still in flight. */
const provenGone = {
  OR: [
    { status: "SUBMIT_FAILED" },
    { status: "CANCELLED", OR: [{ rawStatus: null }, { rawStatus: { not: GONE_NOT_FOUND } }] },
    { reroutesFrom: { some: { status: "DONE" } } },
  ],
} satisfies Prisma.FulfillmentWhereInput;

export const RecheckTasksInput = z.object({ orderId: z.string().min(1).max(64) });

/** Reason codes (translated on the page: orders.tasksRecheck.why.*). */
export type TaskWhy =
  | "order_state_left"
  | "order_state_holds"
  | "parcel_moved_on"
  | "replacement_sent"
  | "parcel_still_shipped"
  | "old_shipment_live"
  | "old_shipment_unproven"
  | "no_earlier_shipment"
  | "old_shipment_cancelled"
  | "writeback_failed_left"
  | "writeback_failed_none"
  | "writeback_uncertain_left"
  | "writeback_uncertain_none"
  | "orphan_left"
  | "orphan_adopted"
  | "order_done_shipping"
  | "order_not_shipped"
  | "shopify_closed"
  | "shopify_still_open"
  | "shipped_after_all";

type Verdict = { close: boolean; why: TaskWhy };

async function verdictFor(
  tx: Prisma.TransactionClient,
  accountId: string,
  orderId: string,
  alert: { kind: string; createdAt: Date; body?: string | null },
): Promise<Verdict | null> {
  // The sweep's own order-state tasks (owner report 2026-11-24: an order accepted at last kept „Sending to the
  // warehouse failed“ until the next sweep): closed as soon as the order has left that state.
  const stateOf: Record<string, string> = {
    order_submit_failed: "SUBMIT_FAILED",
    order_blocked: "BLOCKED",
    order_unknown: "UNKNOWN",
  };
  if (alert.kind in stateOf || alert.kind === "order_stuck") {
    const wanted =
      alert.kind === "order_stuck"
        ? (alert.body ?? "").replace(/^status=/, "") || null
        : stateOf[alert.kind]!;
    const o = await tx.order.findFirst({ where: { accountId, id: orderId }, select: { status: true } });
    if (!o || !wanted) return null;
    return o.status === wanted
      ? { close: false, why: "order_state_holds" }
      : { close: true, why: "order_state_left" };
  }
  if (REFUSED_CANCEL.has(alert.kind)) {
    // The shipments the task is about (one open task per order collects every refusal): from the refusals themselves.
    const ids =
      alert.kind === "warehouse_cancel_refused"
        ? (
            await tx.orderEvent.findMany({
              where: { accountId, orderId, cause: "warehouse_cancel_refused" },
              select: { meta: true },
            })
          )
            .map((e) => (e.meta as { fulfillmentId?: unknown } | null)?.fulfillmentId)
            .filter((id): id is string => typeof id === "string")
        : (
            await tx.orderReroute.findMany({
              where: { accountId, orderId, status: "REFUSED" },
              select: { fromFulfillmentId: true },
            })
          ).map((x) => x.fromFulfillmentId);
    const before = ids.length
      ? await tx.fulfillment.findMany({
          where: { accountId, orderId, id: { in: [...new Set(ids)] } },
          select: { id: true, status: true, rawStatus: true },
        })
      : [];
    if (!before.length) return { close: false, why: "no_earlier_shipment" };
    // The cancel was asked for "Няма наличност" and the warehouse shipped it anyway: it had the unit after all —
    // nothing left to do (owner report 2026-11-18). Any other reason (the customer cancelled…) stays.
    // Every cancel / re-route asked for this shipment must have been for "Няма наличност" (a customer's cancel among
    // them means the parcel went out against their wish: that stays).
    const shippedDespiteNoStock = async (fulfillmentId: string) => {
      if (alert.kind === "reroute_refused") {
        const rs = await tx.orderReroute.findMany({
          where: { accountId, orderId, fromFulfillmentId: fulfillmentId, status: "REFUSED" },
          select: { reasonCode: true },
        });
        return rs.length > 0 && rs.every((r) => r.reasonCode === "no_stock");
      }
      const reqs = await tx.outboundRequest.findMany({
        where: { accountId, fulfillmentId, operation: { in: [...CANCEL_OPERATIONS] } },
        select: { payload: true },
      });
      const reasons = reqs.map((r) => warehouseCancelMeta(r.payload)).filter((m) => m !== null);
      return reasons.length > 0 && reasons.every((m) => m!.reasonCode === "no_stock");
    };
    let shipped = 0;
    for (const f of before) {
      if (f.status === "CANCELLED" || f.status === "SUBMIT_FAILED") continue;
      if (SHIPPED_ON.has(f.status) && (await shippedDespiteNoStock(f.id))) {
        shipped++;
        continue;
      }
      return { close: false, why: "old_shipment_live" };
    }
    if (shipped === before.length) return { close: true, why: "shipped_after_all" };
    if (before.some((f) => f.status === "CANCELLED" && f.rawStatus === GONE_NOT_FOUND))
      return { close: false, why: "old_shipment_unproven" };
    return { close: true, why: "old_shipment_cancelled" };
  }
  if (alert.kind === "blocked_in_crm_open_in_shopify") {
    const o = await tx.order.findFirst({
      where: { accountId, id: orderId },
      select: { cancelledAt: true, shopifyFinancialStatus: true },
    });
    const done = !!o?.cancelledAt || ["VOIDED", "REFUNDED"].includes(o?.shopifyFinancialStatus ?? "");
    return { close: done, why: done ? "shopify_closed" : "shopify_still_open" };
  }
  if (alert.kind === "parcel_returning") {
    // The carrier returns the parcel: done once the order is no longer "shipped" (returning / returned / delivered
    // after all / cancelled) — FHB's own status follows.
    const o = await tx.order.findFirst({ where: { accountId, id: orderId }, select: { status: true } });
    if (o && o.status !== "SHIPPED") return { close: true, why: "parcel_moved_on" };
    // The advice was followed: a replacement was sent for this order (and not cancelled).
    const replaced = await tx.manualShipment.count({
      where: {
        accountId,
        params: { path: ["replacement", "sourceOrderId"], equals: orderId },
        order: { status: { not: "CANCELLED" } },
      },
    });
    return replaced
      ? { close: true, why: "replacement_sent" }
      : { close: false, why: "parcel_still_shipped" };
  }
  if (alert.kind === "cod_nothing_outstanding") {
    const o = await tx.order.findFirst({ where: { accountId, id: orderId }, select: { status: true } });
    return o && DONE_SHIPPING.has(o.status)
      ? { close: true, why: "order_done_shipping" }
      : { close: false, why: "order_not_shipped" };
  }
  if (alert.kind === "shopify_writeback_failed") {
    const failed = await tx.shopifyWriteBack.count({
      where: {
        accountId,
        orderId,
        status: "FAILED",
        // A failed FULFIL may have left something in Shopify; a failed CANCEL left the fulfillment standing.
        OR: [{ kind: { in: ["FULFIL", "CANCEL"] } }, { fulfillment: { NOT: provenGone } }],
      },
    });
    return { close: !failed, why: failed ? "writeback_failed_left" : "writeback_failed_none" };
  }
  if (alert.kind === "shopify_writeback_uncertain") {
    const unknown = await tx.shopifyWriteBack.count({ where: { accountId, orderId, status: "UNCERTAIN" } });
    return { close: !unknown, why: unknown ? "writeback_uncertain_left" : "writeback_uncertain_none" };
  }
  if (alert.kind === "shopify_writeback_orphaned") {
    const orphaned = await tx.shopifyWriteBack.findMany({
      where: { accountId, orderId, kind: "FULFIL", lastError: ORPHANED },
      select: { shopifyFulfillmentGid: true },
    });
    // Nothing flagged (or a flagged row without its Shopify id): no proof it was taken over.
    if (!orphaned.length || orphaned.some((o) => !o.shopifyFulfillmentGid))
      return { close: false, why: "orphan_left" };
    const adopted = await tx.shopifyWriteBack.findMany({
      where: {
        accountId,
        orderId,
        kind: "FULFIL",
        status: "SENT",
        shopifyFulfillmentGid: { in: orphaned.map((o) => o.shopifyFulfillmentGid!) },
        NOT: { lastError: ORPHANED },
        fulfillment: { NOT: goneShipment },
      },
      select: { shopifyFulfillmentGid: true },
    });
    // Cancelled in Shopify by the CRM (the warehouse deleted the shipment, owner request 2026-11-25): done too.
    const cancelled = await tx.shopifyWriteBack.findMany({
      where: {
        accountId,
        orderId,
        kind: "CANCEL",
        status: "SENT",
        value: { in: orphaned.map((o) => o.shopifyFulfillmentGid!) },
      },
      select: { value: true },
    });
    const held = new Set([...adopted.map((a) => a.shopifyFulfillmentGid), ...cancelled.map((c) => c.value)]);
    const left = orphaned.some((o) => !held.has(o.shopifyFulfillmentGid));
    return { close: !left, why: left ? "orphan_left" : "orphan_adopted" };
  }
  return null;
}

/** Checks the order's open tasks; closes those whose cause is gone. Audited per closed task. */
export async function recheckOrderTasks(actor: ScopedActor, raw: z.input<typeof RecheckTasksInput>) {
  assertCan(actor.role, "orders.review");
  const { orderId } = RecheckTasksInput.parse(raw);
  const db = accountDb(actor.accountId);
  const order = await db.order.findFirst({
    where: { id: orderId, accountId: actor.accountId },
    select: { id: true, companyId: true },
  });
  if (!order || (actor.companyScope && !actor.companyScope.includes(order.companyId ?? "")))
    throw new DomainError("not_found");
  const open = await db.alert.findMany({
    where: {
      accountId: actor.accountId,
      entityType: "Order",
      entityId: orderId,
      status: { not: "RESOLVED" },
    },
    select: { id: true, kind: true, title: true, createdAt: true, body: true },
  });
  const closed: { id: string; title: string; why: TaskWhy }[] = [];
  const kept: { id: string; title: string; why: TaskWhy | null }[] = [];
  for (const a of open) {
    const v = await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
      await lockForUpdate("Order", orderId);
      const verdict = await verdictFor(tx, actor.accountId, orderId, a);
      if (!verdict?.close) return verdict;
      const res = await tx.alert.updateMany({
        where: { id: a.id, accountId: actor.accountId, status: { not: "RESOLVED" } },
        data: { status: "RESOLVED", resolvedAt: new Date() },
      });
      if (res.count !== 1) return null;
      await tx.alertNote.create({
        data: {
          accountId: actor.accountId,
          alertId: a.id,
          userId: actor.userId,
          action: "auto_resolve",
          note: `recheck: ${verdict.why}`,
        },
      });
      return verdict;
    });
    if (!v?.close) {
      kept.push({ id: a.id, title: a.title, why: v?.why ?? null });
      continue;
    }
    // Writers record a failure without the order lock: checked once more after the close, and reopened if a new
    // failure arrived in between (its writer saw this task still open and opened none).
    const again = await withAccountTransaction(actor.accountId, (tx) =>
      verdictFor(tx, actor.accountId, orderId, a),
    );
    if (again && !again.close) {
      const back = await accountDb(actor.accountId).alert.updateMany({
        where: { id: a.id, accountId: actor.accountId, status: "RESOLVED" },
        data: { status: "OPEN", resolvedAt: null },
      });
      if (back.count === 1)
        await accountDb(actor.accountId).alertNote.create({
          data: {
            accountId: actor.accountId,
            alertId: a.id,
            userId: actor.userId,
            action: "note",
            note: `reopened: ${again.why}`,
          },
        });
      kept.push({ id: a.id, title: a.title, why: again.why });
      continue;
    }
    await recordAudit({
      accountId: actor.accountId,
      userId: actor.userId,
      action: "alert.recheck_resolved",
      entityType: "Alert",
      entityId: a.id,
      after: { kind: a.kind, orderId, why: v.why },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    closed.push({ id: a.id, title: a.title, why: v.why });
  }
  return { closed, kept };
}

/** Task kinds the alerts sweep also re-checks on its own (the same rules as the button; never the person-only ones). */
const SWEPT_KINDS = [
  "warehouse_cancel_refused",
  "reroute_refused",
  "parcel_returning",
  "shopify_writeback_orphaned",
];

/**
 * Every 10 min (alerts sweep): the open refused-cancel tasks are checked like "Провери задачите" does and closed when
 * their cause is gone (e.g. shipped after a "Няма наличност" cancel the warehouse refused).
 */
export async function sweepSettledOrderTasks(take = 500) {
  // A page per kind: many open tasks of one kind never starve the others.
  const open = (
    await Promise.all(
      SWEPT_KINDS.map((kind) =>
        systemDb().alert.findMany({
          where: { kind, entityType: "Order", status: { not: "RESOLVED" } },
          select: { id: true, accountId: true, kind: true, entityId: true, createdAt: true },
          orderBy: { createdAt: "asc" },
          take,
        }),
      ),
    )
  ).flat();
  let resolved = 0;
  for (const a of open) {
    if (!a.entityId) continue;
    const done = await withAccountTransaction(a.accountId, async (tx, { lockForUpdate }) => {
      await lockForUpdate("Order", a.entityId!);
      const v = await verdictFor(tx, a.accountId, a.entityId!, a);
      if (!v?.close) return false;
      const r = await tx.alert.updateMany({
        where: { id: a.id, accountId: a.accountId, status: { not: "RESOLVED" } },
        data: { status: "RESOLVED", resolvedAt: new Date() },
      });
      if (!r.count) return false;
      await tx.alertNote.create({
        data: { accountId: a.accountId, alertId: a.id, action: "auto_resolve", note: `sweep: ${v.why}` },
      });
      return true;
    });
    if (done) resolved++;
  }
  return { resolved };
}

/**
 * Right after something settled an order (owner report 2026-11-25: the warehouse cancel was confirmed and four yellow
 * tasks stayed until the next sweep): its open tasks are checked by the same rules as "Провери задачите" and closed
 * when their cause is gone — at once, not at the next sweep. Each closed task keeps a note (history); a task whose
 * cause still holds stays. Never throws (the caller's work is already committed).
 */
export async function settleOrderTasksNow(accountId: string, orderId: string, source: string) {
  let closed = 0;
  try {
    const open = await accountDb(accountId).alert.findMany({
      where: { accountId, entityType: "Order", entityId: orderId, status: { not: "RESOLVED" } },
      select: { id: true, kind: true, createdAt: true, body: true },
    });
    for (const a of open) {
      const done = await withAccountTransaction(accountId, async (tx, { lockForUpdate }) => {
        await lockForUpdate("Order", orderId);
        const v = await verdictFor(tx, accountId, orderId, a);
        if (!v?.close) return false;
        const r = await tx.alert.updateMany({
          where: { id: a.id, accountId, status: { not: "RESOLVED" } },
          data: { status: "RESOLVED", resolvedAt: new Date() },
        });
        if (!r.count) return false;
        await tx.alertNote.create({
          data: { accountId, alertId: a.id, action: "auto_resolve", note: `${source}: ${v.why}` },
        });
        return true;
      });
      if (done) closed++;
    }
  } catch (err) {
    logger.warn(
      { orderId, err: String((err as Error)?.message ?? err).slice(0, 300) },
      "settle order tasks failed",
    );
  }
  return closed;
}
