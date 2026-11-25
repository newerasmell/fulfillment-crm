import type { EuShipmentsClient } from "@/integrations/eushipments/client";
import { AWB_PROOF_STATUSES, awbDeleted } from "@/integrations/eushipments/adapter";
import { scrubText } from "@/lib/scrub";
import { logger } from "@/lib/logger";
import { systemDb, withAccountTransaction } from "@/server/db/client";
import { crmCancelLeft, warehouseCancelConfirmed } from "@/server/override/cancel-effects";
import { isSupersededShipment } from "@/server/pipeline";
import { advanceOrderStatus } from "./statuses";
import { euReadClientFor } from "./connection";
import { CONFIRMED_DELETE_EVENT, REVIVED_TASK, revivedMarker } from "./delete-events";
export { CONFIRMED_DELETE_EVENT, REVIVED_TASK } from "./delete-events";
import { settleAfterWarehouseCancel } from "@/server/override/settle-after-cancel";

/**
 * Problem shipments checked by their AWB (owner idea 2026-11-24): the warehouse deletes an order in its cabinet while
 * orders-history keeps answering the old status for our reference (references are reused / not unique there), so the
 * CRM kept a "live" shipment, refused cancels and blocked reroutes. Every hour the live euShipments shipments (still
 * at the warehouse: ACCEPTED / PROCESSING, not label parcels) of orders with an open task are asked by their AWBs
 * (GET /get-status, read-only). Only when EVERY AWB of the shipment answers "canceled/deleted" (an AWB is unique; a
 * re-labelled parcel keeps a live one) is the shipment CANCELLED; the order follows as for any delete: after a CRM
 * cancel → BLOCKED (confirmed); deleted without one → BLOCKED with the usual task. Never anything else.
 */

export const AWB_CHECK_MAX = 200;
/** Only before the courier has it: a parcel already on its way is never cancelled from here (a person decides). */
const LIVE = [...AWB_PROOF_STATUSES] as ("ACCEPTED" | "PROCESSING")[];
/** Lookups without an answer in a row before a connection is left for this run (e.g. a revoked token). */
const MAX_UNKNOWN = 3;

type AwbClient = Pick<EuShipmentsClient, "getAwbStatus">;

export async function checkProblemShipmentsByAwb(
  now: Date = new Date(),
  deps: {
    clientFor?: (accountId: string, connectionId: string) => Promise<AwbClient>;
    /** One account only (tests). */
    accountId?: string;
  } = {},
) {
  const db = systemDb();
  const tasks = await db.alert.findMany({
    where: {
      isTask: true,
      status: { not: "RESOLVED" },
      entityType: "Order",
      ...(deps.accountId ? { accountId: deps.accountId } : {}),
    },
    select: { entityId: true },
    distinct: ["entityId"],
    take: 5000,
  });
  const orderIds = tasks.map((t) => t.entityId!).filter(Boolean);
  if (!orderIds.length) return { checked: 0, deleted: 0 };
  const where = {
    orderId: { in: orderIds },
    status: { in: LIVE },
    connection: { type: "EUSHIPMENTS" as const },
    manualShipment: { is: null },
    NOT: { trackingNumbers: { isEmpty: true } },
  };
  // Rotate through every problem shipment, a page per hour (never only the same oldest ones).
  const total = await db.fulfillment.count({ where });
  const pages = Math.max(1, Math.ceil(total / AWB_CHECK_MAX));
  const skip = (Math.floor(now.getTime() / 3_600_000) % pages) * AWB_CHECK_MAX;
  const shipments = await db.fulfillment.findMany({
    where,
    select: {
      id: true,
      accountId: true,
      connectionId: true,
      orderId: true,
      externalId: true,
      trackingNumbers: true,
    },
    orderBy: { id: "asc" },
    skip,
    take: AWB_CHECK_MAX,
  });
  const clients = new Map<string, Promise<AwbClient | null>>();
  const unknownInRow = new Map<string, number>();
  const clientOf = (accountId: string, connectionId: string) => {
    const key = `${accountId}:${connectionId}`;
    if (!clients.has(key))
      clients.set(
        key,
        (deps.clientFor
          ? deps.clientFor(accountId, connectionId)
          : euReadClientFor(accountId, connectionId).then((c) => c.client)
        ).catch(() => null),
      );
    return clients.get(key)!;
  };
  let deleted = 0;
  for (const f of shipments) {
    const key = `${f.accountId}:${f.connectionId}`;
    if ((unknownInRow.get(key) ?? 0) >= MAX_UNKNOWN) continue;
    const client = await clientOf(f.accountId, f.connectionId);
    if (!client) continue;
    const verdict = await awbDeleted(client, f.trackingNumbers);
    // Only a lookup that failed counts against the connection ("no_proof" asked nothing).
    if (verdict === "unknown") unknownInRow.set(key, (unknownInRow.get(key) ?? 0) + 1);
    else if (verdict !== "no_proof") unknownInRow.set(key, 0);
    if (verdict !== "deleted") continue;
    // One shipment that fails never stops the others (the queue does not retry; the next hour tries it again).
    const done = await withAccountTransaction(f.accountId, async (tx, { lockForUpdate, lockKey }) => {
      // As the order-history poller locks it (its stale "Awaiting pickup" must never revive the shipment after this).
      await lockKey(`eushipments:fulfillment:${f.id}`);
      await lockForUpdate("Order", f.orderId);
      const fresh = await tx.fulfillment.findUniqueOrThrow({ where: { id: f.id }, select: { status: true } });
      if (!AWB_PROOF_STATUSES.has(fresh.status) || (await isSupersededShipment(tx, f.id))) return false;
      await tx.fulfillment.update({
        where: { id: f.id },
        data: { status: "CANCELLED", rawStatus: "canceled/deleted (AWB)" },
      });
      await tx.fulfillmentEvent.create({
        data: {
          accountId: f.accountId,
          fulfillmentId: f.id,
          occurredAt: now,
          source: "eushipments:awb",
          rawStatus: "canceled/deleted",
          status: "CANCELLED",
          payload: { awbs: f.trackingNumbers },
        },
      });
      if (await crmCancelLeft(tx, f.accountId, f.id))
        await warehouseCancelConfirmed(tx, {
          accountId: f.accountId,
          orderId: f.orderId,
          fulfillmentId: f.id,
          source: "eushipments.awb",
        });
      else {
        await advanceOrderStatus(tx, f.orderId, "BLOCKED", "eushipments.awb", f.id);
        const open = await tx.alert.findFirst({
          where: {
            kind: "eushipments_cancelled_at_vendor",
            entityType: "Fulfillment",
            entityId: f.id,
            status: { not: "RESOLVED" },
          },
          select: { id: true },
        });
        if (!open)
          await tx.alert.create({
            data: {
              accountId: f.accountId,
              kind: "eushipments_cancelled_at_vendor",
              severity: "CRITICAL",
              isTask: true,
              title: `euShipments: shipment ${f.externalId} was deleted in the cabinet (every AWB says canceled/deleted) — send the order again or cancel it in Shopify`,
              body: `AWB ${f.trackingNumbers.join(", ")}`,
              entityType: "Fulfillment",
              entityId: f.id,
            },
          });
      }
      // The "warehouse refused the cancel" task is answered by the delete.
      await tx.alert.updateMany({
        where: {
          isTask: true,
          status: { not: "RESOLVED" },
          entityType: "Order",
          entityId: f.orderId,
          kind: "warehouse_cancel_refused",
        },
        data: { status: "RESOLVED", resolvedAt: now },
      });
      return true;
    }).catch((err: unknown) => {
      logger.error(
        { fulfillmentId: f.id, err: scrubText(String((err as Error)?.message ?? err), 300) },
        "euShipments AWB check: shipment failed",
      );
      return false;
    });
    if (done) {
      deleted++;
      await settleAfterWarehouseCancel(f.accountId, f.orderId, "eushipments.awb");
    }
  }
  if (deleted)
    logger.info({ checked: shipments.length, deleted }, "euShipments AWB check: deleted shipments found");
  return { checked: shipments.length, deleted };
}

/**
 * Shipments recorded as deleted at euShipments that an orders-history status put back to "accepted" (owner report
 * 2026-11-25: deleted, then shown at the warehouse again, no „Изпрати отново“). The poller no longer does that; for the
 * ones revived before, nothing is changed here — a delete by reference is not always exact proof (references are not
 * unique there), so a person checks the cabinet: a task on the order, and „Складът я е изтрил — потвърди ръчно“ is
 * offered on the shipment (confirmWarehouseCancelByHand). Read-only towards euShipments; one task per shipment, ever.
 */
export async function flagRevivedDeletes(deps: { accountId?: string } = {}) {
  const db = systemDb();
  const rows = await db.fulfillment.findMany({
    where: {
      status: { in: [...LIVE] },
      connection: { type: "EUSHIPMENTS" },
      manualShipment: { is: null },
      ...(deps.accountId ? { accountId: deps.accountId } : {}),
      events: { some: CONFIRMED_DELETE_EVENT },
    },
    select: { id: true, accountId: true, orderId: true, externalId: true },
    orderBy: { id: "asc" },
    take: 500,
  });
  let flagged = 0;
  for (const f of rows) {
    // Once per shipment, ever: a person who found it live in the cabinet and closed the task is not asked again.
    const seen = await db.alert.count({
      where: { accountId: f.accountId, kind: REVIVED_TASK, body: { contains: revivedMarker(f.id) } },
    });
    if (seen) continue;
    await db.alert.create({
      data: {
        accountId: f.accountId,
        kind: REVIVED_TASK,
        isTask: true,
        severity: "WARNING",
        title: `Пратка ${f.externalId}: изтрита в euShipments, но отново се показва в склада — проверете в кабинета и „Складът я е изтрил — потвърди ръчно“`,
        body: `An orders-history status put the shipment back after its delete was recorded (${revivedMarker(f.id)}).`,
        entityType: "Order",
        entityId: f.orderId,
      },
    });
    flagged++;
  }
  return { flagged };
}
