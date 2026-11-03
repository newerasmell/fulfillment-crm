import { EU_OPS, type EuEffects } from "@/integrations/eushipments/adapter";
import type { AttachPdfBody } from "@/integrations/eushipments/schemas";
import { scrubText } from "@/lib/scrub";
import { withAccountTransaction } from "@/server/db/client";
import { enqueueOutboundInTx } from "@/server/outbox/outbox";
import { followShipment, transition } from "@/server/pipeline";

/**
 * What a definite euShipments answer means for our records (P3-05). Runs in the worker, after the vendor
 * answered, for real (non-test) sends only. Every effect is idempotent: it may run again after a read-back.
 */

const s = (v: unknown) => (typeof v === "string" && v ? v : null);
const PRE_SUBMIT = ["QUEUED", "SUBMITTING", "SUBMIT_FAILED", "UNKNOWN"] as const;
const ORDER_PRE_ACCEPT = ["APPROVED", "QUEUED", "SUBMITTING", "SUBMIT_FAILED"] as const;

export function euEffects(accountOf: () => Promise<string>, connectionId: string): EuEffects {
  const tx = async <T>(fn: Parameters<typeof withAccountTransaction<T>>[1]) =>
    withAccountTransaction(await accountOf(), fn);

  return {
    async orderCreated(ctx, r) {
      const fulfillmentId = s(ctx.fulfillmentId);
      const ref = s(ctx.referenceNumber);
      if (!fulfillmentId || !ref) return;
      await tx(async (db) => {
        const f = await db.fulfillment.findUnique({ where: { id: fulfillmentId } });
        if (!f) return;
        if ((PRE_SUBMIT as readonly string[]).includes(f.status)) {
          await db.fulfillment.update({
            where: { id: fulfillmentId },
            data: {
              status: "ACCEPTED",
              ...(r.orderId ? { vendorOrderId: r.orderId } : {}),
              submittedAt: f.submittedAt ?? new Date(),
            },
          });
          await db.fulfillmentEvent.create({
            data: {
              accountId: f.accountId,
              fulfillmentId,
              occurredAt: new Date(),
              source: "crm",
              status: "ACCEPTED",
              payload: { event: "submitted", orderId: r.orderId, recoveredByReadBack: r.recovered },
            },
          });
          await followShipment(db, f.orderId, "ACCEPTED", "eushipments.create", {
            onlyFrom: ORDER_PRE_ACCEPT,
          });
        }
        // Invoice: attach right after create (only possible before the AWB exists). One request per file.
        const pdf = s(ctx.invoicePdfBase64);
        if (pdf) {
          const body: AttachPdfBody = {
            orderId: null,
            referenceNumber: ref,
            files: [{ base64Attached: pdf }],
          };
          await enqueueOutboundInTx(db, {
            accountId: f.accountId,
            connectionId,
            operation: EU_OPS.attachPdf,
            idempotencyKey: `attach-pdf:${ref}`,
            payload: { body, ctx: { fulfillmentId, referenceNumber: ref } },
            fulfillmentId,
          });
        }
      });
    },

    async orderRejected(ctx, error) {
      const fulfillmentId = s(ctx.fulfillmentId);
      if (!fulfillmentId) return;
      await tx(async (db) => {
        const f = await db.fulfillment.findUnique({ where: { id: fulfillmentId } });
        if (!f || !(PRE_SUBMIT as readonly string[]).includes(f.status)) return;
        await db.fulfillment.update({ where: { id: fulfillmentId }, data: { status: "SUBMIT_FAILED" } });
        await transition(db, {
          orderId: f.orderId,
          to: "SUBMIT_FAILED",
          cause: "submit_failed",
          actor: { kind: "system" },
          source: "eushipments.create",
          reason: scrubText(error, 500),
        });
        await db.alert.create({
          data: {
            accountId: f.accountId,
            kind: "eushipments_submit_failed",
            isTask: true,
            severity: "WARNING",
            title: `euShipments rejected order ${f.externalId}`,
            body: scrubText(error, 2000),
            entityType: "Fulfillment",
            entityId: fulfillmentId,
          },
        });
      });
    },

    async orderDeleted(ctx) {
      const fulfillmentId = s(ctx.fulfillmentId);
      if (!fulfillmentId) return;
      await tx(async (db) => {
        const f = await db.fulfillment.findUnique({ where: { id: fulfillmentId } });
        if (!f || f.status === "CANCELLED") return;
        await db.fulfillment.update({ where: { id: fulfillmentId }, data: { status: "CANCELLED" } });
        await db.fulfillmentEvent.create({
          data: {
            accountId: f.accountId,
            fulfillmentId,
            occurredAt: new Date(),
            source: "crm",
            status: "CANCELLED",
            payload: { event: "deleted_at_vendor" },
          },
        });
      });
    },

    async productCreated(ctx, r) {
      const productId = s(ctx.productId);
      if (!productId || !r.refNumber) return;
      await tx(async (db) => {
        const raw = { barcodeSent: s(ctx.barcode), alreadyExisted: r.alreadyExisted };
        const existing = await db.vendorProduct.findUnique({
          where: { connectionId_vendorId: { connectionId, vendorId: r.refNumber } },
        });
        // vendorEan is a read-only mirror of the vendor's data and is never written from ours (CLAUDE.md).
        if (existing) {
          await db.vendorProduct.update({
            where: { id: existing.id },
            data: {
              productId: existing.productId ?? productId,
              ...(r.vendorProductId ? { vendorCode: r.vendorProductId } : {}),
              lastSyncAt: new Date(),
              raw,
            },
          });
        } else {
          await db.vendorProduct.create({
            data: {
              accountId: await accountOf(),
              connectionId,
              productId,
              vendorId: r.refNumber,
              vendorCode: r.vendorProductId,
              lastSyncAt: new Date(),
              raw,
            },
          });
        }
        await db.alert.updateMany({
          where: {
            kind: "eushipments_barcode_collision",
            entityType: "Product",
            entityId: productId,
            status: { not: "RESOLVED" },
          },
          data: { status: "RESOLVED", resolvedAt: new Date() },
        });
      });
    },

    async productRejected(ctx, error, barcodeCollision) {
      const productId = s(ctx.productId);
      if (!productId) return;
      const refNumber = s(ctx.refNumber);
      await tx(async (db) => {
        await db.alert.create({
          data: {
            accountId: await accountOf(),
            kind: barcodeCollision ? "eushipments_barcode_collision" : "eushipments_product_rejected",
            isTask: true,
            severity: "WARNING",
            title: barcodeCollision
              ? `euShipments: barcode ${s(ctx.barcode) ?? ""} is already used in their system`
              : `euShipments rejected product ${refNumber ?? ""}`,
            body: barcodeCollision
              ? `The barcode is not unique across euShipments (possibly the same EAN under another of our companies). ` +
                `Nothing was created. Re-queue the product with an internal barcode, e.g. "${refNumber ?? "the SKU"}". ` +
                `Vendor answer: ${scrubText(error, 500)}`
              : scrubText(error, 2000),
            entityType: "Product",
            entityId: productId,
          },
        });
      });
    },

    async requestCreated(ctx, r) {
      const inboundId = s(ctx.inboundId);
      if (!inboundId) return;
      await tx((db) =>
        db.inboundShipment.updateMany({
          where: { id: inboundId },
          data: { vendorId: r.requestId, status: "CREATED" },
        }),
      );
    },

    async requestUncertain(ctx) {
      const inboundId = s(ctx.inboundId);
      if (!inboundId) return;
      await tx((db) =>
        db.inboundShipment.updateMany({
          where: { id: inboundId, vendorId: null },
          data: { status: "UNCERTAIN" },
        }),
      );
    },

    async requestRejected(ctx, error) {
      const inboundId = s(ctx.inboundId);
      if (!inboundId) return;
      await tx((db) =>
        db.inboundShipment.updateMany({
          where: { id: inboundId, vendorId: null },
          data: { status: "FAILED", raw: { error: scrubText(error, 1000) } },
        }),
      );
    },

    async transferCreated(ctx, r) {
      const transferId = s(ctx.transferId);
      if (!transferId) return;
      await tx((db) =>
        db.eushipmentsTransfer.updateMany({
          where: { id: transferId },
          data: { status: "CREATED", ...(r.protocolId ? { protocolId: r.protocolId } : {}) },
        }),
      );
    },

    async transferRejected(ctx) {
      const transferId = s(ctx.transferId);
      if (!transferId) return;
      // The vendor's reason stays on the outbox request (lastError / lastResponse).
      await tx((db) =>
        db.eushipmentsTransfer.updateMany({
          where: { id: transferId, status: { not: "CREATED" } },
          data: { status: "FAILED" },
        }),
      );
    },

    async pdfAttached(ctx, r) {
      const fulfillmentId = s(ctx.fulfillmentId);
      if (!fulfillmentId) return;
      await tx(async (db) => {
        const f = await db.fulfillment.findUnique({
          where: { id: fulfillmentId },
          select: { accountId: true },
        });
        if (!f) return;
        await db.fulfillmentEvent.create({
          data: {
            accountId: f.accountId,
            fulfillmentId,
            occurredAt: new Date(),
            source: "crm",
            payload: { event: "invoice_attached", pdfId: r.pdfId },
          },
        });
      });
    },
  };
}
