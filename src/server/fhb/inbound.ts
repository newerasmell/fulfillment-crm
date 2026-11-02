import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { payloadHash } from "@/integrations/fhb-v3/adapter";
import { buildFhbStockReceiptCreate, buildFhbStockReceiptUpdate } from "@/integrations/fhb-v3/mapper";
import { hasHardBlock, validateFhbStockReceipt } from "@/integrations/fhb-v3/validators";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { withAccountTransaction } from "@/server/db/client";
import { enqueueOutboundInTx } from "@/server/outbox/outbox";
import { assertConnectionInScope, type ScopedActor } from "./connection";
import { FhbPreflightError } from "./orders";

/**
 * FHB stock receipts (inbound, INTEGRATION_NOTES §2.5) behind the outbox. The receipt id we send is generated
 * once, stored on the InboundShipment (`externalRef`) and reused for every retry, so a timed-out create is read
 * back with GET /stock-receipt?id= instead of being sent twice. PUT and DELETE only while FHB says `created`.
 * InboundShipment.status holds FHB's raw receipt status; before FHB answered it is QUEUED (or SUBMIT_FAILED).
 */

const ReceiptInput = z.object({
  connectionId: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(50),
  lines: z
    .array(
      z.object({ productId: z.string().min(1).max(64), quantity: z.number().int().min(1).max(1_000_000) }),
    )
    .min(1)
    .max(1000),
  expectedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  trackingCode: z.string().trim().max(255).optional(),
  /** Parcel service code from GET /parcel-service. */
  deliveryService: z.string().trim().max(100).optional(),
});
export type FhbReceiptInput = z.input<typeof ReceiptInput>;

/** `IN-YYYYMMDD-XXXXXXXX`: unique, generated once per inbound, safe characters only. */
export function newReceiptRef(now = new Date()) {
  return `IN-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(5).toString("hex").toUpperCase()}`;
}

type Tx = Prisma.TransactionClient;

async function mapLines(tx: Tx, connectionId: string, lines: { productId: string; quantity: number }[]) {
  const products = await tx.product.findMany({
    where: { id: { in: lines.map((l) => l.productId) } },
    select: { id: true, sku: true },
  });
  const vps = await tx.vendorProduct.findMany({
    where: { connectionId, productId: { in: lines.map((l) => l.productId) }, archived: false },
  });
  return lines.map((l) => {
    const vp = vps.find((v) => v.productId === l.productId);
    return {
      productId: l.productId,
      label: products.find((p) => p.id === l.productId)?.sku ?? l.productId,
      vendorProductId: vp?.vendorId ?? null,
      vendorType: (vp?.raw as { type?: string } | null)?.type ?? null,
      quantity: l.quantity,
    };
  });
}

async function connectionFor(tx: Tx, actor: ScopedActor, connectionId: string) {
  const connection = await tx.fulfillmentConnection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.type !== "FHB_V3") throw new DomainError("not_found");
  assertConnectionInScope(actor, connection.companyId);
  return connection;
}

export async function createFhbStockReceipt(actor: ScopedActor, raw: FhbReceiptInput) {
  assertCan(actor.role, "inbound.manage");
  const input = ReceiptInput.parse(raw);
  const result = await withAccountTransaction(actor.accountId, async (tx) => {
    const connection = await connectionFor(tx, actor, input.connectionId);
    const externalRef = newReceiptRef();
    const lines = await mapLines(tx, connection.id, input.lines);
    const findings = validateFhbStockReceipt({
      externalRef,
      name: input.name,
      lines,
      expectedDate: input.expectedDate,
      trackingCode: input.trackingCode,
    });
    if (hasHardBlock(findings)) throw new FhbPreflightError("fhb_preflight_failed", findings);
    const inbound = await tx.inboundShipment.create({
      data: {
        accountId: actor.accountId,
        connectionId: connection.id,
        externalRef,
        status: "QUEUED",
        tracking: input.trackingCode ?? null,
        expectedAt: input.expectedDate ? new Date(`${input.expectedDate}T00:00:00Z`) : null,
        lines: {
          create: lines.map((l) => ({ productId: l.productId, expectedQty: l.quantity })),
        },
      },
    });
    const body = buildFhbStockReceiptCreate({
      externalRef,
      name: input.name,
      items: lines.map((l) => ({ id: l.vendorProductId!, quantity: l.quantity })),
      expectedDate: input.expectedDate,
      trackingCode: input.trackingCode,
      deliveryService: input.deliveryService,
    });
    const enq = await enqueueOutboundInTx(tx, {
      accountId: actor.accountId,
      connectionId: connection.id,
      operation: "fhb.stockReceipt.create",
      idempotencyKey: `fhb.stockReceipt.create:${externalRef}`,
      payload: { id: externalRef, body, meta: { inboundId: inbound.id } } as unknown as Prisma.InputJsonValue,
      createdById: actor.userId,
    });
    return { inbound, request: enq.request };
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "fhb.stock_receipt.create",
    entityType: "InboundShipment",
    entityId: result.inbound.id,
    after: {
      externalRef: result.inbound.externalRef,
      requestId: result.request.id,
      lines: input.lines.length,
    },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return result;
}

async function loadModifiable(tx: Tx, actor: ScopedActor, inboundId: string) {
  const inbound = await tx.inboundShipment.findUnique({
    where: { id: inboundId },
    include: { connection: true },
  });
  if (!inbound || inbound.connection.type !== "FHB_V3") throw new DomainError("not_found");
  assertConnectionInScope(actor, inbound.connection.companyId);
  // Documented: PUT and DELETE /stock-receipt only in state `created`.
  if (inbound.status !== "created") throw new DomainError("fhb_receipt_locked");
  return inbound;
}

export async function updateFhbStockReceipt(
  actor: ScopedActor,
  inboundId: string,
  raw: Omit<FhbReceiptInput, "connectionId">,
) {
  assertCan(actor.role, "inbound.manage");
  const input = ReceiptInput.omit({ connectionId: true }).parse(raw);
  const result = await withAccountTransaction(actor.accountId, async (tx) => {
    const inbound = await loadModifiable(tx, actor, inboundId);
    const lines = await mapLines(tx, inbound.connectionId, input.lines);
    const findings = validateFhbStockReceipt({
      externalRef: inbound.externalRef,
      name: input.name,
      lines,
      expectedDate: input.expectedDate,
      trackingCode: input.trackingCode,
    });
    if (hasHardBlock(findings)) throw new FhbPreflightError("fhb_preflight_failed", findings);
    const body = buildFhbStockReceiptUpdate({
      externalRef: inbound.externalRef,
      name: input.name,
      items: lines.map((l) => ({ id: l.vendorProductId!, quantity: l.quantity })),
      expectedDate: input.expectedDate,
      trackingCode: input.trackingCode,
      deliveryService: input.deliveryService,
    });
    await tx.inboundLine.deleteMany({ where: { inboundId: inbound.id } });
    await tx.inboundLine.createMany({
      data: lines.map((l) => ({
        accountId: actor.accountId,
        inboundId: inbound.id,
        productId: l.productId,
        expectedQty: l.quantity,
      })),
    });
    return enqueueOutboundInTx(tx, {
      accountId: actor.accountId,
      connectionId: inbound.connectionId,
      operation: "fhb.stockReceipt.update",
      idempotencyKey: `fhb.stockReceipt.update:${inbound.externalRef}:${payloadHash(body)}`,
      payload: {
        id: inbound.externalRef,
        body,
        meta: { inboundId: inbound.id },
      } as unknown as Prisma.InputJsonValue,
      createdById: actor.userId,
    });
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "fhb.stock_receipt.update",
    entityType: "InboundShipment",
    entityId: inboundId,
    after: { requestId: result.request.id },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return result;
}

export async function deleteFhbStockReceipt(actor: ScopedActor, inboundId: string) {
  assertCan(actor.role, "inbound.manage");
  const result = await withAccountTransaction(actor.accountId, async (tx) => {
    const inbound = await loadModifiable(tx, actor, inboundId);
    return enqueueOutboundInTx(tx, {
      accountId: actor.accountId,
      connectionId: inbound.connectionId,
      operation: "fhb.stockReceipt.delete",
      idempotencyKey: `fhb.stockReceipt.delete:${inbound.externalRef}`,
      payload: { id: inbound.externalRef, meta: { inboundId: inbound.id } },
      createdById: actor.userId,
    });
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "fhb.stock_receipt.delete",
    entityType: "InboundShipment",
    entityId: inboundId,
    after: { requestId: result.request.id },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return result;
}
