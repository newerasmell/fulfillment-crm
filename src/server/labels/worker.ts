import type { CrmOrderStatus, Prisma } from "@/generated/prisma/client";
import { AWB_LIMITS, isNoPrice, ShipmentPriceBody } from "@/integrations/eushipments/awb-schemas";
import { waybillFor } from "@/integrations/eushipments/awb-client";
import type { EuShipmentsClientOptions } from "@/integrations/eushipments/client";
import { JOY_FINAL, mapJoyStatus } from "@/integrations/fhb-joy/status-map";
import type { JoyClientOptions } from "@/integrations/fhb-joy/client";
import { JOY_LIMITS } from "@/integrations/fhb-joy/schemas";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import { accountDb, systemDb, withAccountTransaction } from "@/server/db/client";
import { applyOrderHistory } from "@/server/eushipments/statuses";
import { followShipment } from "@/server/pipeline";
import { awbClientFor, joyClientFor, recordJoyTest } from "./connection";
import { storeLabel } from "./storage";

/**
 * Worker side of labels — READ calls only (tracking, label prints, bulk PDFs, price quotes, connection test).
 * Every write goes through the outbox (src/server/labels/manual.ts). Account-scoped after the first lookup.
 */

export interface LabelWorkerDeps {
  joy?: JoyClientOptions;
  eu?: EuShipmentsClientOptions;
  now?: Date;
}

const TRACKED: CrmOrderStatus[] = [
  "ACCEPTED",
  "PROCESSING",
  "SHIPPED",
  "RETURNING",
  "EXCEPTION",
  "BLOCKED",
  "UNKNOWN",
];
export const TRACK_EVERY_MS = 30 * 60_000;
const err = (e: unknown) => scrubText(String((e as Error)?.message ?? e), 300);

async function alertOnce(
  tx: Prisma.TransactionClient,
  accountId: string,
  fulfillmentId: string,
  kind: string,
  severity: "WARNING" | "CRITICAL",
  title: string,
  body: string,
) {
  const open = await tx.alert.findFirst({
    where: { kind, entityType: "Fulfillment", entityId: fulfillmentId, status: { not: "RESOLVED" } },
    select: { id: true },
  });
  if (open) return;
  await tx.alert.create({
    data: {
      accountId,
      kind,
      isTask: true,
      severity,
      title: title.slice(0, 300),
      body: scrubText(body, 2000),
      entityType: "Fulfillment",
      entityId: fulfillmentId,
    },
  });
}

// ───────────────────────── tracking ─────────────────────────

/** Label shipments due for a tracking read, grouped by account + connection (system read, then scoped). */
export async function labelsDueForTracking(now = new Date(), limit = 1000) {
  const rows = await systemDb().manualShipment.findMany({
    where: {
      kind: { in: ["JOY_LABEL", "AWB"] },
      stopTracking: false,
      fulfillment: { status: { in: TRACKED } },
      OR: [{ trackedAt: null }, { trackedAt: { lt: new Date(now.getTime() - TRACK_EVERY_MS) } }],
    },
    select: { accountId: true, connectionId: true },
    orderBy: { trackedAt: { sort: "asc", nulls: "first" } },
    take: limit,
  });
  const groups = new Map<string, { accountId: string; connectionId: string }>();
  for (const r of rows) groups.set(`${r.accountId}:${r.connectionId}`, r);
  return [...groups.values()];
}

/** One connection's open label shipments: Joy GET /shipment per id, euShipments waybills-history per 100 AWBs. */
export async function trackLabels(accountId: string, connectionId: string, deps: LabelWorkerDeps = {}) {
  const now = deps.now ?? new Date();
  const db = accountDb(accountId);
  const conn = await db.fulfillmentConnection.findUnique({
    where: { id: connectionId },
    select: { type: true, enabled: true },
  });
  if (!conn || !conn.enabled) return { tracked: 0 };
  const due = await db.manualShipment.findMany({
    where: {
      connectionId,
      kind: { in: ["JOY_LABEL", "AWB"] },
      stopTracking: false,
      fulfillment: { status: { in: TRACKED } },
      OR: [{ trackedAt: null }, { trackedAt: { lt: new Date(now.getTime() - TRACK_EVERY_MS) } }],
    },
    include: { fulfillment: true },
    take: 500,
  });
  if (due.length === 0) return { tracked: 0 };
  if (conn.type === "FHB_JOY") {
    const client = await joyClientFor(accountId, connectionId, deps.joy);
    let tracked = 0;
    for (const ms of due) {
      const f = ms.fulfillment!;
      try {
        const info = await client.getShipment(f.externalId);
        await applyJoyInfo(accountId, ms.id, f.id, info, now);
        tracked++;
      } catch (e) {
        await db.manualShipment.update({
          where: { id: ms.id },
          data: { trackedAt: now, trackError: err(e) },
        });
      }
    }
    return { tracked };
  }
  // euShipments AWBs: strictly by AWB number (pre-AWBs have none and are not tracked here).
  const withAwb = due.filter((m) => m.fulfillment?.vendorOrderId);
  const client = (await awbClientFor(accountId, connectionId, deps.eu)).client;
  let tracked = 0;
  for (let i = 0; i < withAwb.length; i += AWB_LIMITS.waybillsHistoryMax) {
    const batch = withAwb.slice(i, i + AWB_LIMITS.waybillsHistoryMax);
    let items;
    try {
      items = await client.waybillsHistory(batch.map((m) => m.fulfillment!.vendorOrderId!));
    } catch (e) {
      logger.warn({ connectionId, err: err(e) }, "waybills-history batch failed");
      continue;
    }
    for (const ms of batch) {
      const awb = ms.fulfillment!.vendorOrderId!;
      const item = waybillFor(items, awb);
      if (!item || item.error || item.errorCode) {
        await db.manualShipment.update({
          where: { id: ms.id },
          data: {
            trackedAt: now,
            trackError: item?.error ? scrubText(String(item.error), 300) : "not found at euShipments",
          },
        });
        continue;
      }
      try {
        const r = await applyOrderHistory(accountId, ms.fulfillmentId!, item, now);
        await db.manualShipment.update({
          where: { id: ms.id },
          data: { trackedAt: now, trackError: null, stopTracking: r.stopPolling },
        });
        tracked++;
      } catch (e) {
        await db.manualShipment.update({
          where: { id: ms.id },
          data: { trackedAt: now, trackError: err(e) },
        });
      }
    }
  }
  return { tracked };
}

type JoyInfo = Awaited<ReturnType<Awaited<ReturnType<typeof joyClientFor>>["getShipment"]>>;

/** Applies one GET /shipment answer: events once each, status (raw + mapped), tracking numbers/links, alerts. */
export async function applyJoyInfo(
  accountId: string,
  manualShipmentId: string,
  fulfillmentId: string,
  info: JoyInfo,
  now = new Date(),
) {
  await withAccountTransaction(accountId, async (tx, { lockKey }) => {
    await lockKey(`labels:fulfillment:${fulfillmentId}`);
    const f = await tx.fulfillment.findUniqueOrThrow({ where: { id: fulfillmentId } });
    if (!info) {
      await tx.manualShipment.update({
        where: { id: manualShipmentId },
        data: { trackedAt: now, trackError: "not found at FHB Joy" },
      });
      await alertOnce(
        tx,
        accountId,
        f.id,
        "labels_joy_not_found",
        "CRITICAL",
        `FHB Joy: shipment ${f.externalId} not found`,
        "GET /shipment answers 404 for a label the CRM records as created. Check ZOE.",
      );
      return;
    }
    const emb = info._embedded;
    const known = new Set(
      (
        await tx.fulfillmentEvent.findMany({
          where: { fulfillmentId, source: "joy" },
          select: { payload: true },
        })
      ).map((e) => String((e.payload as { key?: unknown } | null)?.key ?? "")),
    );
    for (const ev of emb?.trackingEvents ?? []) {
      const key = `${ev.date ?? ""}|${ev.message ?? ""}`;
      if (known.has(key)) continue;
      known.add(key);
      const at = ev.date ? new Date(ev.date.replace(" ", "T")) : now;
      await tx.fulfillmentEvent.create({
        data: {
          accountId,
          fulfillmentId,
          occurredAt: Number.isFinite(at.getTime()) ? at : now,
          source: "joy",
          rawStatus: (ev.message ?? "").slice(0, 200) || null,
          payload: { key, date: ev.date ?? null, message: ev.message ?? null },
        },
      });
    }
    const m = mapJoyStatus(info.status);
    const tracking = [...new Set([...f.trackingNumbers, ...(emb?.trackingNumber ?? [])])];
    const urls = [...new Set([...f.trackingUrls, ...(emb?.trackingLink ?? [])])];
    // A status we did not ask for: CANCELLED by a reject we did not send (our void sets CANCELLED first).
    const status: CrmOrderStatus = m.status === "UNKNOWN" ? f.status : m.status;
    await tx.fulfillment.update({
      where: { id: fulfillmentId },
      data: {
        status,
        rawStatus: m.raw,
        trackingNumbers: tracking,
        trackingUrls: urls,
        ...(status === "SHIPPED" && !f.shippedAt ? { shippedAt: now } : {}),
        ...(status === "DELIVERED" && !f.deliveredAt ? { deliveredAt: now } : {}),
      },
    });
    if (f.rawStatus !== m.raw)
      await tx.fulfillmentEvent.create({
        data: {
          accountId,
          fulfillmentId,
          occurredAt: now,
          source: "joy.status",
          rawStatus: m.raw,
          status: m.status === "UNKNOWN" ? null : m.status,
        },
      });
    if (m.status !== "UNKNOWN") await followShipment(tx, f.orderId, m.status, "joy.status");
    if (m.alert)
      await alertOnce(
        tx,
        accountId,
        f.id,
        "labels_joy_unknown_status",
        "WARNING",
        `FHB Joy: unknown status "${m.raw ?? ""}" for ${f.externalId}`,
        "Stored raw; extend the Joy status map.",
      );
    if (m.status === "CANCELLED" && f.status !== "CANCELLED")
      await alertOnce(
        tx,
        accountId,
        f.id,
        "labels_joy_rejected",
        "WARNING",
        `FHB Joy: label ${f.externalId} was rejected`,
        "The label is void at FHB Joy (not requested from the CRM). Check ZOE.",
      );
    await tx.manualShipment.update({
      where: { id: manualShipmentId },
      data: { trackedAt: now, trackError: null, stopTracking: JOY_FINAL.has((m.raw ?? "").toLowerCase()) },
    });
  });
}

// ───────────────────────── single labels (AWB print, Joy reprint) ─────────────────────────

/** AWB shipments with an AWB number but no stored label (the label is fetched after create). */
export async function awbLabelsMissing(limit = 100) {
  return systemDb().manualShipment.findMany({
    where: {
      kind: "AWB",
      fulfillment: { vendorOrderId: { not: null }, labelFileKey: null, status: { in: TRACKED } },
    },
    select: { accountId: true, fulfillmentId: true },
    take: limit,
  });
}

/** Fetches and stores the label of one label shipment (euShipments print/{awb}; Joy reprint ≤ 5 days). */
export async function fetchLabel(
  accountId: string,
  fulfillmentId: string,
  deps: LabelWorkerDeps = {},
  createdById: string | null = null,
) {
  const db = accountDb(accountId);
  const ms = await db.manualShipment.findFirst({ where: { fulfillmentId }, include: { fulfillment: true } });
  const f = ms?.fulfillment;
  if (!ms || !f) return { stored: false, reason: "not_found" };
  let base64: string | null = null;
  let source = "";
  let format: "PDF" | "ZPL" = "PDF";
  if (ms.kind === "JOY_LABEL") {
    const r = await (await joyClientFor(accountId, ms.connectionId, deps.joy)).reprintShipment(f.externalId);
    base64 = r?.label ?? null;
    source = "joy.reprint";
  } else if (ms.kind === "AWB" && f.vendorOrderId) {
    const r = await (
      await awbClientFor(accountId, ms.connectionId, deps.eu)
    ).client.print(f.vendorOrderId, { printFileType: 2 });
    base64 = r.awb_print;
    format = r.type.toUpperCase() === "ZPL" ? "ZPL" : "PDF";
    source = "awb.print";
  } else return { stored: false, reason: "no_label" };
  if (!base64) return { stored: false, reason: "no_label" };
  const label = await withAccountTransaction(accountId, (tx) =>
    storeLabel(tx, {
      accountId,
      connectionId: ms.connectionId,
      fulfillmentId,
      source,
      base64: base64!,
      format,
      createdById,
    }),
  );
  return { stored: true, labelId: label.id };
}

// ───────────────────────── bulk label PDF ─────────────────────────

/** One bulk print job: Joy GET /labels?ids= (≤100) or euShipments merged/print (≤50) → one stored PDF. */
export async function runLabelPrintJob(accountId: string, jobId: string, deps: LabelWorkerDeps = {}) {
  const db = accountDb(accountId);
  const claimed = await db.labelPrintJob.updateMany({
    where: { id: jobId, status: "QUEUED" },
    data: { status: "RUNNING" },
  });
  if (claimed.count !== 1) return { status: "skipped" as const };
  const job = await db.labelPrintJob.findUniqueOrThrow({
    where: { id: jobId },
    include: { connection: { select: { type: true } } },
  });
  const shipments = await db.fulfillment.findMany({
    where: { id: { in: job.fulfillmentIds } },
    select: { id: true, externalId: true, vendorOrderId: true },
  });
  const byId = new Map(shipments.map((s) => [s.id, s]));
  const ordered = job.fulfillmentIds.map((id) => byId.get(id)).filter((s): s is NonNullable<typeof s> => !!s);
  try {
    let base64: string;
    let source: string;
    const errors: Record<string, string> = {};
    if (job.connection.type === "FHB_JOY") {
      if (ordered.length > JOY_LIMITS.labelsMax) throw new Error("too many labels for one Joy call");
      base64 = await (
        await joyClientFor(accountId, job.connectionId, deps.joy)
      ).labels(ordered.map((s) => s.externalId));
      source = "joy.labels";
    } else {
      const withAwb = ordered.filter((s) => s.vendorOrderId);
      for (const s of ordered) if (!s.vendorOrderId) errors[s.id] = "no AWB yet";
      if (withAwb.length === 0) throw new Error("none of the shipments has an AWB yet");
      const r = await (
        await awbClientFor(accountId, job.connectionId, deps.eu)
      ).client.mergedPrint(withAwb.map((s) => s.vendorOrderId!));
      for (const [awb, e] of Object.entries(r.errorPrinting)) {
        const s = withAwb.find((x) => x.vendorOrderId === awb);
        if (s) errors[s.id] = scrubText(e, 200);
      }
      if (!r.success || !r.base64_pdf) throw new Error(scrubText(r.message ?? "merged print failed"));
      base64 = r.base64_pdf;
      source = "awb.merged";
    }
    const label = await withAccountTransaction(accountId, async (tx) => {
      const l = await storeLabel(tx, {
        accountId,
        connectionId: job.connectionId,
        source,
        base64,
        kind: "bulk",
        fulfillmentIds: ordered.map((s) => s.id),
        createdById: job.createdById,
      });
      await tx.labelPrintJob.update({
        where: { id: jobId },
        data: { status: "DONE", labelId: l.id, errors, finishedAt: new Date() },
      });
      return l;
    });
    return { status: "DONE" as const, labelId: label.id };
  } catch (e) {
    await db.labelPrintJob.update({
      where: { id: jobId },
      data: { status: "FAILED", error: err(e), finishedAt: new Date() },
    });
    return { status: "FAILED" as const, error: err(e) };
  }
}

// ───────────────────────── price quote, connection test ─────────────────────────

export async function runQuote(accountId: string, quoteId: string, deps: LabelWorkerDeps = {}) {
  const db = accountDb(accountId);
  const q = await db.shippingQuote.findUnique({ where: { id: quoteId } });
  if (!q || q.status !== "QUEUED") return { status: "skipped" };
  try {
    const { client } = await awbClientFor(accountId, q.connectionId, deps.eu);
    const r = await client.shipmentPrice(ShipmentPriceBody.parse(q.request));
    const status = isNoPrice(r) ? "NO_PRICE" : "DONE";
    await db.shippingQuote.update({
      where: { id: quoteId },
      data: { status, response: JSON.parse(JSON.stringify(r)), finishedAt: new Date() },
    });
    return { status };
  } catch (e) {
    await db.shippingQuote.update({
      where: { id: quoteId },
      data: { status: "FAILED", error: err(e), finishedAt: new Date() },
    });
    return { status: "FAILED" };
  }
}

export async function testJoyConnection(accountId: string, connectionId: string, deps: LabelWorkerDeps = {}) {
  try {
    await (await joyClientFor(accountId, connectionId, deps.joy)).testLogin();
    await recordJoyTest(accountId, connectionId, { ok: true });
    return { ok: true };
  } catch (e) {
    await recordJoyTest(accountId, connectionId, { ok: false, error: err(e) });
    return { ok: false };
  }
}
