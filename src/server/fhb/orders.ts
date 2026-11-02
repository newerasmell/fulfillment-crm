import { Prisma } from "@/generated/prisma/client";
import {
  buildFhbOrderCreate,
  buildFhbOrderUpdate,
  fhbOrderExternalId,
  MAX_VARIABLE_SYMBOL,
  type FhbOrderDraft,
} from "@/integrations/fhb-v3/mapper";
import { normalisePhoneE164 } from "@/integrations/fhb-v3/phone";
import { isFhbOrderEditable } from "@/integrations/fhb-v3/status-map";
import {
  hasHardBlock,
  validateFhbOrder,
  type FhbOrderLineCheck,
  type ValidationFinding,
} from "@/integrations/fhb-v3/validators";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { isUniqueViolation, withAccountTransaction } from "@/server/db/client";
import { enqueueOutboundInTx } from "@/server/outbox/outbox";
import { queueGate } from "@/server/pipeline";
import { fhbOrderNotificationUrls, publicBaseUrl } from "./callback-token";
import type { ScopedActor } from "./connection";
import { updateRevisionKey } from "./revision";

/**
 * Sending an order to FHB (INTEGRATION_NOTES §2.1, §2.3, §5). Everything happens in ONE account transaction:
 * pre-flight validation, the Fulfillment row with its deterministic external id and a variable symbol from
 * the connection's sequence, and the outbox row. Nothing reaches FHB here — the worker's outbox sender does
 * that under the connection's liveMode. A hard finding aborts the whole transaction (no symbol is consumed).
 *
 * Duplicate guard, in layers: Fulfillment is unique on (connection, externalId) and (connection, variableSymbol);
 * the outbox is unique on (connection, idempotencyKey) and never re-sends a SENT/UNCERTAIN request; the sender
 * reads back GET /order?id= before any retry.
 */

export class FhbPreflightError extends DomainError {
  constructor(
    code: "fhb_preflight_failed" | "fhb_preflight_needs_ack",
    public readonly findings: ValidationFinding[],
  ) {
    super(code);
    this.name = "FhbPreflightError";
  }
}

export interface SubmitFhbOrderInput {
  orderId: string;
  connectionId: string;
  parcelService?: string | null;
  /** The parcel service delivers to a pick-up point (needs `deliveryPoint`). */
  pickupPoint?: boolean;
  deliveryPoint?: string | null;
  note?: string | null;
  /** The operator saw the soft warnings and wants to send anyway. */
  acknowledgeWarnings?: boolean;
  /** Stock older than this is a warning (default 1 h). */
  stockMaxAgeMs?: number;
}

/** Shipments in these states block a new submission of the same order to the same connection. */
const ACTIVE = [
  "QUEUED",
  "SUBMITTING",
  "ACCEPTED",
  "PROCESSING",
  "SHIPPED",
  "DELIVERED",
  "COD_PAID",
  "RETURNING",
  "RETURN_RECEIVED",
  "EXCEPTION",
  "BLOCKED",
  "UNKNOWN",
] as const;

interface StoredAddress {
  name?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  zip?: string | null;
  countryCode?: string | null;
  phone?: string | null;
}

const toNumber = (d: Prisma.Decimal | null | undefined) => (d == null ? null : Number(d.toString()));
const round2 = (v: number) => Math.round(v * 100) / 100;

type Tx = Prisma.TransactionClient;

/**
 * Loads everything the pre-flight needs and runs the FHB validators. Pure reads inside the caller's tx; no
 * permission or scope check (callers do that). Never throws on findings: prepare() and the validator engine's
 * preview (previewFhbOrderFindings) decide what a finding means.
 */
async function fhbPreflight(
  tx: Tx,
  accountId: string,
  input: SubmitFhbOrderInput,
  ids: { externalId: string; variableSymbol: string; fulfillmentId: string },
  opts: {
    duplicate: boolean;
    /**
     * Update of an order FHB already holds: its own reservation is already taken off FHB's free_quantity
     * (INTEGRATION_NOTES §2.2), so credit it back per CRM product — but only against stock snapshots taken
     * after the order reached FHB (an older snapshot does not include the reservation yet).
     */
    reserved?: { byProduct: Map<string, number>; since: Date | null };
  },
) {
  const order = await tx.order.findUnique({
    where: { id: input.orderId },
    include: { lines: true },
  });
  if (!order) throw new DomainError("not_found");
  const connection = await tx.fulfillmentConnection.findUniqueOrThrow({ where: { id: input.connectionId } });

  const addr = (order.shippingAddress ?? {}) as StoredAddress;
  const country = addr.countryCode?.toUpperCase() ?? order.countryCode ?? null;
  const setting = country
    ? await tx.countrySetting.findUnique({
        where: { accountId_country: { accountId: accountId, country } },
      })
    : null;
  const localCurrency = setting?.currency?.toUpperCase() ?? null;

  // Product mapping for this connection and the mirrored stock.
  const productIds = [...new Set(order.lines.map((l) => l.productId).filter((x): x is string => !!x))];
  const vps = await tx.vendorProduct.findMany({
    where: { connectionId: connection.id, productId: { in: productIds } },
    include: { stockLevel: true },
    orderBy: { archived: "asc" },
  });
  const vpOf = new Map<string, (typeof vps)[number]>();
  for (const vp of vps) if (vp.productId && !vpOf.has(vp.productId)) vpOf.set(vp.productId, vp);

  const lineChecks: FhbOrderLineCheck[] = order.lines
    .filter((l) => l.quantity > 0)
    .map((l) => {
      const vp = l.productId ? vpOf.get(l.productId) : undefined;
      const free = vp?.stockLevel?.free ?? null;
      const snap = vp?.stockLevel?.snapshotAt ?? null;
      const credit =
        opts.reserved && l.productId && snap && (!opts.reserved.since || snap >= opts.reserved.since)
          ? (opts.reserved.byProduct.get(l.productId) ?? 0)
          : 0;
      return {
        label: l.sku ?? l.title,
        quantity: l.quantity,
        vendorProductId: vp?.vendorId ?? null,
        vendorActive: !!vp && !vp.archived && !!vp.lastSyncAt,
        freeQuantity: free === null ? null : free + credit,
        stockSnapshotAt: snap,
      };
    });

  // COD and declared value go in the destination's local currency (never converted with a made-up rate).
  const isCod = order.paymentMethod === "COD";
  let codAmount: number | null = null;
  let codCurrency: string | null = order.currency;
  if (isCod && localCurrency) {
    if (order.currency.toUpperCase() === localCurrency)
      codAmount = toNumber(order.codAmount) ?? toNumber(order.total);
    else if (order.codLocalCurrency?.toUpperCase() === localCurrency && order.codLocalAmount != null) {
      codAmount = toNumber(order.codLocalAmount);
      codCurrency = localCurrency;
    }
    if (codAmount !== null && codCurrency === order.currency) codCurrency = localCurrency;
  }
  let value: number | null = null;
  if (localCurrency && order.currency.toUpperCase() === localCurrency) value = toNumber(order.total);
  else if (localCurrency && order.codLocalCurrency?.toUpperCase() === localCurrency && order.codRate != null)
    value = round2(Number(order.total.toString()) * Number(order.codRate.toString()));
  const valueNotConverted = value === null;

  const street = [addr.address1, addr.address2].filter((x) => x && x.trim()).join(", ") || null;
  const phone = order.phone ?? addr.phone ?? null;
  const findings = validateFhbOrder({
    externalId: ids.externalId,
    variableSymbol: ids.variableSymbol,
    country,
    name: addr.name ?? order.customerName ?? null,
    street,
    city: addr.city ?? null,
    zip: addr.zip ?? null,
    email: order.email,
    phone,
    lines: lineChecks,
    isCod,
    codAmount,
    codCurrency,
    localCurrency,
    requiresDeliveryPoint: !!input.pickupPoint,
    deliveryPoint: input.deliveryPoint ?? null,
    duplicateExternalId: opts.duplicate,
    note: input.note ?? null,
    customerNote: order.note,
    riskLevel: ((order.risk ?? {}) as { recommendation?: string }).recommendation ?? null,
    valueNotConverted,
    stockMaxAgeMs: input.stockMaxAgeMs,
  });
  return { order, connection, findings, addr, street, country, phone, lineChecks, isCod, codAmount, value };
}

/** The FHB order draft from a pre-flight result (only valid when the pre-flight has no hard block). */
function fhbDraft(
  pre: Awaited<ReturnType<typeof fhbPreflight>>,
  input: SubmitFhbOrderInput,
  ids: { externalId: string; variableSymbol: string },
  notification: FhbOrderDraft["notification"],
): FhbOrderDraft {
  const { order, addr, street, country, phone, lineChecks, isCod, codAmount, value } = pre;
  return {
    externalId: ids.externalId,
    variableSymbol: ids.variableSymbol,
    address: {
      name: (addr.name ?? order.customerName)!,
      street: street!,
      city: addr.city!,
      zip: addr.zip!,
      province: addr.province ?? null,
      country: country!,
    },
    email: order.email!,
    phone: normalisePhoneE164(phone, country)!,
    items: lineChecks.map((l) => ({ id: l.vendorProductId!, quantity: l.quantity })),
    cod: isCod ? codAmount : null,
    value,
    parcelService: input.parcelService ?? null,
    deliveryPoint: input.deliveryPoint ?? null,
    note: input.note ?? null,
    notification,
  };
}

/** Pre-flight + the FHB draft. A hard finding (or an unacknowledged soft one) aborts with FhbPreflightError. */
async function prepare(
  tx: Tx,
  actor: ScopedActor,
  input: SubmitFhbOrderInput,
  ids: { externalId: string; variableSymbol: string; fulfillmentId: string },
  opts: Parameters<typeof fhbPreflight>[4],
) {
  const pre = await fhbPreflight(tx, actor.accountId, input, ids, opts);
  const { order, connection, findings } = pre;
  if (hasHardBlock(findings)) throw new FhbPreflightError("fhb_preflight_failed", findings);
  if (findings.length && !input.acknowledgeWarnings)
    throw new FhbPreflightError("fhb_preflight_needs_ack", findings);

  const draft = fhbDraft(
    pre,
    input,
    ids,
    fhbOrderNotificationUrls(connection.id, ids.fulfillmentId, publicBaseUrl()),
  );
  return { order, connection, findings, draft };
}

async function loadScoped(tx: Tx, actor: ScopedActor, orderId: string, connectionId: string) {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { id: true, companyId: true, number: true, store: { select: { code: true } } },
  });
  if (!order || (actor.companyScope && !actor.companyScope.includes(order.companyId ?? ""))) {
    throw new DomainError("not_found");
  }
  const connection = await tx.fulfillmentConnection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.type !== "FHB_V3") throw new DomainError("not_found");
  if (!connection.enabled) throw new DomainError("connection_disabled");
  return { order, connection };
}

/**
 * Queues POST /order for one order. Returns the shipment, the outbox request and the soft findings the operator
 * acknowledged. Re-submitting after a refusal (SUBMIT_FAILED) or a DRY_RUN re-arms the same request with a
 * fresh payload and keeps the same external id and variable symbol.
 */
export async function submitFhbOrder(actor: ScopedActor, input: SubmitFhbOrderInput) {
  assertCan(actor.role, "orders.fulfill");
  const run = () =>
    withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
      const { order, connection } = await loadScoped(tx, actor, input.orderId, input.connectionId);
      if (!order.store?.code) throw new DomainError("fhb_no_store_code");
      // Serialises submissions per connection: the variable-symbol sequence and the duplicate checks below.
      await lockForUpdate("FulfillmentConnection", connection.id);

      const previous = await tx.fulfillment.findMany({
        where: { orderId: order.id, connectionId: connection.id },
        orderBy: { createdAt: "asc" },
      });
      const active = previous.find((p) => (ACTIVE as readonly string[]).includes(p.status));
      let fulfillment = previous.find((p) => p.status === "SUBMIT_FAILED" || p.status === "QUEUED") ?? null;
      if (active && active.status !== "QUEUED") throw new DomainError("fhb_already_submitted");
      // The pipeline is the gate: only an APPROVED / SUBMIT_FAILED order is queued (strict, before anything is
      // written). The order row lock serialises this with a concurrent cancel, hold or check.
      await lockForUpdate("Order", order.id);
      await queueGate(tx, {
        orderId: order.id,
        userId: actor.userId,
        source: "fhb.submit",
        connectionId: connection.id,
        rearmQueued: fulfillment?.status === "QUEUED",
      });

      if (!fulfillment) {
        // A cancelled shipment keeps its id at FHB: a reship gets `-2`, `-3`, ….
        const externalId = fhbOrderExternalId(order.store.code, order.number, previous.length + 1);
        // Allocated atomically AFTER the lock: the connection row read by loadScoped() may be stale by now
        // (a concurrent submit committed its increment while we waited for the lock).
        const bumped = await tx.fulfillmentConnection.update({
          where: { id: connection.id },
          data: { variableSymbolNext: { increment: 1 } },
          select: { variableSymbolNext: true },
        });
        const next = BigInt(bumped.variableSymbolNext) - 1n;
        if (next > MAX_VARIABLE_SYMBOL) throw new DomainError("fhb_variable_symbol_exhausted");
        fulfillment = await tx.fulfillment.create({
          data: {
            accountId: actor.accountId,
            orderId: order.id,
            connectionId: connection.id,
            externalId,
            variableSymbol: next.toString(),
            status: "QUEUED",
          },
        });
      }
      const duplicate = !!(await tx.fulfillment.findFirst({
        where: {
          connectionId: connection.id,
          id: { not: fulfillment.id },
          OR: [{ externalId: fulfillment.externalId }, { variableSymbol: fulfillment.variableSymbol }],
        },
        select: { id: true },
      }));
      const prepared = await prepare(
        tx,
        actor,
        input,
        {
          externalId: fulfillment.externalId,
          variableSymbol: fulfillment.variableSymbol!,
          fulfillmentId: fulfillment.id,
        },
        { duplicate },
      );
      const body = buildFhbOrderCreate(prepared.draft);
      await tx.fulfillment.update({
        where: { id: fulfillment.id },
        data: {
          status: "QUEUED",
          carrier: input.parcelService ?? null,
          deliveryPoint: input.deliveryPoint ? { code: input.deliveryPoint } : undefined,
        },
      });
      await tx.fulfillmentLine.deleteMany({ where: { fulfillmentId: fulfillment.id } });
      await tx.fulfillmentLine.createMany({
        data: prepared.order.lines
          .filter((l) => l.quantity > 0)
          .map((l) => ({
            accountId: actor.accountId,
            fulfillmentId: fulfillment.id,
            orderLineId: l.id,
            quantity: l.quantity,
          })),
      });
      const { request, created } = await enqueueOutboundInTx(tx, {
        accountId: actor.accountId,
        connectionId: connection.id,
        operation: "fhb.order.create",
        idempotencyKey: `fhb.order.create:${fulfillment.externalId}`,
        payload: { id: body.id, body } as unknown as Prisma.InputJsonValue,
        fulfillmentId: fulfillment.id,
        createdById: actor.userId,
      });
      if (!created) throw new DomainError("fhb_already_submitted");
      return { fulfillment, request, findings: prepared.findings, liveMode: connection.liveMode };
    });
  let result;
  try {
    result = await run();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    result = await run(); // a concurrent submit won the unique key: re-evaluate against its rows
  }
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "fhb.order.submit",
    entityType: "Fulfillment",
    entityId: result.fulfillment.id,
    after: {
      orderId: input.orderId,
      connectionId: input.connectionId,
      externalId: result.fulfillment.externalId,
      variableSymbol: result.fulfillment.variableSymbol,
      requestId: result.request.id,
      liveMode: result.liveMode,
      acknowledged: result.findings.map((f) => f.code),
    },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return result;
}

/** The body of the latest queued PUT for this order, if any (its note is what FHB holds now). */
async function latestOrderBody(tx: Tx, connectionId: string, externalId: string) {
  const row = await tx.outboundRequest.findFirst({
    where: { connectionId, idempotencyKey: { startsWith: `fhb.order.update:${externalId}:` } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { payload: true },
  });
  return (row?.payload as { body?: { note?: string } } | null)?.body ?? null;
}

async function loadEditable(tx: Tx, actor: ScopedActor, fulfillmentId: string) {
  const f = await tx.fulfillment.findUnique({
    where: { id: fulfillmentId },
    include: { connection: true, order: { select: { companyId: true } } },
  });
  if (!f || f.connection.type !== "FHB_V3") throw new DomainError("not_found");
  if (actor.companyScope && !actor.companyScope.includes(f.order.companyId ?? ""))
    throw new DomainError("not_found");
  // Documented: PUT/DELETE /order only while pending. new/imported/b2b_new are treated as locked.
  if (!isFhbOrderEditable(f.rawStatus)) throw new DomainError("fhb_order_locked");
  return f;
}

/** Queues PUT /order with the order's current CRM data (only while FHB says `pending`). */
export async function updateFhbOrder(
  actor: ScopedActor,
  fulfillmentId: string,
  input: Omit<SubmitFhbOrderInput, "orderId" | "connectionId"> = {},
) {
  assertCan(actor.role, "orders.cancelAtWarehouse");
  const result = await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    const f = await loadEditable(tx, actor, fulfillmentId);
    await lockForUpdate("FulfillmentConnection", f.connectionId);
    // PUT /order "rewrites" the order with the same parameters as POST (fhb-kika-v3.md): whatever the caller
    // does not change must be re-sent as created, or FHB drops the carrier, pick-up point and note.
    const created = await tx.outboundRequest.findUnique({
      where: {
        connectionId_idempotencyKey: {
          connectionId: f.connectionId,
          idempotencyKey: `fhb.order.create:${f.externalId}`,
        },
      },
      select: { payload: true },
    });
    const lastBody = await latestOrderBody(tx, f.connectionId, f.externalId);
    const createdBody = (created?.payload as { body?: { note?: string } } | null)?.body;
    const storedPoint = (f.deliveryPoint as { code?: string } | null)?.code ?? null;
    const deliveryPoint = input.deliveryPoint !== undefined ? input.deliveryPoint : storedPoint;
    const merged: SubmitFhbOrderInput = {
      ...input,
      orderId: f.orderId,
      connectionId: f.connectionId,
      parcelService: input.parcelService !== undefined ? input.parcelService : f.carrier,
      deliveryPoint,
      // A pick-up-point order stays one unless the caller says otherwise (e.g. switching to home delivery).
      pickupPoint: input.pickupPoint ?? (!!storedPoint || !!deliveryPoint),
      note:
        input.note !== undefined
          ? input.note
          : lastBody
            ? (lastBody.note ?? null)
            : (createdBody?.note ?? null),
    };
    const fLines = await tx.fulfillmentLine.findMany({
      where: { fulfillmentId: f.id },
      include: { orderLine: { select: { productId: true } } },
    });
    const byProduct = new Map<string, number>();
    for (const l of fLines)
      if (l.orderLine?.productId)
        byProduct.set(l.orderLine.productId, (byProduct.get(l.orderLine.productId) ?? 0) + l.quantity);
    const prepared = await prepare(
      tx,
      actor,
      merged,
      { externalId: f.externalId, variableSymbol: f.variableSymbol!, fulfillmentId: f.id },
      { duplicate: false, reserved: { byProduct, since: f.submittedAt } },
    );
    const body = buildFhbOrderUpdate(prepared.draft);
    const prefix = `fhb.order.update:${f.externalId}`;
    const enq = await enqueueOutboundInTx(tx, {
      accountId: actor.accountId,
      connectionId: f.connectionId,
      operation: "fhb.order.update",
      idempotencyKey: await updateRevisionKey(tx, f.connectionId, prefix, body),
      payload: { id: f.externalId, body } as unknown as Prisma.InputJsonValue,
      fulfillmentId: f.id,
      createdById: actor.userId,
    });
    await tx.fulfillment.update({
      where: { id: f.id },
      data: {
        carrier: merged.parcelService ?? null,
        deliveryPoint: deliveryPoint ? { code: deliveryPoint } : Prisma.DbNull,
      },
    });
    return enq;
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "fhb.order.update",
    entityType: "Fulfillment",
    entityId: fulfillmentId,
    after: { requestId: result.request.id },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return result;
}

/** "Cancel at warehouse": queues DELETE /order (only while FHB says `pending`). Never done by the AI. */
export async function cancelFhbOrder(actor: ScopedActor, fulfillmentId: string) {
  assertCan(actor.role, "orders.cancelAtWarehouse");
  const result = await withAccountTransaction(actor.accountId, async (tx) => {
    const f = await loadEditable(tx, actor, fulfillmentId);
    return enqueueOutboundInTx(tx, {
      accountId: actor.accountId,
      connectionId: f.connectionId,
      operation: "fhb.order.delete",
      idempotencyKey: `fhb.order.delete:${f.externalId}`,
      payload: { id: f.externalId },
      fulfillmentId: f.id,
      createdById: actor.userId,
    });
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "fhb.order.cancel",
    entityType: "Fulfillment",
    entityId: fulfillmentId,
    after: { requestId: result.request.id },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return result;
}

const previewFinding = (code: string, bg: string, en: string): ValidationFinding => ({
  code,
  severity: "hard",
  field: null,
  message_bg: bg,
  message_en: en,
});

/**
 * What submitFhbOrder would do for this order, without consuming a variable symbol or queueing anything:
 * its findings and, when nothing blocks, the POST /order body it would build (P4-01 validator engine, P4-04
 * payload preview). Uses the external id the next submission would get and a placeholder variable symbol
 * from the connection's sequence (validated for shape only). The preview body has no notification URLs:
 * those carry callback tokens, are added at submit time and never go to the browser.
 */
async function fhbPreview(accountId: string, input: Omit<SubmitFhbOrderInput, "acknowledgeWarnings">) {
  return withAccountTransaction(accountId, async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      select: { id: true, number: true, store: { select: { code: true } } },
    });
    if (!order) throw new DomainError("not_found");
    const connection = await tx.fulfillmentConnection.findUnique({ where: { id: input.connectionId } });
    if (!connection || connection.type !== "FHB_V3") throw new DomainError("not_found");
    const out: ValidationFinding[] = [];
    if (!connection.enabled)
      out.push(
        previewFinding(
          "fhb.connection.disabled",
          "Връзката към склада е изключена.",
          "The warehouse connection is disabled.",
        ),
      );
    if (!order.store?.code) {
      out.push(
        previewFinding(
          "fhb.order.no_store_code",
          "Поръчката няма магазин с код — не може да получи номер за склада.",
          "The order has no store code, so it cannot get a warehouse order id.",
        ),
      );
      return { findings: out, body: null };
    }
    const previous = await tx.fulfillment.findMany({
      where: { orderId: order.id, connectionId: connection.id },
      orderBy: { createdAt: "asc" },
    });
    const active = previous.find(
      (p) => (ACTIVE as readonly string[]).includes(p.status) && p.status !== "QUEUED",
    );
    if (active)
      out.push(
        previewFinding(
          "fhb.order.already_submitted",
          "Поръчката вече е изпратена към този склад.",
          "The order was already sent to this warehouse.",
        ),
      );
    const reuse = previous.find((p) => p.status === "SUBMIT_FAILED" || p.status === "QUEUED");
    const externalId =
      reuse?.externalId ?? fhbOrderExternalId(order.store.code, order.number, previous.length + 1);
    const variableSymbol = reuse?.variableSymbol ?? BigInt(connection.variableSymbolNext).toString();
    const duplicate = !!(await tx.fulfillment.findFirst({
      where: {
        connectionId: connection.id,
        ...(reuse ? { id: { not: reuse.id } } : {}),
        OR: [{ externalId }, ...(reuse?.variableSymbol ? [{ variableSymbol }] : [])],
      },
      select: { id: true },
    }));
    const ids = { externalId, variableSymbol, fulfillmentId: reuse?.id ?? "preview" };
    const pre = await fhbPreflight(tx, accountId, input, ids, { duplicate });
    const findings = [...out, ...pre.findings];
    let body: ReturnType<typeof buildFhbOrderCreate> | null = null;
    if (!hasHardBlock(findings)) {
      try {
        body = buildFhbOrderCreate(fhbDraft(pre, input, ids, undefined));
      } catch {
        body = null; // the builder's own schema refused it: the findings say why
      }
    }
    return { findings, body };
  });
}

export async function previewFhbOrderFindings(
  accountId: string,
  input: Omit<SubmitFhbOrderInput, "acknowledgeWarnings">,
): Promise<ValidationFinding[]> {
  return (await fhbPreview(accountId, input)).findings;
}

/** The POST /order body submitFhbOrder would send now (null while a hard finding blocks it). Reads only. */
export async function previewFhbOrderPayload(
  accountId: string,
  input: Omit<SubmitFhbOrderInput, "acknowledgeWarnings">,
) {
  return (await fhbPreview(accountId, input)).body;
}
