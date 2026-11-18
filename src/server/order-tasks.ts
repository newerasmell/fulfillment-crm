import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";

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
 *    run) by a shipment that is still live.
 * Never closed here: reroute_uncertain and warehouse_cancel_not_blocked (only a person who checked can say).
 */

const GONE_NOT_FOUND = "not found at euShipments";
const ORPHANED = "shipment_cancelled_after_fulfil";
const REFUSED_CANCEL = new Set(["warehouse_cancel_refused", "reroute_refused"]);
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
    { status: "CANCELLED", NOT: { rawStatus: GONE_NOT_FOUND } },
    { reroutesFrom: { some: { status: "DONE" } } },
  ],
} satisfies Prisma.FulfillmentWhereInput;

export const RecheckTasksInput = z.object({ orderId: z.string().min(1).max(64) });

/** Reason codes (translated on the page: orders.tasksRecheck.why.*). */
export type TaskWhy =
  | "old_shipment_live"
  | "old_shipment_unproven"
  | "no_earlier_shipment"
  | "old_shipment_cancelled"
  | "writeback_failed_left"
  | "writeback_failed_none"
  | "writeback_uncertain_left"
  | "writeback_uncertain_none"
  | "orphan_left"
  | "orphan_adopted";

type Verdict = { close: boolean; why: TaskWhy };

async function verdictFor(
  tx: Prisma.TransactionClient,
  accountId: string,
  orderId: string,
  alert: { kind: string; createdAt: Date },
): Promise<Verdict | null> {
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
          select: { status: true, rawStatus: true },
        })
      : [];
    if (!before.length) return { close: false, why: "no_earlier_shipment" };
    if (before.some((f) => f.status !== "CANCELLED" && f.status !== "SUBMIT_FAILED"))
      return { close: false, why: "old_shipment_live" };
    if (before.some((f) => f.status === "CANCELLED" && f.rawStatus === GONE_NOT_FOUND))
      return { close: false, why: "old_shipment_unproven" };
    return { close: true, why: "old_shipment_cancelled" };
  }
  if (alert.kind === "shopify_writeback_failed") {
    const failed = await tx.shopifyWriteBack.count({
      where: {
        accountId,
        orderId,
        status: "FAILED",
        OR: [{ kind: "FULFIL" }, { fulfillment: { NOT: provenGone } }],
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
    const held = new Set(adopted.map((a) => a.shopifyFulfillmentGid));
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
    select: { id: true, kind: true, title: true, createdAt: true },
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
