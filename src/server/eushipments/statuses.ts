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

/**
 * euShipments status tracking on the CRM side (P3-03): the per-group mapping table, applying an
 * orders-history answer to one Fulfillment (events, status, alerts) and the "stuck in Information received"
 * check. Polling itself (batches of 100 every 15 min) is the read-side job (P3-02) and calls into here.
 */

export const EU_EVENT_SOURCE = "eushipments";

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
        connectionId: true,
        externalId: true,
        status: true,
        trackingNumbers: true,
        shippedAt: true,
        deliveredAt: true,
      },
    });
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
    const crm = CRM_STATUS[rule.category] ?? f.status; // CANCEL_PENDING keeps the previous status
    const tracking = [...f.trackingNumbers];
    if (item.awb && !tracking.includes(item.awb)) tracking.push(item.awb);
    await tx.fulfillment.update({
      where: { id: fulfillmentId },
      data: {
        status: crm,
        rawStatus: latest.record.STATUS.slice(0, 200),
        trackingNumbers: tracking,
        ...(item.newReturnNumber ? { returnInfo: { returnAwb: item.newReturnNumber } } : {}),
        ...(rule.category === "IN_TRANSIT" && !f.shippedAt ? { shippedAt: latest.at ?? now } : {}),
        ...(rule.category === "DELIVERED" && !f.deliveredAt ? { deliveredAt: latest.at ?? now } : {}),
      },
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
