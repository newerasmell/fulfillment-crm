import type { AlertSeverity, Prisma } from "@/generated/prisma/client";
import type { FhbResultEvent } from "@/integrations/fhb-v3/adapter";
import { mapFhbOrderView, mapFhbProductView } from "@/integrations/fhb-v3/mapper";
import type { FhbOrderView, FhbProductView, FhbStockReceiptView } from "@/integrations/fhb-v3/schemas";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import { followShipment, isSupersededShipment, transition } from "@/server/pipeline";
import { warehouseCancelConfirmed, warehouseCancelRefused } from "@/server/override/cancel-effects";

/**
 * Applies what FHB told us (create/update responses, read-backs, callback re-reads) to the CRM mirror:
 * Fulfillment (status + raw status, tracking, uid), VendorProduct + StockLevel, InboundShipment.
 * Idempotent: applying the same view twice changes nothing and raises no second alert.
 * Order.status follows the shipment through the pipeline state machine (src/server/pipeline): forward only,
 * never over an operator state; a refused create moves a QUEUED/SUBMITTING order to SUBMIT_FAILED.
 */

const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

/** One open alert per (kind, entity): repeated reads of the same problem do not pile up. */
export async function raiseAlertOnce(
  accountId: string,
  a: {
    kind: string;
    severity: AlertSeverity;
    title: string;
    body?: string;
    entityType: string;
    entityId: string;
    isTask?: boolean;
  },
) {
  const db = accountDb(accountId);
  const open = await db.alert.findFirst({
    where: { kind: a.kind, entityType: a.entityType, entityId: a.entityId, status: { not: "RESOLVED" } },
    select: { id: true },
  });
  if (open) return open.id;
  const created = await db.alert.create({
    data: {
      accountId,
      kind: a.kind,
      severity: a.severity,
      title: a.title,
      body: a.body ? scrubText(a.body, 2000) : null,
      entityType: a.entityType,
      entityId: a.entityId,
      isTask: a.isTask ?? false,
    },
    select: { id: true },
  });
  return created.id;
}

/** "1-EUR2849#STORNO#TJX6KD" → "1-EUR2849" (an order cancelled by hand in ZOE); null for any other id. */
export function fhbStornoBase(externalId: string): string | null {
  const i = externalId.indexOf("#STORNO#");
  return i > 0 ? externalId.slice(0, i) : null;
}

export async function applyFhbOrderView(
  accountId: string,
  connectionId: string,
  view: FhbOrderView,
  source: string,
  now = new Date(),
) {
  const m = mapFhbOrderView(view);
  // Observed in production (2026-11-03, not in the reference): an order cancelled by hand in ZOE comes back with
  // its id renamed to "{our id}#STORNO#{random}" and status "rejected". Match it to our shipment by the id we sent
  // (or by FHB's uid) and treat it as cancelled at the warehouse — a person decides what happens next.
  const storno = fhbStornoBase(m.externalId);
  const result = await withAccountTransaction(accountId, async (tx) => {
    const f =
      (await tx.fulfillment.findUnique({
        where: { connectionId_externalId: { connectionId, externalId: m.externalId } },
      })) ??
      (storno
        ? await tx.fulfillment.findUnique({
            where: { connectionId_externalId: { connectionId, externalId: storno } },
          })
        : null) ??
      (m.vendorUid
        ? await tx.fulfillment.findFirst({ where: { connectionId, vendorUid: m.vendorUid } })
        : null);
    if (!f) return null;
    // Replaced by a confirmed reroute (P4-09): the vendor's late view is kept, but never reactivates it.
    const superseded = await isSupersededShipment(tx, f.id);
    const shipmentStatus = storno ? "CANCELLED" : m.mapping.status;
    const changed = f.rawStatus !== m.mapping.raw || f.status !== shipmentStatus;
    await tx.fulfillment.update({
      where: { id: f.id },
      data: {
        status: superseded ? f.status : shipmentStatus,
        rawStatus: m.mapping.raw,
        vendorUid: m.vendorUid ?? f.vendorUid,
        carrier: m.carrier ?? f.carrier,
        trackingNumbers: m.trackingNumbers,
        trackingUrls: m.trackingUrls,
        shippedAt: m.shippedAt ?? f.shippedAt,
        deliveredAt: m.deliveredAt ?? f.deliveredAt,
        submittedAt: f.submittedAt ?? now,
        ...(m.returnInfo ? { returnInfo: json(m.returnInfo) } : {}),
      },
    });
    await followShipment(tx, f.orderId, m.mapping.status, `fhb:${source}`, { fulfillmentId: f.id });
    if (changed) {
      await tx.fulfillmentEvent.create({
        data: {
          accountId,
          fulfillmentId: f.id,
          occurredAt: now,
          source: `fhb:${source}`,
          rawStatus: m.mapping.raw,
          status: shipmentStatus,
          payload: json({
            trackingNumbers: m.trackingNumbers,
            vendorUid: m.vendorUid,
            ...(storno ? { stornoId: m.externalId } : {}),
          }),
        },
      });
    }
    return {
      fulfillmentId: f.id,
      variableSymbolMismatch:
        !!m.variableSymbol && !!f.variableSymbol && m.variableSymbol !== f.variableSymbol,
    };
  });
  if (!result) {
    logger.warn({ connectionId, source }, "fhb order view for a shipment the CRM does not know");
    return null;
  }
  if (m.mapping.alert === "unknown_status") {
    await raiseAlertOnce(accountId, {
      kind: "fhb_unknown_status",
      severity: "WARNING",
      title: `Unknown FHB order status "${m.mapping.raw ?? ""}" — extend the status map`,
      entityType: "Fulfillment",
      entityId: result.fulfillmentId,
    });
  } else if (storno) {
    await raiseAlertOnce(accountId, {
      kind: "fhb_order_cancelled_in_zoe",
      severity: "CRITICAL",
      isTask: true,
      title: `FHB: поръчка ${storno} е анулирана в ZOE — изпратете я отново или я откажете в Shopify`,
      entityType: "Fulfillment",
      entityId: result.fulfillmentId,
    });
  } else if (m.mapping.alert === "rejected") {
    await raiseAlertOnce(accountId, {
      kind: "fhb_order_rejected",
      severity: "CRITICAL",
      isTask: true,
      title: `FHB rejected order ${m.externalId} — needs an operator`,
      entityType: "Fulfillment",
      entityId: result.fulfillmentId,
    });
  }
  if (result.variableSymbolMismatch) {
    await raiseAlertOnce(accountId, {
      kind: "fhb_id_conflict",
      severity: "CRITICAL",
      isTask: true,
      title: `FHB order ${m.externalId} has a different variable symbol than the CRM shipment`,
      entityType: "Fulfillment",
      entityId: result.fulfillmentId,
    });
  }
  return { fulfillmentId: result.fulfillmentId, mapping: m.mapping };
}

/** Mirrors one FHB product (identity, EAN read-only, archived) and its stock. */
export async function applyFhbProductView(
  accountId: string,
  connectionId: string,
  view: FhbProductView,
  opts: { productId?: string | null; previousVendorId?: string | null; source: "PUSH" | "POLL"; now?: Date },
) {
  const p = mapFhbProductView(view);
  const now = opts.now ?? new Date();
  return withAccountTransaction(accountId, async (tx) => {
    // A rename (`new_id`) moves the existing mirror row to the new id.
    let vp = await tx.vendorProduct.findUnique({
      where: { connectionId_vendorId: { connectionId, vendorId: p.vendorId } },
    });
    if (!vp && opts.previousVendorId && opts.previousVendorId !== p.vendorId) {
      vp = await tx.vendorProduct.findUnique({
        where: { connectionId_vendorId: { connectionId, vendorId: opts.previousVendorId } },
      });
    }
    const data = {
      vendorId: p.vendorId,
      vendorCode: p.vendorCode,
      vendorEan: p.vendorEan,
      archived: p.archived,
      lastSyncAt: now,
      raw: json(view),
    };
    vp = vp
      ? await tx.vendorProduct.update({
          where: { id: vp.id },
          data: { ...data, ...(opts.productId && !vp.productId ? { productId: opts.productId } : {}) },
        })
      : await tx.vendorProduct.create({
          data: { accountId, connectionId, productId: opts.productId ?? null, ...data },
        });
    if (p.physical !== null || p.free !== null) {
      const existing = await tx.stockLevel.findUnique({ where: { vendorProductId: vp.id } });
      const physical = p.physical ?? existing?.physical ?? 0;
      const free = p.free ?? existing?.free ?? 0;
      const reserved = existing?.reserved ?? 0;
      const sellable = Math.max(0, Math.min(free, physical - reserved));
      await tx.stockLevel.upsert({
        where: { vendorProductId: vp.id },
        create: {
          accountId,
          vendorProductId: vp.id,
          physical,
          free,
          reserved,
          sellable,
          snapshotAt: now,
          source: opts.source,
        },
        update: { physical, free, sellable, snapshotAt: now, source: opts.source },
      });
    }
    return vp;
  });
}

/** Mirrors an FHB stock receipt onto our InboundShipment (status raw, received per line). */
export async function applyFhbStockReceipt(
  accountId: string,
  connectionId: string,
  view: FhbStockReceiptView,
) {
  return withAccountTransaction(accountId, async (tx) => {
    const inbound = await tx.inboundShipment.findUnique({
      where: { connectionId_externalRef: { connectionId, externalRef: view.id } },
      include: { lines: true },
    });
    if (!inbound) return null;
    await tx.inboundShipment.update({
      where: { id: inbound.id },
      data: {
        vendorId: view.id,
        status: view.status ?? inbound.status,
        tracking: view.tracking_code ?? inbound.tracking,
        raw: json(view),
      },
    });
    const ids = (view.items ?? []).map((i) => i.id);
    const vps = await tx.vendorProduct.findMany({
      where: { connectionId, vendorId: { in: ids } },
      select: { vendorId: true, productId: true },
    });
    const productOf = new Map(vps.map((v) => [v.vendorId, v.productId]));
    for (const item of view.items ?? []) {
      const productId = productOf.get(item.id);
      if (!productId || item.received == null) continue;
      await tx.inboundLine.updateMany({
        where: { inboundId: inbound.id, productId },
        data: { receivedQty: item.received },
      });
    }
    return inbound.id;
  });
}

/** Routes one transport result to the right mirror update. */
export async function applyFhbResult(accountId: string, connectionId: string, e: FhbResultEvent) {
  const meta = e.envelope.meta ?? {};
  switch (e.kind) {
    case "order":
      await applyFhbOrderView(accountId, connectionId, e.view, e.operation);
      return;
    case "order_deleted": {
      const db = accountDb(accountId);
      const f = await db.fulfillment.findUnique({
        where: { connectionId_externalId: { connectionId, externalId: e.envelope.id } },
      });
      if (!f || f.status === "CANCELLED") return;
      await withAccountTransaction(accountId, async (tx) => {
        await tx.fulfillment.update({ where: { id: f.id }, data: { status: "CANCELLED" } });
        await tx.fulfillmentEvent.create({
          data: {
            accountId,
            fulfillmentId: f.id,
            occurredAt: new Date(),
            source: "fhb:fhb.order.delete",
            rawStatus: f.rawStatus,
            status: "CANCELLED",
            payload: json({ deletedAtWarehouse: true }),
          },
        });
        // A CRM-requested cancel: the order goes to BLOCKED (never for a reroute-owned shipment).
        await warehouseCancelConfirmed(tx, {
          accountId,
          orderId: f.orderId,
          fulfillmentId: f.id,
          source: "fhb:fhb.order.delete",
        });
      });
      return;
    }
    case "product":
      await applyFhbProductView(accountId, connectionId, e.view, {
        productId: meta.productId ?? null,
        previousVendorId: e.envelope.id,
        source: "POLL",
      });
      return;
    case "receipt":
      await applyFhbStockReceipt(accountId, connectionId, e.view);
      return;
    case "receipt_deleted":
      await accountDb(accountId).inboundShipment.updateMany({
        where: { connectionId, externalRef: e.envelope.id },
        data: { status: "deleted" },
      });
      return;
    case "rejected": {
      const message = scrubText(
        `${e.error.code}: ${e.error.message} ${Object.entries(e.error.violations)
          .map(([f, c]) => `${f}=${c.join("/")}`)
          .join(" ")}`,
      );
      if (
        e.operation === "fhb.order.create" ||
        e.operation === "fhb.order.update" ||
        e.operation === "fhb.order.delete"
      ) {
        const db = accountDb(accountId);
        const f = await db.fulfillment.findUnique({
          where: { connectionId_externalId: { connectionId, externalId: e.envelope.id } },
        });
        if (!f) return;
        await withAccountTransaction(accountId, async (tx) => {
          if (e.operation === "fhb.order.create") {
            await tx.fulfillment.update({ where: { id: f.id }, data: { status: "SUBMIT_FAILED" } });
            await transition(tx, {
              orderId: f.orderId,
              to: "SUBMIT_FAILED",
              cause: "submit_failed",
              actor: { kind: "system" },
              source: "fhb:fhb.order.create",
              reason: message.slice(0, 500),
            });
          }
          await tx.fulfillmentEvent.create({
            data: {
              accountId,
              fulfillmentId: f.id,
              occurredAt: new Date(),
              source: `fhb:${e.operation}`,
              rawStatus: f.rawStatus,
              status: e.operation === "fhb.order.create" ? "SUBMIT_FAILED" : f.status,
              payload: json({ rejected: true, code: e.error.code, violations: e.error.violations }),
            },
          });
          if (e.operation === "fhb.order.delete")
            await warehouseCancelRefused(tx, {
              accountId,
              orderId: f.orderId,
              fulfillmentId: f.id,
              detail: message.slice(0, 500),
              source: "fhb:fhb.order.delete",
            });
        });
        // A vendor 400 means a pre-flight rule is missing (CLAUDE.md): make it visible.
        await raiseAlertOnce(accountId, {
          kind: "fhb_rejected_request",
          severity: "WARNING",
          isTask: true,
          title: `FHB refused ${e.operation} for ${e.envelope.id}`,
          body: message,
          entityType: "Fulfillment",
          entityId: f.id,
        });
      } else if (e.operation.startsWith("fhb.stockReceipt.")) {
        await accountDb(accountId).inboundShipment.updateMany({
          where: { connectionId, externalRef: e.envelope.id, status: "QUEUED" },
          data: { status: "SUBMIT_FAILED" },
        });
      }
      return;
    }
  }
}
