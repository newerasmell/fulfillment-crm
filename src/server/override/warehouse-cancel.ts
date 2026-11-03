import { z } from "zod";
import type { ConnectionType, LiveMode, OutboundStatus, Prisma } from "@/generated/prisma/client";
import { EU_OPS } from "@/integrations/eushipments/adapter";
import { DomainError } from "@/server/accounts";
import { assertCan, can } from "@/server/auth/rbac";
import { accountDb, isUniqueViolation, withAccountTransaction } from "@/server/db/client";
import { enqueueOutboundInTx } from "@/server/outbox/outbox";
import type { ScopedActor } from "@/server/stores";
import { CANCEL_OPERATIONS, WAREHOUSE_CANCEL_MARK } from "./cancel-effects";
import { recordTimelineEvent } from "./choice";
import { INACTIVE_SHIPMENT } from "./guards";
import { scopedOrderForChoice } from "./options";
import { assertWarehouseReason } from "./reasons";
import { cancelRefusal } from "./reroute";

/**
 * "Откажи в склада" (owner request 2026-11-03): cancel one active shipment at its warehouse from the CRM, without
 * opening the warehouse cabinet. OWNER/ADMIN (orders.cancelShipment), a reason code is required, everything is
 * audited.
 *
 *   warehouseCancelView()    — per active shipment: may it be cancelled from here, and the last cancel request;
 *   requestWarehouseCancel() — queues the vendor cancel THROUGH THE OUTBOX (the sender applies the connection's
 *                              liveMode: READ_ONLY refuses, DRY_RUN only records, CANARY waits for a confirmation,
 *                              LIVE sends). The same idempotency keys as reroute and the older services
 *                              (`fhb.order.delete:<id>`, `delete:<ref>`): a double click or a concurrent request
 *                              finds the first one and queues nothing.
 * When the vendor confirms (./cancel-effects.ts): shipment CANCELLED, order BLOCKED with an info timeline entry.
 * When it refuses: the shipment stays, an operator task says so. Never while a reroute owns the shipment.
 *
 * Cancellable only while the vendor still allows it (INTEGRATION_NOTES §2.3, §4.3): FHB DELETE /order only while the
 * raw status is `pending`; euShipments delete only in New / Information received / Awaiting pickup and within 14
 * days. Label shipments (FHB Joy / euShipments AWB, src/server/labels) are not offered here: their documented void
 * lives on the manual shipment's page (voidLabel) and follows the label flow.
 */

type Tx = Prisma.TransactionClient;
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

export const WarehouseCancelInput = z.object({
  fulfillmentId: z.string().min(1).max(64),
  reasonCode: z.string().trim().max(40).nullable().optional(),
  reasonText: z.string().max(1000).nullable().optional(),
});
export type WarehouseCancelInput = z.input<typeof WarehouseCancelInput>;

/** Outbox states in which a cancel is on its way or its outcome is not settled: no second request. */
const IN_FLIGHT: readonly OutboundStatus[] = [
  "PENDING",
  "PAUSED",
  "AWAITING_CONFIRMATION",
  "HELD",
  "SENDING",
  "SENT",
  "UNCERTAIN",
];

export interface CancelShipmentLike {
  status: string;
  rawStatus: string | null;
  submittedAt: Date | null;
  createdAt: Date;
  connectionType: ConnectionType;
  /** A label shipment (ManualShipment) — never cancelled from here. */
  label: boolean;
}

/**
 * Why this shipment cannot be cancelled from the CRM right now (null = it can). Pure. Codes:
 *   label                        — a label shipment: void it on the manual shipment's page;
 *   not_at_warehouse_yet_or_locked, fhb_not_pending, eushipments_not_deletable — the vendor no longer allows it
 *                                  (or the shipment is not accepted there yet): only in the warehouse cabinet;
 *   connection_type_unsupported  — no documented cancel for this connection type.
 */
export function warehouseCancelRefusal(f: CancelShipmentLike, now: Date = new Date()): string | null {
  if (f.label || f.connectionType === "FHB_JOY") return "label";
  return cancelRefusal(f, f.connectionType, now);
}

/** The outbox write that cancels one shipment, marked as a warehouse cancel (CRM-only context, never sent). */
function cancelWrite(
  f: { id: string; externalId: string },
  type: ConnectionType,
  ctx: { requestedById: string; reasonCode: string; reasonText: string | null },
) {
  const mark: Record<string, string> = {
    [WAREHOUSE_CANCEL_MARK]: "1",
    requestedById: ctx.requestedById,
    reasonCode: ctx.reasonCode,
    ...(ctx.reasonText ? { reasonText: ctx.reasonText } : {}),
  };
  if (type === "FHB_V3")
    return {
      operation: "fhb.order.delete",
      idempotencyKey: `fhb.order.delete:${f.externalId}`,
      payload: { id: f.externalId, meta: mark },
    };
  return {
    operation: EU_OPS.deleteOrder,
    idempotencyKey: `delete:${f.externalId}`,
    payload: { body: {}, ctx: { fulfillmentId: f.id, referenceNumber: f.externalId, ...mark } },
  };
}

const activeShipmentsOf = (db: Tx, orderId: string) =>
  db.fulfillment.findMany({
    where: { orderId, status: { notIn: [...INACTIVE_SHIPMENT] } },
    orderBy: { createdAt: "asc" },
    include: {
      connection: { select: { id: true, name: true, type: true, liveMode: true } },
      manualShipment: { select: { id: true } },
    },
  });

const shipmentLike = (f: Awaited<ReturnType<typeof activeShipmentsOf>>[number]): CancelShipmentLike => ({
  status: f.status,
  rawStatus: f.rawStatus,
  submittedAt: f.submittedAt,
  createdAt: f.createdAt,
  connectionType: f.connection.type,
  label: !!f.manualShipment,
});

export interface WarehouseCancelRow {
  fulfillmentId: string;
  externalId: string;
  connectionName: string;
  connectionType: ConnectionType;
  liveMode: LiveMode;
  /** null = the button may be offered (still subject to the role). */
  refusal: string | null;
  manualShipmentId: string | null;
  request: {
    id: string;
    status: OutboundStatus;
    lastError: string | null;
    confirmedAt: Date | null;
    updatedAt: Date;
  } | null;
}

/** Everything the "Пратки" card needs for "Откажи в склада" (reads only). */
export async function warehouseCancelView(actor: ScopedActor, orderId: string, now = new Date()) {
  const order = await scopedOrderForChoice(actor, orderId);
  const db = accountDb(actor.accountId);
  const [active, openReroute] = await Promise.all([
    withAccountTransaction(actor.accountId, (tx) => activeShipmentsOf(tx, order.id)),
    db.orderReroute.count({ where: { orderId: order.id, status: "CANCEL_QUEUED" } }),
  ]);
  const requests = active.length
    ? await db.outboundRequest.findMany({
        where: { fulfillmentId: { in: active.map((f) => f.id) }, operation: { in: [...CANCEL_OPERATIONS] } },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          fulfillmentId: true,
          status: true,
          lastError: true,
          confirmedAt: true,
          updatedAt: true,
        },
      })
    : [];
  const rows: WarehouseCancelRow[] = active.map((f) => {
    const req = requests.find((r) => r.fulfillmentId === f.id) ?? null;
    const refusal =
      (openReroute ? "reroute_open" : null) ??
      warehouseCancelRefusal(shipmentLike(f), now) ??
      (req && IN_FLIGHT.includes(req.status) ? "already_requested" : null);
    return {
      fulfillmentId: f.id,
      externalId: f.externalId,
      connectionName: f.connection.name,
      connectionType: f.connection.type,
      liveMode: f.connection.liveMode,
      refusal,
      manualShipmentId: f.manualShipment?.id ?? null,
      request: req
        ? {
            id: req.id,
            status: req.status,
            lastError: req.lastError,
            confirmedAt: req.confirmedAt,
            updatedAt: req.updatedAt,
          }
        : null,
    };
  });
  return { canCancel: can(actor.role, "orders.cancelShipment"), rows };
}

/** Queues the cancel of one active shipment at its warehouse (see the module comment). */
export async function requestWarehouseCancel(
  actor: ScopedActor,
  raw: WarehouseCancelInput,
  now = new Date(),
) {
  assertCan(actor.role, "orders.cancelShipment");
  const input = WarehouseCancelInput.parse(raw);
  const reason = await assertWarehouseReason(actor.accountId, input.reasonCode, input.reasonText);
  const head = await accountDb(actor.accountId).fulfillment.findUnique({
    where: { id: input.fulfillmentId },
    select: { orderId: true },
  });
  if (!head) throw new DomainError("not_found");
  const order = await scopedOrderForChoice(actor, head.orderId); // company scope: not_found outside it

  const run = () =>
    withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
      // Order row lock: serialises with a reroute request, Fulfill, a second click and the worker's confirmation.
      await lockForUpdate("Order", order.id);
      const f = (await activeShipmentsOf(tx, order.id)).find((x) => x.id === input.fulfillmentId);
      if (!f) throw new DomainError("no_active_shipment");
      if (await tx.orderReroute.count({ where: { orderId: order.id, status: "CANCEL_QUEUED" } }))
        throw new DomainError("reroute_open");
      const refusal = warehouseCancelRefusal(shipmentLike(f), now);
      if (refusal) throw new DomainError(refusal === "label" ? "label_shipment" : "not_cancellable");
      const write = cancelWrite(f, f.connection.type, {
        requestedById: actor.userId,
        reasonCode: reason.reasonCode,
        reasonText: reason.reasonText,
      });
      const { request, created } = await enqueueOutboundInTx(tx, {
        accountId: actor.accountId,
        connectionId: f.connectionId,
        operation: write.operation,
        idempotencyKey: write.idempotencyKey,
        payload: json(write.payload),
        fulfillmentId: f.id,
        createdById: actor.userId,
      });
      // The same cancel is already on its way (double click, another person, an earlier request): nothing new.
      if (!created)
        throw new DomainError(request.status === "UNCERTAIN" ? "cancel_uncertain" : "already_requested");
      const fresh = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
      const reasonLine = [reason.reasonCode, reason.reasonText].filter(Boolean).join(": ");
      const meta = {
        fulfillmentId: f.id,
        externalId: f.externalId,
        connectionId: f.connectionId,
        connectionName: f.connection.name,
        cancelRequestId: request.id,
        mode: f.connection.liveMode,
      };
      await recordTimelineEvent(tx, {
        accountId: actor.accountId,
        orderId: order.id,
        status: fresh.status,
        cause: "warehouse_cancel_requested",
        userId: actor.userId,
        reason: reasonLine,
        meta,
        source: "override.warehouse_cancel",
      });
      await tx.auditLog.create({
        data: {
          accountId: actor.accountId,
          userId: actor.userId,
          action: "order.warehouse_cancel_requested",
          entityType: "Fulfillment",
          entityId: f.id,
          after: json({ ...meta, orderId: order.id, ...reason }),
          ip: actor.ip ?? null,
          userAgent: actor.userAgent?.slice(0, 300) ?? null,
        },
      });
      return { requestId: request.id, mode: f.connection.liveMode as LiveMode, fulfillmentId: f.id };
    });
  try {
    return await run();
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError("already_requested");
    throw err;
  }
}
