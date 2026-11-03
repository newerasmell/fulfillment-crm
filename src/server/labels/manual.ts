import { z } from "zod";
import { Prisma, type ConnectionType } from "@/generated/prisma/client";
import { AWB_OPS } from "@/integrations/eushipments/awb-adapter";
import {
  awbPhone,
  buildCreateAwb,
  buildPreAwb,
  validateAwb,
  type AwbDraft,
} from "@/integrations/eushipments/awb-validators";
import { sofiaToday } from "@/integrations/eushipments/validators";
import { JOY_OPS } from "@/integrations/fhb-joy/adapter";
import { buildJoyShipment } from "@/integrations/fhb-joy/mapper";
import { isJoyRejectable } from "@/integrations/fhb-joy/status-map";
import { validateJoyShipment, type JoyShipmentDraft } from "@/integrations/fhb-joy/validators";
import type { ValidationFinding } from "@/integrations/fhb-v3/validators";
import { normalisePhoneE164 } from "@/integrations/fhb-v3/phone";
import { customPhoneRule, type PhoneRule } from "@/integrations/eushipments/phone";
import { MAX_VARIABLE_SYMBOL } from "@/integrations/fhb-v3/mapper";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { checkOrder, orderLevelFindings, sortFindings, type Finding } from "@/server/checks";
import { accountDb, isUniqueViolation, withAccountTransaction } from "@/server/db/client";
import { enqueueOutboundInTx } from "@/server/outbox/outbox";
import { FINGERPRINT_SELECT, orderFingerprint, recordInitialStatus, transition } from "@/server/pipeline";
import {
  loadRoutingContext,
  routeWithContext,
  stockByConnection,
  type RoutingDecision,
  type StockCheck,
} from "@/server/routing";
import type { ScopedActor } from "@/server/stores";
import { joySettingsOf } from "./connection";
import { LABEL_KINDS, type LabelKind } from "./pipeline-guard";

/**
 * Ръчни пратки (P7-03, SPEC §6.6). A manual shipment is always a MANUAL Order (number M1001, M1002, … from a
 * per-group sequence, external id `M-M1001` at every vendor) plus a ManualShipment row saying how it ships:
 *
 *  - WAREHOUSE — from warehouse stock, exactly like a Shopify order: the order is created IMPORTED, checked with
 *    the SAME validator engine (routing explanation, stock, vendor rules) for the chosen warehouse, and then goes
 *    through the normal review → approve → Fulfill flow on the order page. Nothing new can send a vendor order.
 *  - JOY_LABEL / AWB / PRE_AWB — label-only parcels we pack ourselves (FHB Joy label, euShipments courier AWB or
 *    pre-AWB). The vendor validators run first (hard → nothing is written; unseen soft → needs acknowledgement);
 *    then ONE transaction creates the order, its check, walks the pipeline (check → approve → queue, meta
 *    labelFlow), the shipment with its deterministic id, and the outbox row. The outbox sender alone talks to the
 *    vendor, under the connection's liveMode (READ_ONLY refuses, DRY_RUN records / test mode, CANARY needs a
 *    click + daily cap, LIVE sends). The Fulfillment is unique per (connection, externalId), the outbox per
 *    (connection, idempotencyKey): a double click is ONE label.
 */

export const MANUAL_KINDS = ["WAREHOUSE", ...LABEL_KINDS] as const;
export type ManualKind = (typeof MANUAL_KINDS)[number];

const CONNECTION_FOR: Record<ManualKind, readonly ConnectionType[]> = {
  WAREHOUSE: ["FHB_V3", "EUSHIPMENTS"],
  JOY_LABEL: ["FHB_JOY"],
  AWB: ["EUSHIPMENTS"],
  PRE_AWB: ["EUSHIPMENTS"],
};

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export const ManualShipmentInput = z
  .object({
    kind: z.enum(MANUAL_KINDS),
    companyId: z.string().min(1).max(64),
    connectionId: z.string().min(1).max(64),
    recipient: z.object({
      name: text(100).min(1),
      email: optText(100),
      phone: text(40).min(1),
      address1: text(200).min(1),
      address2: optText(200),
      buildingNumber: optText(40),
      city: text(100).min(1),
      zip: optText(15),
      province: optText(100),
      region: optText(100),
      countryCode: z
        .string()
        .trim()
        .regex(/^[A-Za-z]{2}$/)
        .transform((v) => v.toUpperCase()),
    }),
    /** COD in `currency` (null / 0 = prepaid). */
    cod: z.number().min(0).max(1_000_000).nullable().default(null),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/)
      .transform((v) => v.toUpperCase()),
    parcels: z.number().int().min(1).max(30).default(1),
    /** Joy: weight per package (kg). */
    weights: z.array(z.number().positive().max(1000)).max(30).optional().nullable(),
    /** AWB: total weight (kg). */
    totalWeight: z.number().positive().max(10_000).optional().nullable(),
    declaredValue: z.number().min(0).max(1_000_000).optional().nullable(),
    contents: optText(1000),
    note: optText(250),
    // Joy
    parcelService: optText(60),
    deliveryPoint: optText(60),
    // euShipments AWB
    courierId: z.number().int().positive().optional().nullable(),
    officeId: z.number().int().positive().optional().nullable(),
    serviceName: optText(60),
    waybillDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .nullable(),
    openPackage: z.boolean().optional().default(false),
    // WAREHOUSE
    lines: z
      .array(
        z.object({
          productId: z.string().min(1).max(64),
          quantity: z.number().int().min(1).max(10_000),
          unitPrice: z.number().min(0).max(1_000_000).optional().nullable(),
        }),
      )
      .max(100)
      .default([]),
    acknowledgedCodes: z.array(z.string().max(200)).max(100).default([]),
    /** Generated by the form once per submission: a double click or a retried POST returns the same shipment. */
    clientRequestId: z.string().uuid().optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "WAREHOUSE" && v.lines.length === 0)
      ctx.addIssue({ code: "custom", path: ["lines"], message: "at least one product" });
  });
export type ManualShipmentInput = z.input<typeof ManualShipmentInput>;
type Parsed = z.output<typeof ManualShipmentInput>;

export class ManualPreflightError extends DomainError {
  constructor(
    code: "manual_preflight_failed" | "manual_preflight_needs_ack",
    public readonly findings: Finding[],
  ) {
    super(code);
    this.name = "ManualPreflightError";
  }
}

type Tx = Prisma.TransactionClient;
const MANUAL_TAG = "manual";
const round2 = (v: number) => Math.round(v * 100) / 100;
export const manualExternalId = (number: string) => `M-${number}`;
/** The account-scoped client where a helper takes a transaction client (same scoping, reads only). */
const scopedTx = (accountId: string) => accountDb(accountId) as unknown as Tx;

/**
 * The connection the operator chose, checked against the kind, the company scope and its state. A label is
 * billed to the connection's vendor account and its COD is collected there, so a label kind must use a
 * connection of the ORDER's company (or a shared one without a company): `connection_other_company` otherwise.
 * WAREHOUSE may use another company's warehouse (routing allows it, recorded in the CRM only) — that is a soft
 * finding the operator acknowledges (crossCompanyFinding).
 */
async function loadConnection(
  db: Tx,
  actor: ScopedActor,
  kind: ManualKind,
  connectionId: string,
  companyId: string,
) {
  const c = await db.fulfillmentConnection.findUnique({ where: { id: connectionId } });
  if (!c || !CONNECTION_FOR[kind].includes(c.type)) throw new DomainError("not_found");
  if (actor.companyScope && !actor.companyScope.includes(c.companyId ?? ""))
    throw new DomainError("not_found");
  if (kind !== "WAREHOUSE" && c.companyId && c.companyId !== companyId)
    throw new DomainError("connection_other_company");
  return c;
}

/** WAREHOUSE through another company's warehouse: allowed, but never silently. */
function crossCompanyFinding(conn: { companyId: string | null; name: string }, companyId: string) {
  if (!conn.companyId || conn.companyId === companyId) return [];
  return [
    {
      code: "manual.connection_other_company",
      severity: "soft",
      source: "routing",
      field: null,
      message_bg: `Складът „${conn.name}“ е на друга фирма (отчита се само в CRM).`,
      message_en: `Warehouse "${conn.name}" belongs to another company (recorded in the CRM only).`,
    } satisfies Finding,
  ];
}

/** Same window as the order checks' duplicate finder (validate.ts). */
const DUPLICATE_WINDOW_MS = 48 * 3600_000;

/**
 * Orders of the same company that look like the same parcel: same phone or e-mail, or same street + zip, and
 * the same amount, placed within the window. The clientRequestId only protects ONE form submission; this is
 * what catches a reload or a second operator entering the same parcel (a second, billable label).
 */
async function possibleDuplicates(db: Tx, v: Parsed, now: Date) {
  const r = v.recipient;
  const address1 = r.buildingNumber ? `${r.address1} ${r.buildingNumber}` : r.address1;
  const or: Prisma.OrderWhereInput[] = [
    { phone: r.phone },
    ...(r.email ? [{ email: { equals: r.email, mode: "insensitive" as const } }] : []),
    ...(r.zip
      ? [
          {
            AND: [
              { shippingAddress: { path: ["zip"], equals: r.zip } },
              { shippingAddress: { path: ["address1"], equals: address1 } },
            ],
          },
        ]
      : []),
  ];
  return db.order.findMany({
    where: {
      companyId: v.companyId,
      status: { notIn: ["CANCELLED"] },
      total: orderTotal(v, v.lines),
      placedAt: { gte: new Date(now.getTime() - DUPLICATE_WINDOW_MS), lte: new Date(now.getTime() + 60_000) },
      OR: or,
    },
    select: { number: true },
    orderBy: { placedAt: "desc" },
    take: 5,
  });
}

function duplicateFinding(dups: { number: string }[]): Finding[] {
  if (!dups.length) return [];
  const list = dups.map((d) => d.number).join(", ");
  return [
    {
      code: "manual.duplicate_recipient",
      severity: "soft",
      source: "order",
      field: null,
      message_bg: `Възможен дубликат на ${list}: същият получател и сума в последните 48 ч. Втори етикет се таксува отделно.`,
      message_en: `Possible duplicate of ${list}: same recipient and amount in the last 48 h. A second label is billed separately.`,
    },
  ];
}

function toFinding(f: ValidationFinding, source: Finding["source"]): Finding {
  return { ...f, source, field: f.field };
}

/** The destination's setting: local currency and the group's own phone rule (Настройки → Държави). */
interface CountryCtx {
  currency: string | null;
  phoneRule: PhoneRule | null;
}

async function countryCtxOf(db: Tx, accountId: string, country: string): Promise<CountryCtx> {
  const s = await db.countrySetting.findUnique({ where: { accountId_country: { accountId, country } } });
  return { currency: s?.currency?.toUpperCase() ?? null, phoneRule: customPhoneRule(s?.phoneRules) };
}

function joyDraftOf(
  v: Parsed,
  settings: ReturnType<typeof joySettingsOf>,
  ids: { id: string; variableSymbol: string },
  countryCtx: CountryCtx,
  duplicate: boolean,
): JoyShipmentDraft {
  const r = v.recipient;
  return {
    id: ids.id,
    variableSymbol: ids.variableSymbol,
    parcelService: v.parcelService,
    allowedParcelServices: settings.parcelServices,
    name: r.name,
    street: [r.address1, r.buildingNumber, r.address2].filter(Boolean).join(" ").trim(),
    city: r.city,
    zip: r.zip,
    province: r.province,
    country: r.countryCode,
    email: r.email,
    phone: r.phone,
    cod: v.cod,
    codCurrency: v.currency,
    localCurrency: countryCtx.currency,
    phoneRule: countryCtx.phoneRule,
    numberOfPackages: v.parcels,
    weights: v.weights ?? null,
    requiresDeliveryPoint: !!v.parcelService && settings.pickupServices.includes(v.parcelService),
    deliveryPoint: v.deliveryPoint,
    note: v.note,
    duplicateId: duplicate,
  };
}

function awbDraftOf(
  v: Parsed,
  companyId: number | null,
  reference: string,
  countryCtx: CountryCtx,
  duplicate: boolean,
  now: Date,
): AwbDraft {
  const r = v.recipient;
  const today = sofiaToday(now);
  return {
    service: v.kind === "PRE_AWB" ? "preAWB" : "createAWB",
    referenceNumber: reference,
    senderId: companyId,
    courierId: v.courierId ?? null,
    serviceName: v.serviceName,
    waybillAvailableDate: v.waybillDate ?? today,
    today,
    name: r.name,
    phone: r.phone,
    email: r.email,
    country: r.countryCode,
    cityName: r.city,
    zip: r.zip,
    region: r.region,
    street: r.address1,
    buildingNumber: r.buildingNumber,
    addressText: r.address2,
    officeId: v.officeId ?? null,
    parcels: v.parcels,
    totalWeight: v.totalWeight ?? (v.weights?.length ? v.weights.reduce((a, b) => a + b, 0) : null),
    declaredValue: v.declaredValue ?? null,
    cod: v.cod,
    codCurrency: v.currency,
    localCurrency: countryCtx.currency,
    phoneRule: countryCtx.phoneRule,
    observations: v.note,
    contents: v.contents,
    openPackage: v.openPackage,
    duplicateReference: duplicate,
  };
}

const euCompanyId = (vendorIds: unknown) => {
  const n = Number((vendorIds as { companyId?: unknown } | null)?.companyId);
  return Number.isInteger(n) && n > 0 ? n : null;
};

interface LabelPlan {
  findings: Finding[];
  operation: string;
  payload: (fulfillmentId: string, manualShipmentId: string) => Prisma.InputJsonValue;
  body: unknown;
  carrier: string | null;
  deliveryPoint: Prisma.InputJsonValue | undefined;
}

/** Vendor validators + the exact body for a label kind (body null while a hard finding blocks it). */
function planLabel(
  v: Parsed,
  conn: { type: ConnectionType; vendorIds: unknown },
  ids: { externalId: string; variableSymbol: string },
  countryCtx: CountryCtx,
  duplicate: boolean,
  now: Date,
): LabelPlan & { body: unknown | null } {
  if (v.kind === "JOY_LABEL") {
    const settings = joySettingsOf(conn.vendorIds);
    const draft = joyDraftOf(
      v,
      settings,
      { id: ids.externalId, variableSymbol: ids.variableSymbol },
      countryCtx,
      duplicate,
    );
    const findings = validateJoyShipment(draft).map((f) => toFinding(f, "fhb"));
    const body = findings.some((f) => f.severity === "hard")
      ? null
      : buildJoyShipment({ ...draft, sender: settings.sender, senderName: settings.senderName });
    return {
      findings,
      operation: JOY_OPS.createShipment,
      body,
      payload: (fulfillmentId, manualShipmentId) => ({
        id: ids.externalId,
        body: body as Prisma.InputJsonValue,
        ctx: { fulfillmentId, manualShipmentId },
      }),
      carrier: v.parcelService,
      deliveryPoint: v.deliveryPoint ? { code: v.deliveryPoint } : undefined,
    };
  }
  const draft = awbDraftOf(v, euCompanyId(conn.vendorIds), ids.externalId, countryCtx, duplicate, now);
  const findings = validateAwb(draft).map((f) => toFinding(f, "eushipments"));
  const hard = findings.some((f) => f.severity === "hard");
  const body = hard ? null : draft.service === "preAWB" ? buildPreAwb(draft) : buildCreateAwb(draft);
  return {
    findings,
    operation: draft.service === "preAWB" ? AWB_OPS.preAwb : AWB_OPS.create,
    body,
    payload: (fulfillmentId, manualShipmentId) => ({
      body: body as Prisma.InputJsonValue,
      ctx: { fulfillmentId, manualShipmentId, referenceNumber: ids.externalId },
    }),
    carrier: v.courierId ? String(v.courierId) : null,
    deliveryPoint: v.officeId ? { officeId: v.officeId } : undefined,
  };
}

export interface ManualPreview {
  kind: ManualKind;
  findings: Finding[];
  /** WAREHOUSE: what routing would choose and why; the chosen warehouse's stock. */
  routing: RoutingDecision | null;
  stock: StockCheck | null;
  /** Label kinds: the exact vendor body (null while blocked). The FHB/euShipments order body is built at Fulfill. */
  payload: unknown | null;
  liveMode: string;
  explanation: { bg: string; en: string };
}

/** Read-only preview for the form: same validators, routing explanation, exact payload. Nothing is written. */
export async function previewManualShipment(
  actor: ScopedActor,
  raw: ManualShipmentInput,
  now = new Date(),
): Promise<ManualPreview> {
  assertCan(actor.role, "orders.fulfill");
  const v = ManualShipmentInput.parse(raw);
  if (actor.companyScope && !actor.companyScope.includes(v.companyId)) throw new DomainError("not_found");
  const db = scopedTx(actor.accountId);
  const conn = await loadConnection(db, actor, v.kind, v.connectionId, v.companyId);
  const countryCtx = await countryCtxOf(db, actor.accountId, v.recipient.countryCode);
  const chosen = {
    bg: `Ръчно избрана връзка: „${conn.name}“ (${conn.type}), режим ${conn.liveMode}.`,
    en: `Chosen by hand: "${conn.name}" (${conn.type}), mode ${conn.liveMode}.`,
  };
  if (v.kind === "WAREHOUSE") {
    const products = await db.product.findMany({
      where: { id: { in: v.lines.map((l) => l.productId) } },
      select: { id: true, sku: true, name: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    const lines = v.lines.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      title: byId.get(l.productId)?.sku ?? l.productId,
    }));
    const ctx = await loadRoutingContext(actor.accountId);
    const company = await db.company.findUnique({ where: { id: v.companyId }, select: { lineId: true } });
    const routingOrder = {
      companyId: v.companyId,
      lineId: company?.lineId ?? null,
      storeId: null,
      countryCode: v.recipient.countryCode,
      paymentMethod: v.cod && v.cod > 0 ? ("COD" as const) : ("PREPAID" as const),
      tags: [MANUAL_TAG],
      lines,
    };
    const routing = await routeWithContext(ctx, routingOrder);
    const target = ctx.connections.find((c) => c.id === conn.id);
    const stock = target
      ? ((await stockByConnection(actor.accountId, [target], lines)).get(conn.id) ?? null)
      : null;
    const total = orderTotal(v, byId.size ? v.lines : []);
    const level = orderLevelFindings(
      {
        number: "M-preview",
        customerName: v.recipient.name,
        email: v.recipient.email,
        phone: v.recipient.phone,
        shippingAddress: addressOf(v),
        countryCode: v.recipient.countryCode,
        currency: v.currency,
        total,
        paymentMethod: routingOrder.paymentMethod,
        codAmount: v.cod && v.cod > 0 ? v.cod : null,
        codLocalAmount: null,
        codLocalCurrency: null,
        tags: [MANUAL_TAG],
        lines: v.lines.map((l) => ({
          title: byId.get(l.productId)?.name ?? l.productId,
          sku: byId.get(l.productId)?.sku ?? null,
          productId: byId.has(l.productId) ? l.productId : null,
          quantity: l.quantity,
        })),
      },
      {
        localCurrency: countryCtx.currency,
        phoneRule: countryCtx.phoneRule,
        routing: routing.connectionId === conn.id ? routing : { ...routing, connectionId: conn.id },
        stock,
        duplicates: await possibleDuplicates(db, v, now),
      },
    );
    const sameAsRouting = routing.connectionId === conn.id;
    return {
      kind: v.kind,
      findings: sortFindings([...level.findings, ...crossCompanyFinding(conn, v.companyId)]),
      routing,
      stock,
      payload: null,
      liveMode: conn.liveMode,
      explanation: sameAsRouting
        ? routing.explanation
        : {
            bg: `${chosen.bg} Правилата биха избрали: ${routing.explanation.bg}`,
            en: `${chosen.en} The rules would choose: ${routing.explanation.en}`,
          },
    };
  }
  const plan = planLabel(v, conn, { externalId: "M-PREVIEW", variableSymbol: "1" }, countryCtx, false, now);
  return {
    kind: v.kind,
    findings: sortFindings([...plan.findings, ...duplicateFinding(await possibleDuplicates(db, v, now))]),
    routing: null,
    stock: null,
    payload: plan.body,
    liveMode: conn.liveMode,
    explanation: chosen,
  };
}

function addressOf(v: Parsed) {
  const r = v.recipient;
  return {
    name: r.name,
    address1: r.buildingNumber ? `${r.address1} ${r.buildingNumber}` : r.address1,
    address2: r.address2,
    city: r.city,
    zip: r.zip,
    province: r.province ?? r.region,
    countryCode: r.countryCode,
    phone: r.phone,
  };
}

function orderTotal(v: Parsed, lines: { quantity: number; unitPrice?: number | null }[]) {
  if (v.cod && v.cod > 0) return round2(v.cod);
  return round2(lines.reduce((s, l) => s + (l.unitPrice ?? 0) * l.quantity, 0));
}

/** Next manual number of the group (M1001, …). Atomic: concurrent creators get distinct numbers. */
async function nextNumber(tx: Tx, accountId: string) {
  const row = await tx.manualShipmentSequence.upsert({
    where: { accountId },
    create: { accountId, next: 1002 },
    update: { next: { increment: 1 } },
    select: { next: true },
  });
  return `M${row.next - 1}`;
}

/** Parameters kept on the ManualShipment (everything but the recipient, which lives on the order). */
const paramsOf = (v: Parsed) => {
  const { recipient: _r, acknowledgedCodes: _a, lines: _l, clientRequestId: _c, ...rest } = v;
  void _r;
  void _a;
  void _l;
  void _c;
  return JSON.parse(JSON.stringify(rest)) as Prisma.InputJsonValue;
};

export interface CreateManualResult {
  manualShipmentId: string;
  orderId: string;
  number: string;
  kind: ManualKind;
  fulfillmentId: string | null;
  requestId: string | null;
  findings: Finding[];
  liveMode: string;
}

/** Creates a manual shipment. Label kinds queue the label; WAREHOUSE creates and checks the order. */
export async function createManualShipment(
  actor: ScopedActor,
  raw: ManualShipmentInput,
  now = new Date(),
): Promise<CreateManualResult> {
  assertCan(actor.role, "orders.fulfill");
  const v = ManualShipmentInput.parse(raw);
  if (actor.companyScope && !actor.companyScope.includes(v.companyId)) throw new DomainError("not_found");
  const db = scopedTx(actor.accountId);
  const company = await db.company.findUnique({ where: { id: v.companyId } });
  if (!company || company.archivedAt) throw new DomainError("not_found");
  const conn0 = await loadConnection(db, actor, v.kind, v.connectionId, v.companyId);
  // Required: it is what makes a double click or a retried POST ONE shipment.
  if (!v.clientRequestId) throw new DomainError("client_request_id_required");
  const again = await existingSubmission(actor, v.clientRequestId);
  if (again) return again;
  if (!conn0.enabled) throw new DomainError("connection_disabled");
  if (v.kind === "WAREHOUSE") gate(crossCompanyFinding(conn0, v.companyId), v.acknowledgedCodes);
  try {
    return v.kind === "WAREHOUSE"
      ? await createWarehouse(actor, v, now)
      : await createLabel(actor, v, conn0.type, now);
  } catch (err) {
    // The same submission committed concurrently (unique clientRequestId): return the winner, create nothing.
    const winner =
      isUniqueViolation(err) || err instanceof DomainError
        ? await existingSubmission(actor, v.clientRequestId)
        : null;
    if (winner) return winner;
    throw err;
  }
}

/** The shipment an earlier submission with this clientRequestId created (same user), if any. */
async function existingSubmission(
  actor: ScopedActor,
  clientRequestId: string | null | undefined,
): Promise<CreateManualResult | null> {
  if (!clientRequestId) return null;
  const ms = await accountDb(actor.accountId).manualShipment.findUnique({
    where: { accountId_clientRequestId: { accountId: actor.accountId, clientRequestId } },
    include: { order: { select: { number: true } }, connection: { select: { liveMode: true } } },
  });
  if (!ms || ms.createdById !== actor.userId) return null;
  const request = ms.fulfillmentId
    ? await accountDb(actor.accountId).outboundRequest.findFirst({
        where: { fulfillmentId: ms.fulfillmentId },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      })
    : null;
  return {
    manualShipmentId: ms.id,
    orderId: ms.orderId,
    number: ms.order.number,
    kind: ms.kind as ManualKind,
    fulfillmentId: ms.fulfillmentId,
    requestId: request?.id ?? null,
    findings: [],
    liveMode: ms.connection.liveMode,
  };
}

async function createWarehouse(actor: ScopedActor, v: Parsed, now: Date): Promise<CreateManualResult> {
  const created = await withAccountTransaction(actor.accountId, async (tx) => {
    const products = await tx.product.findMany({
      where: { id: { in: v.lines.map((l) => l.productId) } },
      select: { id: true, sku: true, name: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    if (v.lines.some((l) => !byId.has(l.productId))) throw new DomainError("product_not_found");
    const number = await nextNumber(tx, actor.accountId);
    const order = await createOrderRow(tx, actor, v, number, now, orderTotal(v, v.lines));
    await tx.orderLine.createMany({
      data: v.lines.map((l) => ({
        accountId: actor.accountId,
        orderId: order.id,
        productId: l.productId,
        sku: byId.get(l.productId)!.sku,
        title: byId.get(l.productId)!.name,
        quantity: l.quantity,
        unitPrice: l.unitPrice ?? 0,
      })),
    });
    await recordInitialStatus(tx, {
      accountId: actor.accountId,
      orderId: order.id,
      status: "IMPORTED",
      actor: { kind: "user", userId: actor.userId },
      source: "manual",
    });
    const ms = await tx.manualShipment.create({
      data: {
        accountId: actor.accountId,
        orderId: order.id,
        kind: "WAREHOUSE",
        connectionId: v.connectionId,
        params: paramsOf(v),
        clientRequestId: v.clientRequestId ?? null,
        createdById: actor.userId,
      },
    });
    return { order, ms, number };
  });
  // The SAME validator engine as every order, for the chosen warehouse: routing, stock, vendor rules.
  const check = await checkOrder(actor.accountId, created.order.id, {
    actor: { kind: "user", userId: actor.userId },
    connectionId: v.connectionId,
  });
  const conn = await accountDb(actor.accountId).fulfillmentConnection.findUniqueOrThrow({
    where: { id: v.connectionId },
    select: { liveMode: true },
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "manual_shipment.create",
    entityType: "Order",
    entityId: created.order.id,
    after: { number: created.number, kind: "WAREHOUSE", connectionId: v.connectionId, lines: v.lines.length },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return {
    manualShipmentId: created.ms.id,
    orderId: created.order.id,
    number: created.number,
    kind: "WAREHOUSE",
    fulfillmentId: null,
    requestId: null,
    findings: check.findings,
    liveMode: conn.liveMode,
  };
}

async function createOrderRow(
  tx: Tx,
  actor: ScopedActor,
  v: Parsed,
  number: string,
  now: Date,
  total: number,
) {
  const isCod = !!v.cod && v.cod > 0;
  const address = addressOf(v);
  return tx.order.create({
    data: {
      accountId: actor.accountId,
      companyId: v.companyId,
      source: "MANUAL",
      number,
      status: "IMPORTED",
      customerName: v.recipient.name,
      email: v.recipient.email,
      phone: v.recipient.phone,
      shippingAddressOriginal: address,
      shippingAddress: address,
      currency: v.currency,
      subtotal: total,
      total,
      paymentMethod: isCod ? "COD" : "PREPAID",
      codAmount: isCod ? round2(v.cod!) : null,
      tags: [MANUAL_TAG],
      note: v.note,
      placedAt: now,
      countryCode: v.recipient.countryCode,
    },
  });
}

/** Refuses on hard findings or on soft findings the operator was not shown (nothing written yet). */
function gate(findings: Finding[], acknowledged: readonly string[]) {
  if (findings.some((f) => f.severity === "hard"))
    throw new ManualPreflightError("manual_preflight_failed", findings);
  if (findings.some((f) => f.severity === "soft" && !acknowledged.includes(f.code)))
    throw new ManualPreflightError("manual_preflight_needs_ack", findings);
}

async function createLabel(
  actor: ScopedActor,
  v: Parsed,
  type: ConnectionType,
  now: Date,
): Promise<CreateManualResult> {
  const db = scopedTx(actor.accountId);
  const countryCtx = await countryCtxOf(db, actor.accountId, v.recipient.countryCode);
  // Fail fast (nothing written, no number consumed); the same checks run again inside the transaction.
  {
    const conn = await loadConnection(db, actor, v.kind, v.connectionId, v.companyId);
    if (conn.liveMode === "READ_ONLY") throw new DomainError("connection_read_only");
    gate(
      [
        ...planLabel(v, conn, { externalId: "M-M0", variableSymbol: "1" }, countryCtx, false, now).findings,
        ...duplicateFinding(await possibleDuplicates(db, v, now)),
      ],
      v.acknowledgedCodes,
    );
  }
  const run = () =>
    withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
      // Serialises with the sender, the kill switch and mode changes (same lock order: connection first).
      await lockForUpdate("FulfillmentConnection", v.connectionId);
      const conn = await loadConnection(tx, actor, v.kind, v.connectionId, v.companyId);
      if (!conn.enabled) throw new DomainError("connection_disabled");
      if (conn.liveMode === "READ_ONLY") throw new DomainError("connection_read_only");
      const number = await nextNumber(tx, actor.accountId);
      const externalId = manualExternalId(number);
      let variableSymbol: string | null = null;
      if (type === "FHB_JOY") {
        const bumped = await tx.fulfillmentConnection.update({
          where: { id: conn.id },
          data: { variableSymbolNext: { increment: 1 } },
          select: { variableSymbolNext: true },
        });
        const next = BigInt(bumped.variableSymbolNext) - 1n;
        if (next > MAX_VARIABLE_SYMBOL) throw new DomainError("variable_symbol_exhausted");
        variableSymbol = next.toString();
      }
      const duplicate = !!(await tx.fulfillment.findFirst({
        where: { connectionId: conn.id, externalId },
        select: { id: true },
      }));
      const plan = planLabel(
        v,
        conn,
        { externalId, variableSymbol: variableSymbol ?? "1" },
        countryCtx,
        duplicate,
        now,
      );
      // Re-read under the connection lock: a parcel committed by another operator meanwhile is seen here.
      plan.findings.push(...duplicateFinding(await possibleDuplicates(tx, v, now)));
      gate(plan.findings, v.acknowledgedCodes);

      const order = await createOrderRow(tx, actor, v, number, now, orderTotal(v, []));
      const user = { kind: "user" as const, userId: actor.userId };
      await recordInitialStatus(tx, {
        accountId: actor.accountId,
        orderId: order.id,
        status: "IMPORTED",
        actor: user,
        source: "manual",
      });
      const ms = await tx.manualShipment.create({
        data: {
          accountId: actor.accountId,
          orderId: order.id,
          kind: v.kind,
          connectionId: conn.id,
          params: paramsOf(v),
          clientRequestId: v.clientRequestId ?? null,
          createdById: actor.userId,
        },
      });
      // The pre-flight result is the order's check (fingerprint of exactly this data), as for every order.
      const fp = orderFingerprint(
        await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: FINGERPRINT_SELECT }),
      );
      const phone =
        type === "FHB_JOY"
          ? normalisePhoneE164(v.recipient.phone, v.recipient.countryCode, countryCtx.phoneRule)
          : awbPhone(v.recipient.phone, v.recipient.countryCode, countryCtx.phoneRule);
      const findings = sortFindings(plan.findings);
      const soft = findings.filter((f) => f.severity === "soft").length;
      await tx.orderCheck.create({
        data: {
          accountId: actor.accountId,
          orderId: order.id,
          connectionId: conn.id,
          routing: { manual: true, kind: v.kind, connectionId: conn.id, connectionName: conn.name },
          findings: JSON.parse(JSON.stringify(findings)) as Prisma.InputJsonValue,
          hardCount: 0,
          softCount: soft,
          normalised: { phone, country: v.recipient.countryCode, orderFingerprint: fp },
          checkedById: actor.userId,
          checkedAt: now,
        },
      });
      // The pipeline, step by step (strict): checked → reviewed by this operator (their click) → queued.
      const meta = { labelFlow: true, connectionId: conn.id };
      await transition(tx, {
        orderId: order.id,
        to: "CHECKING",
        cause: "check_start",
        actor: user,
        source: "manual",
        meta,
        mode: "strict",
      });
      await transition(tx, {
        orderId: order.id,
        to: soft ? "NEEDS_REVIEW" : "READY",
        cause: "check_result",
        actor: user,
        source: "manual",
        meta,
        mode: "strict",
      });
      await transition(tx, {
        orderId: order.id,
        to: "APPROVED",
        cause: "approve",
        actor: user,
        source: "manual",
        meta,
        mode: "strict",
      });
      await lockForUpdate("Order", order.id);
      await transition(tx, {
        orderId: order.id,
        to: "QUEUED",
        cause: "queue",
        actor: user,
        source: "manual",
        meta,
        mode: "strict",
        onlyFrom: ["APPROVED"],
      });

      const fulfillment = await tx.fulfillment.create({
        data: {
          accountId: actor.accountId,
          orderId: order.id,
          connectionId: conn.id,
          externalId,
          variableSymbol,
          status: "QUEUED",
          carrier: plan.carrier,
          deliveryPoint: plan.deliveryPoint,
        },
      });
      await tx.manualShipment.update({ where: { id: ms.id }, data: { fulfillmentId: fulfillment.id } });
      if (type === "EUSHIPMENTS") {
        // The fulfilment-order poller (orders-history by reference) must not look for a courier AWB; the labels
        // poller tracks it by AWB number (waybills-history).
        await tx.eushipmentsTracking.create({
          data: {
            accountId: actor.accountId,
            connectionId: conn.id,
            fulfillmentId: fulfillment.id,
            referenceNumber: externalId,
            stopPolling: true,
          },
        });
      }
      const { request, created } = await enqueueOutboundInTx(tx, {
        accountId: actor.accountId,
        connectionId: conn.id,
        operation: plan.operation,
        idempotencyKey: `${plan.operation}:${externalId}`,
        payload: plan.payload(fulfillment.id, ms.id),
        fulfillmentId: fulfillment.id,
        createdById: actor.userId,
      });
      if (!created) throw new DomainError("already_submitted");
      return { order, ms, number, fulfillment, request, findings, liveMode: conn.liveMode, externalId };
    });
  let r;
  try {
    r = await run();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    r = await run(); // a concurrent creator won the sequence row: the next number is ours
  }
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "manual_shipment.create",
    entityType: "Fulfillment",
    entityId: r.fulfillment.id,
    after: {
      number: r.number,
      kind: v.kind,
      connectionId: v.connectionId,
      externalId: r.externalId,
      requestId: r.request.id,
      liveMode: r.liveMode,
      acknowledged: r.findings.filter((f) => f.severity === "soft").map((f) => f.code),
    },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return {
    manualShipmentId: r.ms.id,
    orderId: r.order.id,
    number: r.number,
    kind: v.kind,
    fulfillmentId: r.fulfillment.id,
    requestId: r.request.id,
    findings: r.findings,
    liveMode: r.liveMode,
  };
}

// ───────────────────────── after creation: send again, void ─────────────────────────

async function loadManual(tx: Tx, actor: ScopedActor, manualShipmentId: string) {
  const ms = await tx.manualShipment.findUnique({
    where: { id: manualShipmentId },
    include: { order: true, fulfillment: true, connection: true },
  });
  if (!ms || (actor.companyScope && !actor.companyScope.includes(ms.order.companyId ?? "")))
    throw new DomainError("not_found");
  return ms;
}

/** The stored form input of a label shipment, rebuilt with the order's current recipient. */
function inputOf(ms: Awaited<ReturnType<typeof loadManual>>): Parsed {
  const a = (ms.order.shippingAddress ?? {}) as Record<string, string | null>;
  const p = (ms.params ?? {}) as Record<string, unknown>;
  return ManualShipmentInput.parse({
    ...p,
    kind: ms.kind,
    companyId: ms.order.companyId,
    connectionId: ms.connectionId,
    recipient: {
      name: ms.order.customerName ?? a.name ?? "",
      email: ms.order.email,
      phone: ms.order.phone ?? a.phone ?? "",
      address1: a.address1 ?? "",
      address2: a.address2,
      city: a.city ?? "",
      zip: a.zip,
      province: a.province,
      region: a.province,
      countryCode: ms.order.countryCode ?? a.countryCode ?? "",
    },
    lines: [],
    acknowledgedCodes: [],
  });
}

/**
 * Sends a label again after it never left (DRY_RUN record, READ_ONLY refusal) or was refused by the vendor
 * (FAILED): the same outbox row (same idempotency key) is re-armed with a freshly validated body. A request that
 * was SENT, is in flight or UNCERTAIN is never re-armed (the outbox refuses it) — no second label.
 */
export async function resendLabel(
  actor: ScopedActor,
  manualShipmentId: string,
  acknowledgedCodes: readonly string[] = [],
  now = new Date(),
) {
  assertCan(actor.role, "orders.fulfill");
  const result = await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    const head = await loadManual(tx, actor, manualShipmentId);
    if (!(LABEL_KINDS as readonly string[]).includes(head.kind) || !head.fulfillment)
      throw new DomainError("not_a_label");
    await lockForUpdate("FulfillmentConnection", head.connectionId);
    await lockForUpdate("Order", head.orderId);
    const ms = await loadManual(tx, actor, manualShipmentId);
    const f = ms.fulfillment!;
    if (ms.connection.liveMode === "READ_ONLY") throw new DomainError("connection_read_only");
    if (!ms.connection.enabled) throw new DomainError("connection_disabled");
    if (!["QUEUED", "SUBMIT_FAILED"].includes(f.status)) throw new DomainError("already_submitted");
    const v = inputOf(ms);
    const countryCtx = await countryCtxOf(tx, actor.accountId, v.recipient.countryCode);
    const plan = planLabel(
      v,
      ms.connection,
      { externalId: f.externalId, variableSymbol: f.variableSymbol ?? "1" },
      countryCtx,
      false,
      now,
    );
    gate(plan.findings, acknowledgedCodes);
    if (ms.order.status === "SUBMIT_FAILED")
      await transition(tx, {
        orderId: ms.orderId,
        to: "QUEUED",
        cause: "queue",
        actor: { kind: "user", userId: actor.userId },
        source: "manual.resend",
        meta: { labelFlow: true, connectionId: ms.connectionId },
        mode: "strict",
        onlyFrom: ["SUBMIT_FAILED"],
      });
    else if (ms.order.status !== "QUEUED") throw new DomainError("already_submitted");
    await tx.fulfillment.update({ where: { id: f.id }, data: { status: "QUEUED" } });
    const { request, created } = await enqueueOutboundInTx(tx, {
      accountId: actor.accountId,
      connectionId: ms.connectionId,
      operation: plan.operation,
      idempotencyKey: `${plan.operation}:${f.externalId}`,
      payload: plan.payload(f.id, ms.id),
      fulfillmentId: f.id,
      createdById: actor.userId,
    });
    if (!created) throw new DomainError("already_submitted");
    return { request, fulfillmentId: f.id, liveMode: ms.connection.liveMode };
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "manual_shipment.resend",
    entityType: "Fulfillment",
    entityId: result.fulfillmentId,
    after: { requestId: result.request.id, liveMode: result.liveMode, acknowledged: [...acknowledgedCodes] },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return result;
}

/** Can this label be voided now (Joy reject while printed; euShipments AWB delete)? Pure. */
export function voidableLabel(
  kind: string,
  f: { status: string; rawStatus: string | null; vendorOrderId: string | null } | null,
) {
  if (!f) return false;
  if (kind === "JOY_LABEL") return f.status === "ACCEPTED" && isJoyRejectable(f.rawStatus);
  if (kind === "AWB")
    return (
      !!f.vendorOrderId && ["ACCEPTED", "PROCESSING", "BLOCKED", "EXCEPTION", "UNKNOWN"].includes(f.status)
    );
  return false;
}

/** Voids a created label through the outbox: Joy DELETE /shipments (printed only), euShipments DELETE /delete/{awb}. */
export async function voidLabel(actor: ScopedActor, manualShipmentId: string) {
  assertCan(actor.role, "orders.cancelAtWarehouse");
  const r = await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    const head = await loadManual(tx, actor, manualShipmentId);
    await lockForUpdate("FulfillmentConnection", head.connectionId);
    const ms = await loadManual(tx, actor, manualShipmentId);
    const f = ms.fulfillment;
    if (!voidableLabel(ms.kind, f)) throw new DomainError("not_voidable");
    const operation = ms.kind === "JOY_LABEL" ? JOY_OPS.rejectShipment : AWB_OPS.delete;
    const payload =
      ms.kind === "JOY_LABEL"
        ? { id: f!.externalId, ctx: { fulfillmentId: f!.id, manualShipmentId: ms.id } }
        : { awb: f!.vendorOrderId!, ctx: { fulfillmentId: f!.id, manualShipmentId: ms.id } };
    const { request, created } = await enqueueOutboundInTx(tx, {
      accountId: actor.accountId,
      connectionId: ms.connectionId,
      operation,
      idempotencyKey: `${operation}:${f!.externalId}`,
      payload,
      fulfillmentId: f!.id,
      createdById: actor.userId,
    });
    if (!created) throw new DomainError("already_requested");
    return { request, fulfillmentId: f!.id };
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "manual_shipment.void",
    entityType: "Fulfillment",
    entityId: r.fulfillmentId,
    after: { requestId: r.request.id },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return r;
}

export type { LabelKind };
