import { z } from "zod";
import type { ConnectionType, LiveMode, OutboundStatus, Prisma } from "@/generated/prisma/client";
import { EU_OPS } from "@/integrations/eushipments/adapter";
import { isFhbOrderEditable } from "@/integrations/fhb-v3/status-map";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import { DomainError } from "@/server/accounts";
import { assertCan, can } from "@/server/auth/rbac";
import { validateOrder, type Finding } from "@/server/checks";
import { accountDb, isUniqueViolation, systemDb, withAccountTransaction } from "@/server/db/client";
import { isEuOrderDeletable } from "@/server/eushipments/write";
import { enqueueOutboundInTx } from "@/server/outbox/outbox";
import type { TransportResolver } from "@/server/outbox/transport";
import { followShipment, isAllowed, transition } from "@/server/pipeline";
import type { ScopedActor } from "@/server/stores";
import { CANCEL_IN_FLIGHT, CANCEL_OPERATIONS } from "./cancel-effects";
import { invalidateCheck, recordTimelineEvent } from "./choice";
import { INACTIVE_SHIPMENT, isRerouteOpen } from "./guards";
import { eligibleConnections, scopedOrderForChoice, warehouseOptions, type WarehouseOption } from "./options";
import { assertWarehouseReason } from "./reasons";

/**
 * "Пренасочи към друг склад" — after sending (P4-09). OWNER/ADMIN only (orders.reroute), and only while the shipment
 * can still be cancelled at the vendor (FHB: DELETE /order only while raw status is `pending`; euShipments: delete
 * only in New / Information received / Awaiting pickup and within 14 days — INTEGRATION_NOTES §2.4, §4.3).
 *
 *   requestReroute()  — validates the new warehouse, then queues the cancel of the old shipment THROUGH THE OUTBOX
 *                       (the sender applies the connection's liveMode gate) and records an open OrderReroute;
 *   processReroute()  — worker: follows the cancel request. Only when it was SENT and a read-back at the old
 *                       warehouse confirms the shipment is gone, in ONE transaction with the order row locked: the
 *                       old Fulfillment → CANCELLED, the order → APPROVED (pipeline cause "reroute") bound to the new
 *                       connection (OrderWarehouseChoice via "reroute" + OrderCheck.connectionId). The normal Fulfill
 *                       then sends it. Refused / failed / uncertain / unconfirmed: NOTHING else changes, an operator
 *                       task is opened. DRY_RUN / READ_ONLY: the flow only records what would happen.
 * Never two active shipments: the database refuses a second active Fulfillment per order and a second open reroute
 * per order (triggers, see the migration); the old shipment's late vendor statuses never move the order again
 * (pipeline isSupersededShipment), and while a reroute is open the order follows only the reroute (isRerouteOwnedShipment).
 */

type Tx = Prisma.TransactionClient;
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

export type RerouteStatus = "CANCEL_QUEUED" | "DONE" | "REFUSED" | "UNCERTAIN" | "SIMULATED";

/** Read-backs that may come back "still there" before the reroute is declared uncertain (one per sweep minute). */
export const MAX_READBACKS = 10;
/** A cancel waiting this long for a person (CANARY confirmation / paused connection) opens a reminder task. */
export const WAITING_REMINDER_MS = 4 * 3600_000;
/** Outbox states in which the cancel is still on its way (the reroute waits). */
const WAITING: readonly OutboundStatus[] = ["PENDING", "PAUSED", "AWAITING_CONFIRMATION", "HELD", "SENDING"];

export const RerouteInput = z.object({
  orderId: z.string().min(1).max(64),
  toConnectionId: z.string().min(1).max(64),
  reasonCode: z.string().trim().max(40).nullable().optional(),
  reasonText: z.string().max(1000).nullable().optional(),
});
export type RerouteInput = z.input<typeof RerouteInput>;

export class RerouteBlockedError extends DomainError {
  constructor(public readonly findings: Finding[]) {
    super("reroute_hard_findings", "the new warehouse has blocking findings");
    this.name = "RerouteBlockedError";
  }
}

interface ShipmentLike {
  status: string;
  rawStatus: string | null;
  submittedAt: Date | null;
  createdAt: Date;
}

/** Why the shipment cannot be cancelled at its warehouse any more (null = it can). */
export function cancelRefusal(f: ShipmentLike, type: ConnectionType, now: Date): string | null {
  if (f.status !== "ACCEPTED") return "not_at_warehouse_yet_or_locked";
  if (type === "FHB_V3") return isFhbOrderEditable(f.rawStatus) ? null : "fhb_not_pending";
  if (type === "EUSHIPMENTS") return isEuOrderDeletable(f, now) ? null : "eushipments_not_deletable";
  return "connection_type_unsupported";
}

/** The outbox write that cancels one shipment — the same keys the existing "cancel at warehouse" actions use. */
function cancelWrite(f: { id: string; externalId: string }, type: ConnectionType, rerouteId: string) {
  if (type === "FHB_V3")
    return {
      operation: "fhb.order.delete",
      idempotencyKey: `fhb.order.delete:${f.externalId}`,
      payload: { id: f.externalId, meta: { rerouteId } },
    };
  return {
    operation: EU_OPS.deleteOrder,
    idempotencyKey: `delete:${f.externalId}`,
    payload: { body: {}, ctx: { fulfillmentId: f.id, referenceNumber: f.externalId, rerouteId } },
  };
}

/**
 * Why a target warehouse cannot take this order again (null = it can). euShipments references are per order
 * ({STORE}-{number}) and the same at every connection; the pre-send orders-history check is token-scoped (not per
 * companyId) and refuses a reference that a deleted/cancelled shipment already used. So an euShipments target is
 * refused when the order already had a shipment at that connection or at any euShipments connection sharing its
 * credential: the reroute would cancel the old shipment for good and the new one could never be created.
 * FHB targets get a fresh `-N` id across all FHB connections (fhb/orders nextFhbExternalId), so they are fine.
 */
export async function targetReuseRefusal(
  accountId: string,
  orderId: string,
  target: { id: string; type: ConnectionType; credentialId: string | null },
): Promise<string | null> {
  if (target.type !== "EUSHIPMENTS") return null;
  const used = await accountDb(accountId).fulfillment.count({
    where: {
      orderId,
      OR: [
        { connectionId: target.id },
        ...(target.credentialId
          ? [{ connection: { type: "EUSHIPMENTS" as const, credentialId: target.credentialId } }]
          : []),
      ],
    },
  });
  return used ? "reroute_target_used" : null;
}

const activeShipments = (tx: Tx, orderId: string) =>
  tx.fulfillment.findMany({
    where: { orderId, status: { notIn: [...INACTIVE_SHIPMENT] } },
    include: { connection: { select: { id: true, name: true, type: true, liveMode: true } } },
  });

/** Everything the order page needs for "Пренасочи" (reads only). */
export async function rerouteView(actor: ScopedActor, orderId: string, now = new Date()) {
  const order = await scopedOrderForChoice(actor, orderId);
  const db = accountDb(actor.accountId);
  const [active, history] = await Promise.all([
    db.fulfillment.findMany({
      where: { orderId, status: { notIn: [...INACTIVE_SHIPMENT] } },
      include: { connection: { select: { id: true, name: true, type: true, liveMode: true } } },
    }),
    db.orderReroute.findMany({
      where: { orderId },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { toConnection: { select: { name: true, type: true } } },
    }),
  ]);
  const requestIds = history.map((h) => h.cancelRequestId).filter((x): x is string => !!x);
  const requests = requestIds.length
    ? await db.outboundRequest.findMany({
        where: { id: { in: requestIds } },
        select: { id: true, status: true, confirmedAt: true, lastError: true },
      })
    : [];
  const shipment = active.length === 1 ? active[0]! : null;
  // A cancel already on its way for this shipment that no reroute owns ("Откажи в склада"): no reroute on top.
  const ownedIds = new Set(requestIds);
  const cancelInFlight = shipment
    ? (
        await db.outboundRequest.findMany({
          where: {
            fulfillmentId: shipment.id,
            operation: { in: [...CANCEL_OPERATIONS] },
            status: { in: [...CANCEL_IN_FLIGHT] },
          },
          select: { id: true },
        })
      ).some((r) => !ownedIds.has(r.id))
    : false;
  const refusal = shipment
    ? (cancelRefusal(shipment, shipment.connection.type, now) ??
      (cancelInFlight ? "cancel_requested" : null) ??
      (isAllowed("reroute", order.status, "APPROVED", "system") ? null : "order_status"))
    : active.length > 1
      ? "several_active_shipments"
      : "no_active_shipment";
  const open = history.find((h) => h.status === "CANCEL_QUEUED") ?? null;
  const allowedRole = can(actor.role, "orders.reroute");
  const targets: WarehouseOption[] = [];
  if (allowedRole && shipment && !refusal && !open) {
    const options = (await warehouseOptions(actor, orderId)).filter((c) => c.id !== shipment.connectionId);
    const creds = await db.fulfillmentConnection.findMany({
      where: { id: { in: options.map((c) => c.id) } },
      select: { id: true, credentialId: true },
    });
    const credOf = new Map(creds.map((c) => [c.id, c.credentialId]));
    for (const c of options)
      if (
        !(await targetReuseRefusal(actor.accountId, orderId, {
          id: c.id,
          type: c.type as ConnectionType,
          credentialId: credOf.get(c.id) ?? null,
        }))
      )
        targets.push(c);
  }
  return {
    orderStatus: order.status,
    canReroute: allowedRole,
    shipment: shipment
      ? {
          id: shipment.id,
          externalId: shipment.externalId,
          connectionId: shipment.connectionId,
          connectionName: shipment.connection.name,
          connectionType: shipment.connection.type,
          liveMode: shipment.connection.liveMode,
          status: shipment.status,
          rawStatus: shipment.rawStatus,
        }
      : null,
    refusal,
    targets,
    open: open ? { ...open, request: requests.find((r) => r.id === open.cancelRequestId) ?? null } : null,
    history: history.map((h) => ({
      ...h,
      request: requests.find((r) => r.id === h.cancelRequestId) ?? null,
    })),
  };
}

/** Queues the cancel of the current shipment so the order can go to another warehouse (see the module comment). */
export async function requestReroute(actor: ScopedActor, raw: RerouteInput, now = new Date()) {
  assertCan(actor.role, "orders.reroute");
  const input = RerouteInput.parse(raw);
  const reason = await assertWarehouseReason(actor.accountId, input.reasonCode, input.reasonText);
  const order = await scopedOrderForChoice(actor, input.orderId);
  const db = accountDb(actor.accountId);

  // 1. The current shipment must still be cancellable, the target eligible and clean.
  const active = await db.fulfillment.findMany({
    where: { orderId: order.id, status: { notIn: [...INACTIVE_SHIPMENT] } },
    include: { connection: { select: { type: true } } },
  });
  if (active.length === 0) throw new DomainError("no_active_shipment");
  if (active.length > 1) throw new DomainError("several_active_shipments");
  const current = active[0]!;
  if (cancelRefusal(current, current.connection.type, now)) throw new DomainError("not_cancellable");
  if (current.connectionId === input.toConnectionId) throw new DomainError("same_connection");
  const eligible = await eligibleConnections(actor.accountId, {
    companyId: order.companyId,
    lineId: order.company?.lineId ?? null,
  });
  const target = eligible.find((c) => c.id === input.toConnectionId);
  if (!target) throw new DomainError("connection_not_eligible");
  const targetRow = await db.fulfillmentConnection.findUniqueOrThrow({
    where: { id: target.id },
    select: { id: true, type: true, credentialId: true },
  });
  const reuse = await targetReuseRefusal(actor.accountId, order.id, targetRow);
  if (reuse) throw new DomainError(reuse);
  const preview = await validateOrder(actor.accountId, order.id, {
    connectionId: target.id,
    persist: false,
    now,
  });
  const hard = preview.findings.filter((f) => f.severity === "hard");
  if (hard.length) throw new RerouteBlockedError(hard);

  // 2. Record the reroute and queue the cancel together (order row locked: serialises with Fulfill, checks,
  //    another reroute and the worker's confirmation).
  const reasonLine = [reason.reasonCode, reason.reasonText].filter(Boolean).join(": ");
  try {
    return await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
      await lockForUpdate("Order", order.id);
      const [f] = await activeShipments(tx, order.id).then((xs) => (xs.length === 1 ? xs : [null]));
      if (!f || f.id !== current.id) throw new DomainError("shipment_changed");
      if (cancelRefusal(f, f.connection.type, now)) throw new DomainError("not_cancellable");
      // The order must be able to return to APPROVED once the cancel is confirmed — checked BEFORE the
      // irreversible cancel is queued (re-read under the lock).
      const fresh = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
      if (!isAllowed("reroute", fresh.status, "APPROVED", "system"))
        throw new DomainError("reroute_not_allowed");
      const open = await tx.orderReroute.count({ where: { orderId: order.id, status: "CANCEL_QUEUED" } });
      if (open) throw new DomainError("reroute_open");
      const reroute = await tx.orderReroute.create({
        data: {
          accountId: actor.accountId,
          orderId: order.id,
          fromFulfillmentId: f.id,
          fromConnectionId: f.connectionId,
          toConnectionId: target.id,
          reasonCode: reason.reasonCode,
          reasonText: reason.reasonText,
          requestedById: actor.userId,
          outcome: json({ requestedMode: f.connection.liveMode }),
        },
      });
      // A cancel of this shipment already on its way ("Откажи в склада" by someone else): never take it over —
      // its intent (stop the order, BLOCKED) must not silently become a reroute.
      const inFlight = await tx.outboundRequest.findFirst({
        where: {
          accountId: actor.accountId,
          fulfillmentId: f.id,
          operation: { in: [...CANCEL_OPERATIONS] },
          status: { in: [...CANCEL_IN_FLIGHT] },
        },
        select: { status: true },
      });
      if (inFlight)
        throw new DomainError(inFlight.status === "UNCERTAIN" ? "cancel_uncertain" : "cancel_requested");
      const write = cancelWrite(f, f.connection.type, reroute.id);
      const { request, created } = await enqueueOutboundInTx(tx, {
        accountId: actor.accountId,
        connectionId: f.connectionId,
        operation: write.operation,
        idempotencyKey: write.idempotencyKey,
        payload: json(write.payload),
        fulfillmentId: f.id,
        createdById: actor.userId,
      });
      // An earlier cancel of this shipment whose outcome is unknown must be resolved by a person first.
      if (request.status === "UNCERTAIN") throw new DomainError("cancel_uncertain");
      // Never attach to a row someone else owns (belt and braces for the check above).
      if (!created) throw new DomainError("cancel_requested");
      await tx.orderReroute.update({ where: { id: reroute.id }, data: { cancelRequestId: request.id } });
      const meta = {
        rerouteId: reroute.id,
        fromConnectionId: f.connectionId,
        fromConnectionName: f.connection.name,
        toConnectionId: target.id,
        toConnectionName: target.name,
        cancelRequestId: request.id,
        mode: f.connection.liveMode,
      };
      await recordTimelineEvent(tx, {
        accountId: actor.accountId,
        orderId: order.id,
        status: order.status,
        cause: "reroute_requested",
        userId: actor.userId,
        reason: reasonLine,
        meta,
        source: "override.reroute",
      });
      await tx.review.create({
        data: {
          accountId: actor.accountId,
          orderId: order.id,
          reviewerId: actor.userId,
          decision: "REROUTE",
          reasonCode: reason.reasonCode,
          reasonText: reason.reasonText,
          findings: json(preview.findings),
          diff: [],
          decidedAt: now,
        },
      });
      await tx.auditLog.create({
        data: {
          accountId: actor.accountId,
          userId: actor.userId,
          action: "order.reroute_requested",
          entityType: "Order",
          entityId: order.id,
          after: json({ ...meta, reasonCode: reason.reasonCode, reasonText: reason.reasonText }),
          ip: actor.ip ?? null,
          userAgent: actor.userAgent?.slice(0, 300) ?? null,
        },
      });
      return { rerouteId: reroute.id, requestId: request.id, mode: f.connection.liveMode as LiveMode };
    });
  } catch (err) {
    if (isRerouteOpen(err) || isUniqueViolation(err)) throw new DomainError("reroute_open");
    throw err;
  }
}

// ───────────────────────── worker side ─────────────────────────

type RerouteRow = NonNullable<Awaited<ReturnType<typeof loadReroute>>>;

function loadReroute(accountId: string, rerouteId: string) {
  return accountDb(accountId).orderReroute.findUnique({
    where: { id: rerouteId },
    include: {
      order: { select: { number: true } },
      toConnection: { select: { name: true } },
      fromFulfillment: { select: { externalId: true, connection: { select: { name: true, type: true } } } },
    },
  });
}

async function openTask(
  tx: Tx,
  r: RerouteRow,
  kind: string,
  severity: "WARNING" | "CRITICAL",
  title: string,
  body: string,
) {
  const a = await tx.alert.create({
    data: {
      accountId: r.accountId,
      kind,
      isTask: true,
      severity,
      title: title.slice(0, 300),
      body: scrubText(body, 2000),
      entityType: "Order",
      entityId: r.orderId,
    },
    select: { id: true },
  });
  return a.id;
}

/** Ends an open reroute without touching the order or the shipment (refused / uncertain / simulated). */
async function finishWithout(
  r: RerouteRow,
  status: Exclude<RerouteStatus, "CANCEL_QUEUED" | "DONE">,
  outcome: Record<string, unknown>,
  task: { kind: string; severity: "WARNING" | "CRITICAL"; title: string; body: string } | null,
  now: Date,
) {
  return withAccountTransaction(r.accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("Order", r.orderId);
    const moved = await tx.orderReroute.updateMany({
      where: { id: r.id, status: "CANCEL_QUEUED" },
      data: { status, finishedAt: now, outcome: json({ ...(r.outcome as object), ...outcome }) },
    });
    if (moved.count !== 1) return "skipped" as const;
    const alertId = task ? await openTask(tx, r, task.kind, task.severity, task.title, task.body) : null;
    if (alertId) await tx.orderReroute.update({ where: { id: r.id }, data: { alertId } });
    if (status === "REFUSED") {
      // The cancel did not happen: the order follows its (still live) shipment again. Vendor statuses that
      // arrived while the reroute was open were recorded on the shipment only (pipeline isRerouteOwnedShipment).
      const f = await tx.fulfillment.findUnique({
        where: { id: r.fromFulfillmentId },
        select: { status: true },
      });
      if (f && !(INACTIVE_SHIPMENT as readonly string[]).includes(f.status))
        await followShipment(tx, r.orderId, f.status, "override.reroute", {
          fulfillmentId: r.fromFulfillmentId,
        });
    }
    const o = await tx.order.findUniqueOrThrow({ where: { id: r.orderId }, select: { status: true } });
    await recordTimelineEvent(tx, {
      accountId: r.accountId,
      orderId: r.orderId,
      status: o.status,
      cause: `reroute_${status.toLowerCase()}`,
      userId: null,
      actorType: "system",
      reason: typeof outcome.detail === "string" ? outcome.detail : null,
      meta: { rerouteId: r.id, ...outcome },
      source: "override.reroute",
    });
    await tx.auditLog.create({
      data: {
        accountId: r.accountId,
        userId: null,
        action: `order.reroute_${status.toLowerCase()}`,
        entityType: "Order",
        entityId: r.orderId,
        after: json({ rerouteId: r.id, ...outcome }),
      },
    });
    return status;
  });
}

/** The old warehouse confirmed the cancellation: switch the order to the new warehouse (one transaction). */
async function complete(r: RerouteRow, confirmation: unknown, now: Date) {
  const done = await withAccountTransaction(r.accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("Order", r.orderId);
    const moved = await tx.orderReroute.updateMany({
      where: { id: r.id, status: "CANCEL_QUEUED" },
      data: {
        status: "DONE",
        finishedAt: now,
        outcome: json({ ...(r.outcome as object), confirmedAt: now.toISOString(), confirmation }),
      },
    });
    if (moved.count !== 1) return null;
    const f = await tx.fulfillment.findUniqueOrThrow({ where: { id: r.fromFulfillmentId } });
    if (f.status !== "CANCELLED") {
      await tx.fulfillment.update({ where: { id: f.id }, data: { status: "CANCELLED" } });
      await tx.fulfillmentEvent.create({
        data: {
          accountId: r.accountId,
          fulfillmentId: f.id,
          occurredAt: now,
          source: "override.reroute",
          rawStatus: f.rawStatus,
          status: "CANCELLED",
          payload: json({ rerouteId: r.id, cancelConfirmed: true }),
        },
      });
    }
    const choice = {
      connectionId: r.toConnectionId,
      via: "reroute",
      reasonCode: r.reasonCode,
      reasonText: r.reasonText,
      chosenById: r.requestedById,
      rerouteId: r.id,
    };
    const existing = await tx.orderWarehouseChoice.findFirst({ where: { orderId: r.orderId } });
    if (existing) await tx.orderWarehouseChoice.update({ where: { id: existing.id }, data: choice });
    else
      await tx.orderWarehouseChoice.create({
        data: { accountId: r.accountId, orderId: r.orderId, ...choice },
      });
    await invalidateCheck(tx, r.orderId, r.toConnectionId);
    const t = await transition(tx, {
      orderId: r.orderId,
      to: "APPROVED",
      cause: "reroute",
      actor: { kind: "system" },
      source: "override.reroute",
      reason: [r.reasonCode, r.reasonText].filter(Boolean).join(": "),
      mode: "follow",
      meta: {
        rerouteId: r.id,
        fromConnectionId: r.fromConnectionId,
        connectionId: r.toConnectionId,
        requestedById: r.requestedById,
      },
    });
    if (!t.changed)
      await openTask(
        tx,
        r,
        "reroute_not_approved",
        "CRITICAL",
        `Order ${r.order.number}: cancelled at ${r.fromFulfillment.connection.name}, but it could not return to APPROVED`,
        `The old shipment ${r.fromFulfillment.externalId} is cancelled at the warehouse. The order is in status ` +
          `${t.from ?? "?"} (${t.reason}${t.guard ? `: ${t.guard}` : ""}) and was not moved: handle it by hand.`,
      );
    await tx.auditLog.create({
      data: {
        accountId: r.accountId,
        userId: null,
        action: "order.reroute_done",
        entityType: "Order",
        entityId: r.orderId,
        after: json({
          rerouteId: r.id,
          fromFulfillmentId: r.fromFulfillmentId,
          toConnectionId: r.toConnectionId,
          approved: t.changed,
          requestedById: r.requestedById,
        }),
      },
    });
    return { approved: t.changed };
  });
  if (!done) return "skipped" as const;
  // The check for the new warehouse (the choice now points there). Fulfill re-validates before sending anyway.
  try {
    const check = await validateOrder(r.accountId, r.orderId, { now });
    if (check.hardCount > 0)
      await withAccountTransaction(r.accountId, (tx) =>
        openTask(
          tx,
          r,
          "reroute_check_failed",
          "WARNING",
          `Order ${r.order.number}: rerouted to ${r.toConnection.name}, but the new warehouse has blocking findings`,
          check.findings
            .filter((x) => x.severity === "hard")
            .map((x) => `${x.code}: ${x.message_en}`)
            .join("\n"),
        ),
      );
  } catch (err) {
    logger.error({ rerouteId: r.id, err: (err as Error).message }, "reroute check failed");
  }
  return "DONE" as const;
}

/**
 * Follows one open reroute (worker; safe to run concurrently and repeatedly): waits while the cancel is on its way,
 * ends it without changes when the cancel was not done for real, and switches the order only after a read-back
 * at the old warehouse confirmed the cancellation.
 */
export async function processReroute(
  accountId: string,
  rerouteId: string,
  resolveTransport: TransportResolver,
  now: Date = new Date(),
): Promise<RerouteStatus | "waiting" | "skipped"> {
  const r = await loadReroute(accountId, rerouteId);
  if (!r || r.status !== "CANCEL_QUEUED") return "skipped";
  const req = r.cancelRequestId
    ? await accountDb(accountId).outboundRequest.findUnique({ where: { id: r.cancelRequestId } })
    : null;
  const where = `${r.fromFulfillment.connection.name} (${r.fromFulfillment.externalId})`;
  const target = r.toConnection.name;
  if (!req)
    return finishWithout(
      r,
      "REFUSED",
      { detail: "cancel_request_missing" },
      {
        kind: "reroute_refused",
        severity: "WARNING",
        title: `Order ${r.order.number}: reroute to ${target} stopped — the cancel request is missing`,
        body: `Nothing was changed. Check ${where} by hand.`,
      },
      now,
    );
  if (WAITING.includes(req.status)) {
    // A cancel that waits for a person (CANARY confirmation, paused connection) blocks every other reroute of
    // the order: remind once.
    if (
      !r.alertId &&
      (req.status === "AWAITING_CONFIRMATION" || req.status === "PAUSED") &&
      now.getTime() - r.createdAt.getTime() >= WAITING_REMINDER_MS
    )
      await withAccountTransaction(accountId, async (tx, { lockForUpdate }) => {
        await lockForUpdate("Order", r.orderId);
        const still = await tx.orderReroute.findFirst({
          where: { id: r.id, status: "CANCEL_QUEUED", alertId: null },
          select: { id: true },
        });
        if (!still) return;
        const alertId = await openTask(
          tx,
          r,
          "reroute_waiting",
          "WARNING",
          `Order ${r.order.number}: the cancel for the reroute to ${target} is waiting`,
          req.status === "AWAITING_CONFIRMATION"
            ? `The cancel of ${where} waits for a CANARY confirmation (Outbox → Confirm). Until it is confirmed ` +
                `or refused the order cannot be rerouted again; nothing has been sent yet.`
            : `The cancel of ${where} is paused (the connection is paused). Until it is sent or refused the order ` +
                `cannot be rerouted again; nothing has been sent yet.`,
        );
        await tx.orderReroute.update({ where: { id: r.id }, data: { alertId } });
      });
    return "waiting";
  }
  if (req.status === "DRY_RUN_RECORDED" || (req.status === "REFUSED" && req.lastError === "read_only"))
    return finishWithout(
      r,
      "SIMULATED",
      {
        mode: req.status === "DRY_RUN_RECORDED" ? "DRY_RUN" : "READ_ONLY",
        detail: "simulated",
        wouldCancel: { fulfillmentId: r.fromFulfillmentId, at: where, operation: req.operation },
        wouldApproveFor: { connectionId: r.toConnectionId, name: target },
      },
      null,
      now,
    );
  if (req.status === "REFUSED" || req.status === "FAILED")
    return finishWithout(
      r,
      "REFUSED",
      { detail: req.lastError ?? req.status.toLowerCase(), requestStatus: req.status },
      {
        kind: "reroute_refused",
        severity: "WARNING",
        title: `Order ${r.order.number}: ${r.fromFulfillment.connection.name} did not cancel the shipment — not rerouted`,
        body:
          `The cancel of ${where} was ${req.status === "FAILED" ? "refused by the warehouse" : "not sent"}` +
          `${req.lastError ? ` (${req.lastError})` : ""}. The order stays at the old warehouse; nothing was changed.`,
      },
      now,
    );
  /** What the CRM itself now records for the old shipment (an accepted delete already marks it CANCELLED). */
  const shipmentState = async () => {
    const f = await accountDb(accountId).fulfillment.findUnique({
      where: { id: r.fromFulfillmentId },
      select: { status: true },
    });
    const st = f?.status ?? "?";
    return st === "CANCELLED"
      ? ` The CRM already marks the old shipment CANCELLED (the warehouse answered the delete), so the order ` +
          `has no active shipment now: confirm at the warehouse, then send it again by hand.`
      : ` The CRM still marks the old shipment ${st}.`;
  };
  if (req.status === "UNCERTAIN")
    return finishWithout(
      r,
      "UNCERTAIN",
      { detail: "cancel_outcome_unknown", requestStatus: req.status },
      {
        kind: "reroute_uncertain",
        severity: "CRITICAL",
        title: `Order ${r.order.number}: unknown whether ${r.fromFulfillment.connection.name} cancelled the shipment`,
        body:
          `Check ${where} at the warehouse before doing anything. The order was NOT moved to ${target}.` +
          (await shipmentState()),
      },
      now,
    );

  // SENT: confirm by reading back at the old warehouse before anything changes.
  if (r.readBackAttempts > 0 && now.getTime() - r.updatedAt.getTime() < 50_000) return "waiting";
  const transport = resolveTransport({ id: req.connectionId, type: r.fromFulfillment.connection.type });
  let confirmed = false;
  let response: unknown = null;
  let detail = "no_read_back";
  if (transport?.readBack) {
    try {
      const rb = await transport.readBack({
        operation: req.operation,
        idempotencyKey: req.idempotencyKey,
        payload: req.payload,
        testMode: false,
        vendorAnswered: true, // req is SENT: the old warehouse answered the cancel
      });
      confirmed = rb.found;
      response = rb.response ?? null;
      detail = rb.found ? "confirmed" : "still_at_warehouse";
    } catch (err) {
      detail = scrubText(`read_back_failed: ${(err as Error).message}`, 300);
    }
  }
  if (confirmed) return complete(r, response, now);
  const attempts = r.readBackAttempts + 1;
  if (attempts >= MAX_READBACKS)
    return finishWithout(
      r,
      "UNCERTAIN",
      { detail, readBackAttempts: attempts },
      {
        kind: "reroute_uncertain",
        severity: "CRITICAL",
        title: `Order ${r.order.number}: ${r.fromFulfillment.connection.name} did not confirm the cancellation`,
        body:
          `The cancel of ${where} was sent, but ${attempts} read-backs did not show it cancelled (${detail}). ` +
          `The order was NOT moved to ${target}. Check it at the warehouse.` +
          (await shipmentState()),
      },
      now,
    );
  await accountDb(accountId).orderReroute.updateMany({
    where: { id: r.id, status: "CANCEL_QUEUED" },
    data: { readBackAttempts: attempts, outcome: json({ ...(r.outcome as object), lastReadBack: detail }) },
  });
  return "waiting";
}

/** Every open reroute of every account (worker sweep, once a minute). */
export async function sweepReroutes(resolveTransport: TransportResolver, now = new Date(), limit = 100) {
  const open = await systemDb().orderReroute.findMany({
    where: { status: "CANCEL_QUEUED" },
    select: { id: true, accountId: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  const out: { id: string; result: string }[] = [];
  for (const o of open) {
    try {
      out.push({ id: o.id, result: await processReroute(o.accountId, o.id, resolveTransport, now) });
    } catch (err) {
      logger.error({ rerouteId: o.id, err: (err as Error).message }, "reroute processing failed");
      out.push({ id: o.id, result: "error" });
    }
  }
  return out;
}
