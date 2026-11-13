import type { OutboundStatus, Prisma } from "@/generated/prisma/client";
import { scrubText } from "@/lib/scrub";
import { isRerouteOwnedShipment, transition } from "@/server/pipeline";

/**
 * What a vendor answer to a CRM "cancel at warehouse" means for the ORDER (owner request 2026-11-03). Kept free of
 * vendor imports so the FHB result handler and the euShipments effects/history can call it without a cycle.
 *
 *   warehouseCancelConfirmed() — the vendor confirmed the delete (FHB DELETE success / read-back "gone";
 *                                euShipments delete effect, orders-history "Deleted" or "not found" for a delete the
 *                                CRM requested). The caller has already marked the shipment CANCELLED in the same
 *                                transaction. The order goes to BLOCKED (pipeline cause "vendor") with an info
 *                                timeline entry "отказана в склада от <user>: <reason>", so the operator can
 *                                "Изпрати отново" (new warehouse id) or "Откажи поръчката".
 *   warehouseCancelRefused()   — the vendor definitely refused the delete (already packed …): nothing changes,
 *                                an operator task says so.
 * A shipment owned by a reroute (open or done) is never touched here: processReroute decides (P4-09).
 */

type Tx = Prisma.TransactionClient;
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

/** The vendor writes that cancel one shipment (the same keys reroute and the warehouse-cancel action use). */
export const CANCEL_OPERATIONS = ["fhb.order.delete", "eushipments.deleteOrder"] as const;

/** Marker stored in the outbox payload (FHB `meta`, euShipments `ctx`; never sent to the vendor). */
export const WAREHOUSE_CANCEL_MARK = "warehouseCancel";

export interface WarehouseCancelMeta {
  requestedById: string | null;
  reasonCode: string | null;
  reasonText: string | null;
}

/** The warehouse-cancel context of an outbox payload, or null when the request was not made by that action. */
export function warehouseCancelMeta(payload: unknown): WarehouseCancelMeta | null {
  const p = (payload ?? {}) as { meta?: Record<string, unknown>; ctx?: Record<string, unknown> };
  const m = p.meta ?? p.ctx ?? null;
  if (!m || m[WAREHOUSE_CANCEL_MARK] !== "1") return null;
  const s = (v: unknown) => (typeof v === "string" && v ? v : null);
  return { requestedById: s(m.requestedById), reasonCode: s(m.reasonCode), reasonText: s(m.reasonText) };
}

/** Outbox states in which a cancel is on its way or its outcome is not settled: no second request, no reroute. */
export const CANCEL_IN_FLIGHT: readonly OutboundStatus[] = [
  "PENDING",
  "PAUSED",
  "AWAITING_CONFIRMATION",
  "HELD",
  "SENDING",
  "SENT",
  "UNCERTAIN",
];

/**
 * Outbox states in which a cancel request actually LEFT the CRM (was being sent, was sent, or its outcome is
 * unknown). A DRY_RUN_RECORDED / REFUSED (READ_ONLY) / FAILED / still-queued row never reached the vendor or was
 * refused by it: a deletion seen afterwards was NOT requested by the CRM (someone removed it in the cabinet).
 */
export const CANCEL_LEFT_CRM: readonly OutboundStatus[] = ["SENDING", "SENT", "UNCERTAIN"];

/** Whether a CRM delete of this shipment actually left the CRM (see CANCEL_LEFT_CRM). */
export async function crmCancelLeft(tx: Tx, accountId: string, fulfillmentId: string) {
  const r = await tx.outboundRequest.findFirst({
    where: {
      accountId,
      fulfillmentId,
      operation: { in: [...CANCEL_OPERATIONS] },
      status: { in: [...CANCEL_LEFT_CRM] },
    },
    select: { id: true },
  });
  return !!r;
}

/** The latest CRM cancel request of a shipment (any origin) that left the CRM, newest first. */
export function latestCancelRequest(tx: Tx, accountId: string, fulfillmentId: string) {
  return tx.outboundRequest.findFirst({
    where: {
      accountId,
      fulfillmentId,
      operation: { in: [...CANCEL_OPERATIONS] },
      status: { in: [...CANCEL_LEFT_CRM] },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { id: true, payload: true, status: true, operation: true },
  });
}

async function userLabel(tx: Tx, accountId: string, userId: string | null) {
  if (!userId) return null;
  // Through the account's membership (scoped like the order timeline's "who").
  const m = await tx.membership.findFirst({
    where: { accountId, userId },
    select: { user: { select: { name: true, email: true } } },
  });
  return m ? (m.user.name ?? m.user.email) : null;
}

/** "отказана в склада от <user>: <reason>" (the info line on the order timeline). */
export async function cancelReasonLine(tx: Tx, accountId: string, meta: WarehouseCancelMeta | null) {
  const who = await userLabel(tx, accountId, meta?.requestedById ?? null);
  const reason = [meta?.reasonCode, meta?.reasonText].filter(Boolean).join(": ");
  return `отказана в склада${who ? ` от ${who}` : ""}${reason ? `: ${reason}` : ""}`;
}

async function openOrderTask(
  tx: Tx,
  a: {
    accountId: string;
    orderId: string;
    kind: string;
    severity: "WARNING" | "CRITICAL";
    title: string;
    body: string;
  },
) {
  const open = await tx.alert.findFirst({
    where: {
      accountId: a.accountId,
      kind: a.kind,
      entityType: "Order",
      entityId: a.orderId,
      status: { not: "RESOLVED" },
    },
    select: { id: true },
  });
  if (open) return open.id;
  const created = await tx.alert.create({
    data: {
      accountId: a.accountId,
      kind: a.kind,
      isTask: true,
      severity: a.severity,
      title: a.title.slice(0, 300),
      body: scrubText(a.body, 2000),
      entityType: "Order",
      entityId: a.orderId,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * The vendor confirmed a CRM-requested cancel of this shipment (see the module comment). Call it in the transaction
 * that marked the shipment CANCELLED. Idempotent: a second confirmation finds the order already BLOCKED (or moved
 * on) and writes nothing. Returns true when the order moved to BLOCKED.
 */
export async function warehouseCancelConfirmed(
  tx: Tx,
  input: { accountId: string; orderId: string; fulfillmentId: string; source: string },
): Promise<boolean> {
  if (await isRerouteOwnedShipment(tx, input.fulfillmentId)) return false;
  const req = await latestCancelRequest(tx, input.accountId, input.fulfillmentId);
  const meta = req ? warehouseCancelMeta(req.payload) : null;
  const line = await cancelReasonLine(tx, input.accountId, meta);
  const t = await transition(tx, {
    orderId: input.orderId,
    to: "BLOCKED",
    cause: "vendor",
    actor: { kind: "system" },
    source: input.source,
    reason: line,
    mode: "follow",
    meta: { fulfillmentId: input.fulfillmentId, cancelRequestId: req?.id ?? null, warehouseCancel: true },
  });
  const order = await tx.order.findUniqueOrThrow({
    where: { id: input.orderId },
    select: { status: true, number: true },
  });
  if (t.changed || t.reason === "same") {
    const already = await tx.orderEvent.findFirst({
      where: {
        orderId: input.orderId,
        cause: "warehouse_cancelled",
        meta: { path: ["fulfillmentId"], equals: input.fulfillmentId },
      },
      select: { id: true },
    });
    if (!already)
      await tx.orderEvent.create({
        data: {
          accountId: input.accountId,
          orderId: input.orderId,
          fromStatus: order.status,
          toStatus: order.status,
          cause: "warehouse_cancelled",
          actorType: "system",
          userId: meta?.requestedById ?? null,
          source: input.source,
          reason: line.slice(0, 1000),
          meta: json({
            fulfillmentId: input.fulfillmentId,
            cancelRequestId: req?.id ?? null,
            reasonCode: meta?.reasonCode ?? null,
            reasonText: meta?.reasonText ?? null,
          }),
        },
      });
    return t.changed;
  }
  // The shipment is gone at the warehouse but the order could not follow (e.g. a person moved it meanwhile).
  await openOrderTask(tx, {
    accountId: input.accountId,
    orderId: input.orderId,
    kind: "warehouse_cancel_not_blocked",
    severity: "CRITICAL",
    title: `Поръчка ${order.number}: пратката е отказана в склада, но поръчката не можа да мине в „Блокирана“`,
    body:
      `The shipment was cancelled at the warehouse (${line}). The order is in status ${t.from ?? "?"} ` +
      `(${t.reason}${t.guard ? `: ${t.guard}` : ""}) and was not moved: handle it by hand.`,
  });
  return false;
}

/**
 * The vendor definitely refused a CRM-requested cancel (already packed, no longer deletable …). The shipment stays
 * as it is; an operator task (on the order) says so. Reroute-owned shipments are left to processReroute.
 */
export async function warehouseCancelRefused(
  tx: Tx,
  input: { accountId: string; orderId: string; fulfillmentId: string; detail: string; source: string },
  /** The order row lock: serialises with "Провери задачите" (it must never close the task this refusal joins). */
  lock?: (table: "Order", id: string) => Promise<void>,
) {
  if (lock) await lock("Order", input.orderId);
  if (await isRerouteOwnedShipment(tx, input.fulfillmentId)) return false;
  const f = await tx.fulfillment.findUnique({
    where: { id: input.fulfillmentId },
    select: { externalId: true, order: { select: { number: true } } },
  });
  if (!f) return false;
  await openOrderTask(tx, {
    accountId: input.accountId,
    orderId: input.orderId,
    kind: "warehouse_cancel_refused",
    severity: "WARNING",
    title: `Поръчка ${f.order.number}: складът отказа да откаже пратка ${f.externalId} — тя остава в склада`,
    body: `The warehouse refused the cancel (${input.detail}). Nothing was changed; cancel it in the warehouse cabinet if needed.`,
  });
  const order = await tx.order.findUniqueOrThrow({ where: { id: input.orderId }, select: { status: true } });
  await tx.orderEvent.create({
    data: {
      accountId: input.accountId,
      orderId: input.orderId,
      fromStatus: order.status,
      toStatus: order.status,
      cause: "warehouse_cancel_refused",
      actorType: "system",
      userId: null,
      source: input.source,
      reason: scrubText(input.detail, 500),
      meta: json({ fulfillmentId: input.fulfillmentId }),
    },
  });
  return true;
}
