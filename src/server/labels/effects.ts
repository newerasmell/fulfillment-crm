import type { CrmOrderStatus, Prisma } from "@/generated/prisma/client";
import type { AwbResultEvent } from "@/integrations/eushipments/awb-adapter";
import type { JoyResultEvent } from "@/integrations/fhb-joy/adapter";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { followShipment, transition } from "@/server/pipeline";
import { storeLabel } from "./storage";

/**
 * What a definite Joy / euShipments AWB answer means for our records (worker side, real sends only). Every effect
 * is idempotent: a read-back may run it again (the label is stored once per answer; statuses only move forward).
 */

type Tx = Prisma.TransactionClient;
const s = (v: unknown) => (typeof v === "string" && v ? v : null);
/** Shipment states a create answer may still move (anything later came from tracking already). */
const PRE_ACCEPT: CrmOrderStatus[] = ["QUEUED", "SUBMITTING", "SUBMIT_FAILED", "UNKNOWN"];
const ORDER_PRE_ACCEPT = ["APPROVED", "QUEUED", "SUBMITTING", "SUBMIT_FAILED"] as const;
const VOIDABLE_ORDER = [
  "APPROVED",
  "QUEUED",
  "SUBMITTING",
  "SUBMIT_FAILED",
  "ACCEPTED",
  "PROCESSING",
  "BLOCKED",
  "EXCEPTION",
] as const;

async function loadF(tx: Tx, ctx: Record<string, unknown>) {
  const id = s(ctx.fulfillmentId);
  if (!id) return null;
  return tx.fulfillment.findUnique({ where: { id } });
}

async function event(
  tx: Tx,
  f: { accountId: string; id: string },
  source: string,
  payload: Record<string, unknown>,
  status?: CrmOrderStatus,
) {
  await tx.fulfillmentEvent.create({
    data: {
      accountId: f.accountId,
      fulfillmentId: f.id,
      occurredAt: new Date(),
      source,
      status: status ?? null,
      payload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue,
    },
  });
}

async function task(
  tx: Tx,
  f: { accountId: string; id: string },
  kind: string,
  severity: "WARNING" | "CRITICAL",
  title: string,
  body: string,
) {
  await tx.alert.create({
    data: {
      accountId: f.accountId,
      kind,
      isTask: true,
      severity,
      title: title.slice(0, 300),
      body: scrubText(body, 2000),
      entityType: "Fulfillment",
      entityId: f.id,
    },
  });
}

async function accepted(
  tx: Tx,
  f: NonNullable<Awaited<ReturnType<typeof loadF>>>,
  source: string,
  data: Prisma.FulfillmentUpdateInput,
  payload: Record<string, unknown>,
) {
  if (!PRE_ACCEPT.includes(f.status)) return false;
  await tx.fulfillment.update({
    where: { id: f.id },
    data: { status: "ACCEPTED", submittedAt: f.submittedAt ?? new Date(), ...data },
  });
  await event(tx, f, "crm", payload, "ACCEPTED");
  await followShipment(tx, f.orderId, "ACCEPTED", source, { onlyFrom: ORDER_PRE_ACCEPT });
  return true;
}

async function refused(
  tx: Tx,
  f: NonNullable<Awaited<ReturnType<typeof loadF>>>,
  source: string,
  kind: string,
  title: string,
  error: string,
  severity: "WARNING" | "CRITICAL" = "WARNING",
) {
  if (!PRE_ACCEPT.includes(f.status)) return;
  await tx.fulfillment.update({ where: { id: f.id }, data: { status: "SUBMIT_FAILED" } });
  await event(tx, f, "crm", { event: "label_rejected", error: scrubText(error, 500) }, "SUBMIT_FAILED");
  await transition(tx, {
    orderId: f.orderId,
    to: "SUBMIT_FAILED",
    cause: "submit_failed",
    actor: { kind: "system" },
    source,
    reason: scrubText(error, 500),
  });
  await task(tx, f, kind, severity, title, error);
}

async function voided(
  tx: Tx,
  f: NonNullable<Awaited<ReturnType<typeof loadF>>>,
  source: string,
  what: string,
) {
  if (f.status === "CANCELLED") return;
  await tx.fulfillment.update({ where: { id: f.id }, data: { status: "CANCELLED", rawStatus: what } });
  await event(tx, f, "crm", { event: what }, "CANCELLED");
  await followShipment(tx, f.orderId, "CANCELLED", source, { onlyFrom: VOIDABLE_ORDER });
}

export function joyEffects(accountOf: () => Promise<string>, connectionId: string) {
  return async (e: JoyResultEvent) => {
    const accountId = await accountOf();
    await withAccountTransaction(accountId, async (tx, { lockKey }) => {
      await lockKey(`labels:fulfillment:${s(e.ctx.fulfillmentId) ?? e.id}`);
      const f = await loadF(tx, e.ctx);
      if (!f) return;
      switch (e.kind) {
        case "created": {
          const tracking = [...new Set([...f.trackingNumbers, ...e.tracking])];
          const moved = await accepted(
            tx,
            f,
            "joy.create",
            { trackingNumbers: tracking, rawStatus: f.rawStatus ?? "pending" },
            { event: "label_created", tracking: e.tracking, recoveredByReadBack: e.recovered },
          );
          // One stored label per create answer; a repeated read-back does not add copies once one exists.
          const hasLabel = !!f.labelFileKey;
          if (e.labelBase64 && (!hasLabel || moved)) {
            try {
              await storeLabel(tx, {
                accountId,
                connectionId,
                fulfillmentId: f.id,
                source: e.recovered ? "joy.reprint" : "joy.create",
                base64: e.labelBase64,
              });
            } catch (err) {
              await task(
                tx,
                f,
                "labels_label_unreadable",
                "WARNING",
                `Joy label for ${f.externalId} could not be stored`,
                String((err as Error).message),
              );
            }
          } else if (!e.labelBase64 && !hasLabel) {
            await task(
              tx,
              f,
              "labels_label_missing",
              "WARNING",
              `Joy shipment ${f.externalId} exists, but its label could not be fetched`,
              "The shipment is at FHB Joy (found by read-back). Reprint was refused (more than 5 days, or printing unavailable). Print the label in ZOE.",
            );
          }
          return;
        }
        case "create_rejected":
          return refused(
            tx,
            f,
            "joy.create",
            e.idConflict ? "labels_joy_id_conflict" : "labels_joy_rejected",
            e.idConflict
              ? `FHB Joy id ${f.externalId} belongs to another shipment — no label was created`
              : `FHB Joy refused label ${f.externalId}`,
            `${e.field ? `field ${e.field}: ` : ""}${e.error}`,
            e.idConflict ? "CRITICAL" : "WARNING",
          );
        case "voided":
          return voided(tx, f, "joy.reject", "label_rejected_at_vendor");
        case "void_refused":
          await event(tx, f, "crm", { event: "label_reject_refused", error: scrubText(e.error, 300) });
          return;
      }
    });
  };
}

export function awbEffects(accountOf: () => Promise<string>, connectionId: string) {
  return async (e: AwbResultEvent) => {
    const accountId = await accountOf();
    await withAccountTransaction(accountId, async (tx, { lockKey }) => {
      await lockKey(`labels:fulfillment:${s(e.ctx.fulfillmentId) ?? "?"}`);
      const f = await loadF(tx, e.ctx);
      if (!f) return;
      switch (e.kind) {
        case "created":
          await accepted(
            tx,
            f,
            "eushipments.awb",
            {
              vendorOrderId: e.awb,
              ...(e.vendorId ? { vendorUid: e.vendorId } : {}),
              trackingNumbers: [...new Set([...f.trackingNumbers, e.awb])],
            },
            { event: "awb_created", awb: e.awb, barcode: e.barcode, packagesBarcodes: e.packagesBarcodes },
          );
          // The label itself is fetched by the labels sweep (print/{awb}, a read call).
          return;
        case "pre_created":
          await accepted(
            tx,
            f,
            "eushipments.preAwb",
            { vendorOrderId: e.orderId },
            { event: "pre_awb_created", orderId: e.orderId },
          );
          return;
        case "create_rejected":
          return refused(
            tx,
            f,
            "eushipments.awb",
            "labels_awb_rejected",
            `euShipments refused AWB ${f.externalId}`,
            e.error,
          );
        case "uncertain":
          await event(tx, f, "crm", { event: "awb_outcome_unknown" });
          await tx.fulfillment.update({ where: { id: f.id }, data: { rawStatus: "outcome unknown" } });
          return;
        case "deleted":
          await tx.eushipmentsTracking.updateMany({
            where: { fulfillmentId: f.id },
            data: { stopPolling: true },
          });
          await tx.manualShipment.updateMany({
            where: { fulfillmentId: f.id },
            data: { stopTracking: true },
          });
          return voided(tx, f, "eushipments.awb.delete", "awb_deleted");
        case "delete_refused":
          await event(tx, f, "crm", { event: "awb_delete_refused", error: scrubText(e.error, 300) });
          return;
      }
    });
    void connectionId;
  };
}

/** The vendor acted, but our records could not follow: a CRITICAL operator task, never only a log line. */
export function labelEffectFailed(accountOf: () => Promise<string>, vendor: "FHB Joy" | "euShipments") {
  return async (e: { kind: string; ctx: Record<string, unknown> }, error: string) => {
    const accountId = await accountOf();
    const fid = s(e.ctx.fulfillmentId);
    try {
      await accountDb(accountId).alert.create({
        data: {
          accountId,
          kind: "labels_effect_failed",
          isTask: true,
          severity: "CRITICAL",
          title: `${vendor} answered (${e.kind}), but the CRM could not record it`,
          body: scrubText(
            `Shipment ${fid ?? "?"}. Check the vendor panel and fix the CRM record by hand. Error: ${error}`,
            2000,
          ),
          entityType: "Fulfillment",
          entityId: fid ?? "unknown",
        },
      });
    } catch (err) {
      logger.error({ err: scrubText(String((err as Error).message)) }, "label effect alert failed");
    }
  };
}
