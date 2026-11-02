import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { buildFhbStockReceiptCreate, buildFhbStockReceiptUpdate } from "@/integrations/fhb-v3/mapper";
import { hasHardBlock, validateFhbStockReceipt } from "@/integrations/fhb-v3/validators";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { isUniqueViolation, withAccountTransaction } from "@/server/db/client";
import { enqueueOutboundInTx } from "@/server/outbox/outbox";
import { assertConnectionInScope, type ScopedActor } from "./connection";
import { FhbPreflightError } from "./orders";
import { updateRevisionKey } from "./revision";

/**
 * FHB stock receipts (inbound, INTEGRATION_NOTES §2.5) behind the outbox. The receipt id we send is derived
 * from a caller-supplied request token (generated once when the form opens, INTEGRATION_NOTES §1.1: never
 * random per call), stored on the InboundShipment (`externalRef`) and reused for every retry, so a double
 * submit returns the same receipt and a timed-out create is read back with GET /stock-receipt?id= instead of
 * being sent twice. PUT and DELETE only while FHB says `created`.
 * InboundShipment.status holds FHB's raw receipt status; before FHB answered it is QUEUED (or SUBMIT_FAILED).
 */

const RequestToken = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);

const ReceiptInput = z.object({
  connectionId: z.string().min(1).max(64),
  /** Idempotency token for this receipt, generated once by the caller (e.g. when the form opens). */
  requestToken: RequestToken,
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

/** `IN-XXXXXXXXXXXXXXXX`: deterministic per (account, connection, request token), safe characters only. */
export function receiptRefFor(accountId: string, connectionId: string, requestToken: string) {
  const h = createHash("sha256").update(`${accountId}\n${connectionId}\n${requestToken}`).digest("hex");
  return `IN-${h.slice(0, 16).toUpperCase()}`;
}

const createKey = (externalRef: string) => `fhb.stockReceipt.create:${externalRef}`;

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

type ReceiptData = Omit<z.output<typeof ReceiptInput>, "connectionId" | "requestToken">;

/** Validates, (re)writes the expected lines and queues POST /stock-receipt under the receipt's one create key. */
async function queueCreate(
  tx: Tx,
  actor: ScopedActor,
  inbound: { id: string; connectionId: string; externalRef: string },
  input: ReceiptData,
  lines: Awaited<ReturnType<typeof mapLines>>,
) {
  const body = buildFhbStockReceiptCreate({
    externalRef: inbound.externalRef,
    name: input.name,
    items: lines.map((l) => ({ id: l.vendorProductId!, quantity: l.quantity })),
    expectedDate: input.expectedDate,
    trackingCode: input.trackingCode,
    deliveryService: input.deliveryService,
  });
  return enqueueOutboundInTx(tx, {
    accountId: actor.accountId,
    connectionId: inbound.connectionId,
    operation: "fhb.stockReceipt.create",
    idempotencyKey: createKey(inbound.externalRef),
    payload: {
      id: inbound.externalRef,
      body,
      meta: { inboundId: inbound.id },
    } as unknown as Prisma.InputJsonValue,
    createdById: actor.userId,
  });
}

function check(externalRef: string, input: ReceiptData, lines: Awaited<ReturnType<typeof mapLines>>) {
  const findings = validateFhbStockReceipt({
    externalRef,
    name: input.name,
    lines,
    expectedDate: input.expectedDate,
    trackingCode: input.trackingCode,
  });
  if (hasHardBlock(findings)) throw new FhbPreflightError("fhb_preflight_failed", findings);
}

/**
 * Creates the receipt once per request token: a second call with the same token (double click, retried
 * action) returns the existing inbound and its request with `created: false` and sends nothing new.
 */
export async function createFhbStockReceipt(actor: ScopedActor, raw: FhbReceiptInput) {
  assertCan(actor.role, "inbound.manage");
  const input = ReceiptInput.parse(raw);
  const run = () =>
    withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
      const connection = await connectionFor(tx, actor, input.connectionId);
      await lockForUpdate("FulfillmentConnection", connection.id);
      const externalRef = receiptRefFor(actor.accountId, connection.id, input.requestToken);
      const existing = await tx.inboundShipment.findUnique({
        where: { connectionId_externalRef: { connectionId: connection.id, externalRef } },
      });
      if (existing) {
        const request = await tx.outboundRequest.findUniqueOrThrow({
          where: {
            connectionId_idempotencyKey: {
              connectionId: connection.id,
              idempotencyKey: createKey(externalRef),
            },
          },
        });
        return { inbound: existing, request, created: false };
      }
      const lines = await mapLines(tx, connection.id, input.lines);
      check(externalRef, input, lines);
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
      const enq = await queueCreate(tx, actor, inbound, input, lines);
      return { inbound, request: enq.request, created: true };
    });
  let result;
  try {
    result = await run();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    result = await run(); // a concurrent call with the same token won: return its rows
  }
  if (result.created)
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

/**
 * Re-submits a receipt FHB refused (SUBMIT_FAILED) or that never left (QUEUED with a refused / dry-run
 * request): same receipt id, same create key, corrected payload. Anything already sent is refused.
 */
export async function resubmitFhbStockReceipt(
  actor: ScopedActor,
  inboundId: string,
  raw: Omit<FhbReceiptInput, "connectionId" | "requestToken">,
) {
  assertCan(actor.role, "inbound.manage");
  const input = ReceiptInput.omit({ connectionId: true, requestToken: true }).parse(raw);
  const result = await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    const inbound = await tx.inboundShipment.findUnique({
      where: { id: inboundId },
      include: { connection: true },
    });
    if (!inbound || inbound.connection.type !== "FHB_V3") throw new DomainError("not_found");
    assertConnectionInScope(actor, inbound.connection.companyId);
    await lockForUpdate("FulfillmentConnection", inbound.connectionId);
    if (inbound.status !== "SUBMIT_FAILED" && inbound.status !== "QUEUED")
      throw new DomainError("fhb_already_submitted");
    const lines = await mapLines(tx, inbound.connectionId, input.lines);
    check(inbound.externalRef, input, lines);
    const enq = await queueCreate(tx, actor, inbound, input, lines);
    // The outbox re-arms only a request that never created anything at FHB (refused / failed / dry run).
    if (!enq.created) throw new DomainError("fhb_already_submitted");
    await tx.inboundShipment.update({
      where: { id: inbound.id },
      data: {
        status: "QUEUED",
        tracking: input.trackingCode ?? null,
        expectedAt: input.expectedDate ? new Date(`${input.expectedDate}T00:00:00Z`) : null,
      },
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
    return { inbound, request: enq.request };
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "fhb.stock_receipt.resubmit",
    entityType: "InboundShipment",
    entityId: inboundId,
    after: { externalRef: result.inbound.externalRef, requestId: result.request.id },
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
  raw: Omit<FhbReceiptInput, "connectionId" | "requestToken">,
) {
  assertCan(actor.role, "inbound.manage");
  const input = ReceiptInput.omit({ connectionId: true, requestToken: true }).parse(raw);
  const result = await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    const inbound = await loadModifiable(tx, actor, inboundId);
    await lockForUpdate("FulfillmentConnection", inbound.connectionId);
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
      idempotencyKey: await updateRevisionKey(
        tx,
        inbound.connectionId,
        `fhb.stockReceipt.update:${inbound.externalRef}`,
        body,
      ),
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
