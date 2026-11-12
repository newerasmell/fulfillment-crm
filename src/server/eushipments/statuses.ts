import type { AlertSeverity, CrmOrderStatus, Prisma } from "@/generated/prisma/client";
import type { HistoryItem, StatusRecord } from "@/integrations/eushipments/schemas";
import {
  alertFor,
  CANCELED_DELETED,
  CRM_STATUS,
  isStuckAccepted,
  normaliseStatusText,
  parseVendorDate,
  resolveStatus,
  SEED_STATUSES,
  stopsPolling,
  type EuAlertKind,
  type EuStatusCategory,
  type StatusRule,
} from "@/integrations/eushipments/status-map";
import { scrubText } from "@/lib/scrub";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { CANCEL_OPERATIONS, crmCancelLeft, warehouseCancelConfirmed } from "@/server/override/cancel-effects";
import { followShipment, isSupersededShipment, transition, VENDOR_FROM } from "@/server/pipeline";

/**
 * euShipments status tracking on the CRM side (P3-03): the per-group mapping table, applying an
 * orders-history answer to one Fulfillment (events, status, alerts) and the "stuck in Information received"
 * check. Polling itself (batches of 100 every 15 min) is the read-side job (P3-02) and calls into here.
 */

export const EU_EVENT_SOURCE = "eushipments";

/**
 * The Order follows its shipment along SPEC §6.1, forward only: each target lists the Order statuses it may
 * come from, so a late or repeated vendor status never moves an Order back (e.g. DELIVERED → SHIPPED), and
 * operator states (ON_HOLD, CANCELLED in the CRM) are never overwritten. Targets not listed leave it alone.
 * The table now lives in the pipeline state machine (src/server/pipeline/rules.ts); re-exported here.
 */
export const ORDER_FROM = VENDOR_FROM;

/** Moves the Order to its shipment's status when that is a forward step (pipeline "vendor" cause). */
export async function advanceOrderStatus(
  tx: Prisma.TransactionClient,
  orderId: string,
  to: CrmOrderStatus,
  source = "eushipments",
  fulfillmentId?: string,
): Promise<boolean> {
  return followShipment(tx, orderId, to, source, { fulfillmentId });
}

/** Copies the spec list into the group's mapping table (idempotent; existing rows are never overwritten). */
export async function ensureStatusMapSeeded(accountId: string) {
  const db = accountDb(accountId);
  const rows = [...SEED_STATUSES, CANCELED_DELETED].map((x) => ({
    accountId,
    statusKey: normaliseStatusText(x.text),
    statusText: x.text,
    vendorStatusId: x.id || null,
    category: x.category,
    final: x.final,
    source: "seed",
    confirmed: true,
  }));
  const res = await db.eushipmentsStatusMapping.createMany({ data: rows, skipDuplicates: true });
  return res.count;
}

export async function loadStatusTable(accountId: string): Promise<Map<string, StatusRule>> {
  if ((await accountDb(accountId).eushipmentsStatusMapping.count()) === 0)
    await ensureStatusMapSeeded(accountId);
  const rows = await accountDb(accountId).eushipmentsStatusMapping.findMany({
    select: { statusKey: true, category: true, final: true, confirmed: true },
  });
  return new Map(
    rows
      // An observed-but-unmapped text stays UNKNOWN (and keeps alerting) until someone confirms it.
      .filter((r) => r.confirmed)
      .map((r) => [r.statusKey, { category: r.category as EuStatusCategory, final: r.final }]),
  );
}

/** Operator decision for a status text (new or existing). Audited by the caller's action. */
export async function setStatusMapping(
  accountId: string,
  input: { statusText: string; category: EuStatusCategory; final: boolean },
) {
  const statusKey = normaliseStatusText(input.statusText);
  if (!statusKey) throw new Error("empty status text");
  return accountDb(accountId).eushipmentsStatusMapping.upsert({
    where: { accountId_statusKey: { accountId, statusKey } },
    create: {
      accountId,
      statusKey,
      statusText: input.statusText,
      category: input.category,
      final: input.final,
      source: "operator",
      confirmed: true,
    },
    update: { category: input.category, final: input.final, source: "operator", confirmed: true },
  });
}

const ALERT_TEXT: Record<EuAlertKind, { severity: AlertSeverity; isTask: boolean; title: string }> = {
  blocked: {
    severity: "CRITICAL",
    isTask: true,
    title: "euShipments: shipment blocked at the warehouse",
  },
  return_received: {
    severity: "INFO",
    isTask: true,
    title: "euShipments: return received at the warehouse — notify support",
  },
  exception: { severity: "CRITICAL", isTask: true, title: "euShipments: shipment exception" },
  unknown_status: {
    severity: "WARNING",
    isTask: true,
    title: "euShipments: unknown status text — extend the status mapping",
  },
  delivery_attempt_failed: {
    severity: "WARNING",
    isTask: false,
    title: "euShipments: unsuccessful delivery attempt",
  },
};
export const STUCK_ALERT_KIND = "eushipments_stuck_accepted";

/** Opens an alert unless the same kind is already open for the same shipment. */
async function openAlertOnce(
  tx: Prisma.TransactionClient,
  data: {
    kind: string;
    severity: AlertSeverity;
    isTask: boolean;
    title: string;
    body: string;
    fulfillmentId: string;
    accountId: string;
  },
) {
  const existing = await tx.alert.findFirst({
    where: {
      kind: data.kind,
      entityType: "Fulfillment",
      entityId: data.fulfillmentId,
      status: { not: "RESOLVED" },
    },
    select: { id: true },
  });
  if (existing) return false;
  await tx.alert.create({
    data: {
      accountId: data.accountId,
      kind: data.kind,
      severity: data.severity,
      isTask: data.isTask,
      title: data.title,
      body: data.body.slice(0, 2000),
      entityType: "Fulfillment",
      entityId: data.fulfillmentId,
    },
  });
  return true;
}

interface DatedRecord {
  record: StatusRecord;
  recordId: string;
  at: Date | null;
}

/** Latest status = latest DATE, then highest record id (records of one order share a sequence). */
function ordered(records: StatusRecord[]): DatedRecord[] {
  return records
    .map((record) => ({
      record,
      recordId: String(record.ID),
      at: parseVendorDate(record.DATE ?? record.DATE_CREATED),
    }))
    .sort((a, b) => {
      const ta = a.at?.getTime() ?? 0;
      const tb = b.at?.getTime() ?? 0;
      if (ta !== tb) return ta - tb;
      const na = Number(a.recordId);
      const nb = Number(b.recordId);
      return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : a.recordId.localeCompare(b.recordId);
    });
}

/** Start of the trailing run of ACCEPTED-group statuses (when the shipment entered "waiting" state). */
function acceptedSince(dated: DatedRecord[], table: ReadonlyMap<string, StatusRule>): Date | null {
  let since: Date | null = null;
  for (let i = dated.length - 1; i >= 0; i--) {
    const d = dated[i]!;
    if (resolveStatus(d.record.STATUS, table).category !== "ACCEPTED") break;
    since = d.at ?? since;
  }
  return since;
}

export interface ApplyResult {
  category: EuStatusCategory | null;
  status: CrmOrderStatus;
  newEvents: number;
  stopPolling: boolean;
  alerts: string[];
}

/**
 * Applies one orders-history item to a Fulfillment: stores every status record once (FulfillmentEvent,
 * deduplicated by the vendor record id), sets the CRM status from the LATEST record, records AWB / return
 * AWB, records unseen texts as UNKNOWN mappings and raises alerts (BLOCKED immediately, RETURN_RECEIVED →
 * support, EXCEPTION, UNKNOWN, failed delivery attempt, too long in Information received).
 * Alerts are raised only for the CURRENT status, so an old BLOCKED that has since moved on does not alert.
 * Idempotent: applying the same answer twice changes nothing. Per-item errors must be handled by the caller.
 */
export async function applyOrderHistory(
  accountId: string,
  fulfillmentId: string,
  item: HistoryItem,
  now: Date = new Date(),
): Promise<ApplyResult> {
  const table = await loadStatusTable(accountId);
  const settingsFor = async (tx: Prisma.TransactionClient, connectionId: string) =>
    tx.eushipmentsSettings.findUnique({
      where: { accountId_connectionId: { accountId, connectionId } },
      select: { acceptedAlertHours: true, acceptedAlertWorkDays: true },
    });

  return withAccountTransaction(accountId, async (tx, { lockKey }) => {
    await lockKey(`eushipments:fulfillment:${fulfillmentId}`);
    const f = await tx.fulfillment.findUniqueOrThrow({
      where: { id: fulfillmentId },
      select: {
        id: true,
        orderId: true,
        connectionId: true,
        externalId: true,
        status: true,
        trackingNumbers: true,
        shippedAt: true,
        deliveredAt: true,
        carrier: true,
      },
    });
    // Shipments created before the courier was recorded: take it from the create-order the CRM sent (courierId).
    let carrier = f.carrier;
    if (!carrier) {
      const req = await tx.outboundRequest.findFirst({
        where: { fulfillmentId, operation: "eushipments.createOrder" },
        orderBy: { createdAt: "desc" },
        select: { payload: true },
      });
      const courierId = Number((req?.payload as { body?: { courierId?: unknown } } | null)?.body?.courierId);
      if (Number.isInteger(courierId) && courierId > 0)
        carrier =
          (
            await tx.eushipmentsCourier.findFirst({
              where: { connectionId: f.connectionId, courierId },
              select: { name: true },
            })
          )?.name ?? null;
    }
    const dated = ordered(item.statusesHistory ?? []);
    const known = new Set(
      (
        await tx.fulfillmentEvent.findMany({
          where: { fulfillmentId, source: EU_EVENT_SOURCE },
          select: { payload: true },
        })
      ).map((e) => String((e.payload as { recordId?: unknown } | null)?.recordId ?? "")),
    );

    // Texts never seen before are recorded so an operator can map them (they stay UNKNOWN until then).
    for (const d of dated) {
      const r = resolveStatus(d.record.STATUS, table);
      if (!r.matched && r.key) {
        await tx.eushipmentsStatusMapping.createMany({
          data: [
            {
              accountId,
              statusKey: r.key,
              statusText: d.record.STATUS.slice(0, 200),
              category: r.category,
              final: false,
              source: "observed",
              confirmed: false,
            },
          ],
          skipDuplicates: true,
        });
      }
    }

    const fresh = dated.filter((d) => !known.has(d.recordId));
    for (const d of fresh) {
      const r = resolveStatus(d.record.STATUS, table);
      await tx.fulfillmentEvent.create({
        data: {
          accountId,
          fulfillmentId,
          occurredAt: d.at ?? now,
          source: EU_EVENT_SOURCE,
          rawStatus: d.record.STATUS.slice(0, 200),
          status: CRM_STATUS[r.category],
          payload: {
            recordId: d.recordId,
            category: r.category,
            date: d.record.DATE ?? null,
            comment: d.record.COMMENT ?? null,
            partnerVoucher: d.record.PARTNER_VOUCHER ?? null,
          },
        },
      });
    }

    const latest = dated.at(-1);
    const alerts: string[] = [];
    if (!latest) {
      return { category: null, status: f.status, newEvents: 0, stopPolling: false, alerts };
    }
    const rule = resolveStatus(latest.record.STATUS, table);
    // A shipment replaced by a confirmed reroute (P4-09) keeps its status; the order follows its new shipment.
    const superseded = await isSupersededShipment(tx, f.id);
    const crm = superseded ? f.status : (CRM_STATUS[rule.category] ?? f.status); // CANCEL_PENDING keeps the previous status
    const tracking = [...f.trackingNumbers];
    if (item.awb && !tracking.includes(item.awb)) tracking.push(item.awb);
    await tx.fulfillment.update({
      where: { id: fulfillmentId },
      data: {
        status: crm,
        rawStatus: latest.record.STATUS.slice(0, 200),
        trackingNumbers: tracking,
        ...(carrier && carrier !== f.carrier ? { carrier } : {}),
        ...(item.newReturnNumber ? { returnInfo: { returnAwb: item.newReturnNumber } } : {}),
        ...(rule.category === "IN_TRANSIT" && !f.shippedAt ? { shippedAt: latest.at ?? now } : {}),
        ...(rule.category === "DELIVERED" && !f.deliveredAt ? { deliveredAt: latest.at ?? now } : {}),
      },
    });
    // Cancelled/deleted at euShipments WITHOUT a delete request from the CRM (someone removed it in the cabinet):
    // the order is not cancelled for the customer — it is blocked with a task so a person resends it
    // ("Изпрати отново", new shipment) or cancels it in Shopify. A CRM-requested delete follows as before.
    // Only a delete that actually left the CRM counts (not a DRY_RUN / READ_ONLY / refused one).
    const crmDeleteRequested = crm === "CANCELLED" && (await crmCancelLeft(tx, accountId, f.id));
    const cancelledAtVendor =
      !superseded && crm === "CANCELLED" && f.status !== "CANCELLED" && !crmDeleteRequested;
    // Deleted after a delete the CRM asked for ("Откажи в склада"): the order goes to BLOCKED with an info entry,
    // so a person resends it or cancels the order (never straight to CANCELLED). A shipment already CANCELLED by the
    // delete's own answer does not move the order again.
    if (!superseded && crmDeleteRequested) {
      if (f.status !== "CANCELLED")
        await warehouseCancelConfirmed(tx, {
          accountId,
          orderId: f.orderId,
          fulfillmentId: f.id,
          source: "eushipments.history",
        });
    } else if (!superseded)
      await advanceOrderStatus(
        tx,
        f.orderId,
        cancelledAtVendor ? "BLOCKED" : crm,
        "eushipments.history",
        f.id,
      );
    if (cancelledAtVendor)
      await openAlertOnce(tx, {
        kind: "eushipments_cancelled_at_vendor",
        severity: "CRITICAL",
        isTask: true,
        title: `euShipments: пратка ${f.externalId} е изтрита/анулирана в кабинета — изпратете поръчката отново или я откажете в Shopify`,
        body: `Shipment ${f.externalId}: "${scrubText(latest.record.STATUS, 200)}"`,
        fulfillmentId,
        accountId,
      });

    const body = `Shipment ${f.externalId}: "${scrubText(latest.record.STATUS, 200)}"${
      latest.record.COMMENT ? ` (${scrubText(latest.record.COMMENT, 200)})` : ""
    } at ${latest.record.DATE ?? "?"}`;
    const kind = !rule.matched && rule.family ? null : alertFor(rule.category, rule.key);
    // Only a NEW current status alerts (re-polling the same status does not re-open a resolved alert).
    if (kind && fresh.some((d) => d.recordId === latest.recordId)) {
      const meta = ALERT_TEXT[kind];
      if (await openAlertOnce(tx, { kind: `eushipments_${kind}`, ...meta, body, fulfillmentId, accountId }))
        alerts.push(kind);
    }
    if (rule.category === "ACCEPTED") {
      const since = acceptedSince(dated, table);
      const s = await settingsFor(tx, f.connectionId);
      const opts = { hours: s?.acceptedAlertHours ?? 24, workingDaysOnly: s?.acceptedAlertWorkDays ?? true };
      if (since && isStuckAccepted(since, now, opts)) {
        const opened = await openAlertOnce(tx, {
          kind: STUCK_ALERT_KIND,
          severity: "WARNING",
          isTask: true,
          title: `euShipments: still "${scrubText(latest.record.STATUS, 100)}" after ${opts.hours} h`,
          body,
          fulfillmentId,
          accountId,
        });
        if (opened) alerts.push("stuck_accepted");
      }
    }
    return {
      category: rule.category,
      status: crm,
      newEvents: fresh.length,
      stopPolling: stopsPolling(rule),
      alerts,
    };
  });
}

/**
 * A shipment whose CRM delete left the CRM (answer lost / unknown) and that orders-history no longer lists on two
 * polls in a row: taken as the delete's confirmation (BLOCKED with attribution, warehouseCancelConfirmed). Only then —
 * "not found" alone never cancels anything (owner report 2026-11-12: orders in "Information received" are not
 * always listed). If it shows up live later, the poller opens a task (reinstateGoneShipment refuses it).
 */
export async function confirmDeleteByNotFound(
  accountId: string,
  fulfillmentId: string,
  /** When the previous "not found" was polled: it must come after the delete went out, not before. */
  previousNotFoundAt: Date,
) {
  return withAccountTransaction(accountId, async (tx, { lockKey }) => {
    await lockKey(`eushipments:fulfillment:${fulfillmentId}`);
    const f = await tx.fulfillment.findUniqueOrThrow({
      where: { id: fulfillmentId },
      select: { id: true, orderId: true, status: true, externalId: true },
    });
    if (f.status === "CANCELLED" || (await isSupersededShipment(tx, f.id))) return false;
    // Only a delete whose answer was lost (UNCERTAIN, not one still on its way) and "not found" both times after it.
    // The newest delete of it decides (an older unclear one does not count against a newer refused one).
    const del = await tx.outboundRequest.findFirst({
      where: { accountId, fulfillmentId: f.id, operation: { in: [...CANCEL_OPERATIONS] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { status: true, lockedAt: true, createdAt: true },
    });
    if (!del || del.status !== "UNCERTAIN" || previousNotFoundAt <= (del.lockedAt ?? del.createdAt))
      return false;
    // Not proof on its own: the order is not sent again until a person checked the cabinet (validateOrder).
    await openAlertOnce(tx, {
      kind: "eushipments_delete_unconfirmed",
      severity: "CRITICAL",
      isTask: true,
      title: `euShipments: изтриването на ${f.externalId} не е потвърдено — проверете в кабинета, че я няма, и затворете задачата (чак тогава изпратете отново)`,
      body: `The CRM asked euShipments to delete ${f.externalId}; the answer was lost and orders-history no longer lists it. That is taken as the delete, but orders-history does not list every order: check the cabinet.`,
      fulfillmentId: f.id,
      accountId,
    });
    await tx.fulfillment.update({
      where: { id: f.id },
      data: { status: "CANCELLED", rawStatus: GONE_NOT_FOUND },
    });
    await warehouseCancelConfirmed(tx, {
      accountId,
      orderId: f.orderId,
      fulfillmentId: f.id,
      source: "eushipments.not_found",
    });
    return true;
  });
}

/** rawStatus of a shipment the CRM gave up because orders-history kept answering "not found". */
export const GONE_NOT_FOUND = "not found at euShipments";
const ORPHANED_WRITEBACK = "shipment_cancelled_after_fulfil";

export type ReinstateResult =
  | { ok: true }
  /** Not a shipment given up as "not found" (any more): nothing to do. */
  | { ok: false; why: "not_gone" }
  /** The CRM asked the warehouse to delete it, or a person already acted on the order: a person decides. */
  | { ok: false; why: "cancel_requested" | "handled" };

/**
 * A shipment given up as "not found at euShipments" (older code) that orders-history now lists, not as deleted:
 * active again (owner report 2026-11-12: an order sat in "Information received" in the cabinet while orders-history
 * said "not found"; the CRM had cancelled it and blocked the order). Only when nothing else happened since:
 * no CRM delete of it left the CRM, it is not re-routed / replaced, the order is still BLOCKED by that very
 * "not found" (its latest event) and no other shipment of the order is active. Otherwise `handled` /
 * `cancel_requested` and nothing changes (the caller opens a task). The caller then applies the history as usual.
 */
export async function reinstateGoneShipment(
  accountId: string,
  fulfillmentId: string,
): Promise<ReinstateResult> {
  return withAccountTransaction(accountId, async (tx, { lockKey }) => {
    await lockKey(`eushipments:fulfillment:${fulfillmentId}`);
    const f = await tx.fulfillment.findUniqueOrThrow({
      where: { id: fulfillmentId },
      select: { id: true, orderId: true, status: true, rawStatus: true, order: { select: { status: true } } },
    });
    if (f.status !== "CANCELLED" || f.rawStatus !== GONE_NOT_FOUND) return { ok: false, why: "not_gone" };
    if (await crmCancelLeft(tx, accountId, f.id)) return { ok: false, why: "cancel_requested" };
    if (f.order.status !== "BLOCKED" || (await isSupersededShipment(tx, f.id)))
      return { ok: false, why: "handled" };
    const last = await tx.orderEvent.findFirst({
      where: { accountId, orderId: f.orderId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { toStatus: true, source: true },
    });
    if (last?.toStatus !== "BLOCKED" || last.source !== "eushipments.not_found")
      return { ok: false, why: "handled" };
    const other = await tx.fulfillment.count({
      where: { orderId: f.orderId, id: { not: f.id }, status: { notIn: ["CANCELLED", "SUBMIT_FAILED"] } },
    });
    if (other) return { ok: false, why: "handled" };
    await tx.fulfillment.update({ where: { id: f.id }, data: { status: "ACCEPTED", rawStatus: null } });
    const moved = await transition(tx, {
      orderId: f.orderId,
      to: "ACCEPTED",
      cause: "vendor_reinstate",
      actor: { kind: "system" },
      source: "eushipments.found_again",
      reason: "listed by orders-history again",
    });
    if (!moved.changed) throw new Error(`reinstate refused: ${moved.reason ?? "?"}`);
    // Shopify: a fulfillment flagged as orphaned is this shipment's again; rows refused because it was cancelled
    // go out again (unique per shipment + kind: never a second Shopify fulfillment).
    await tx.shopifyWriteBack.updateMany({
      where: { accountId, fulfillmentId: f.id, lastError: ORPHANED_WRITEBACK },
      data: { lastError: null },
    });
    await tx.shopifyWriteBack.updateMany({
      where: { accountId, fulfillmentId: f.id, status: "REFUSED", lastError: "shipment_cancelled" },
      // The send path applies the store's mode and the carrier hold again (AWAITING_CONFIRMATION when unknown).
      data: { status: "PENDING", attempts: 0, nextAttemptAt: null, lastError: null },
    });
    const stillOrphaned = await tx.shopifyWriteBack.count({
      where: { accountId, orderId: f.orderId, lastError: ORPHANED_WRITEBACK },
    });
    // The tasks about it being gone no longer apply.
    const tasks = await tx.alert.findMany({
      where: {
        accountId,
        status: { not: "RESOLVED" },
        OR: [
          {
            kind: {
              in: [
                "eushipments_cancelled_at_vendor",
                "eushipments_not_found",
                "eushipments_delete_unconfirmed",
              ],
            },
            entityType: "Fulfillment",
            entityId: f.id,
          },
          ...(stillOrphaned
            ? []
            : [{ kind: "shopify_writeback_orphaned", entityType: "Order", entityId: f.orderId }]),
        ],
      },
      select: { id: true },
    });
    for (const a of tasks) {
      await tx.alert.update({ where: { id: a.id }, data: { status: "RESOLVED", resolvedAt: new Date() } });
      await tx.alertNote.create({
        data: { accountId, alertId: a.id, action: "auto_resolve", note: "found at euShipments again" },
      });
    }
    return { ok: true };
  });
}

/**
 * A shipment given up as "not found" that orders-history lists live, but which the CRM cannot take back (a delete
 * was asked for, or the order was handled since — re-sent, re-routed, cancelled): one CRITICAL task, the warehouse
 * may ship it next to whatever replaced it.
 */
export async function openGoneLiveTask(
  accountId: string,
  fulfillmentId: string,
  reference: string,
  vendorStatus: string,
  why: "cancel_requested" | "handled",
) {
  return withAccountTransaction(accountId, async (tx, { lockKey }) => {
    await lockKey(`eushipments:fulfillment:${fulfillmentId}`);
    return openAlertOnce(tx, {
      kind: "eushipments_gone_shipment_live",
      severity: "CRITICAL",
      isTask: true,
      title: `euShipments: ${reference} е активна в кабинета („${vendorStatus}“), а в CRM е отказана — проверете за двойна пратка и изтрийте излишната в кабинета`,
      body:
        why === "cancel_requested"
          ? `The CRM asked euShipments to delete ${reference} and later took "not found" as the confirmation; orders-history now lists it as "${vendorStatus}". The warehouse may ship it.`
          : `${reference} was given up as "not found"; since then the order was handled (re-sent, re-routed or cancelled). orders-history now lists it as "${vendorStatus}": the warehouse may ship it next to the replacement.`,
      fulfillmentId,
      accountId,
    });
  });
}

/**
 * Older code titled the "gone" task "send it again" (and never resolves it): every such open task of the account is
 * retitled "check the cabinet, do not send again". Idempotent; run with each poll.
 */
export async function retitleGoneTasks(accountId: string) {
  const db = accountDb(accountId);
  const old = await db.alert.findMany({
    where: {
      accountId,
      kind: "eushipments_cancelled_at_vendor",
      status: { not: "RESOLVED" },
      title: { contains: "изпратете поръчката отново" },
    },
    select: { id: true, title: true },
    take: 200,
  });
  for (const a of old) {
    const ref = /пратка (\S+)/.exec(a.title)?.[1] ?? "";
    await db.alert.updateMany({
      where: { id: a.id, accountId },
      data: {
        title: `euShipments: ${ref} не се намира в orders-history — проверете в кабинета (НЕ изпращайте отново)`,
      },
    });
  }
}
