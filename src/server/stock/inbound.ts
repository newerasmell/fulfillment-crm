import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import type { FhbClient } from "@/integrations/fhb-v3/client";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import { DomainError } from "@/server/accounts";
import { assertCan } from "@/server/auth/rbac";
import { companyFilter } from "@/server/companies";
import { accountDb, systemDb } from "@/server/db/client";
import { applyFhbStockReceipt } from "@/server/fhb/apply";
import { fhbClientForConnection } from "@/server/fhb/connection";
import { createFhbStockReceipt } from "@/server/fhb/inbound";
import { queueEuBooking } from "@/server/eushipments/write";
import type { ScopedActor } from "@/server/stores";
import { boardProductWhere, CLOSED_INBOUND, type StockCtx } from "./board";

/**
 * Inbound ("Приемане на стока", P5-02, SPEC §6.4): one form for both warehouses. Lines come from a product picker
 * or an uploaded XLSX/CSV (columns SKU, qty). Creation goes through the existing vendor services, which validate,
 * record our InboundShipment + expected lines and queue ONE outbox request under a deterministic id:
 *  - FHB: createFhbStockReceipt (receipt id derived from the form's request token; same token = same receipt);
 *  - euShipments: queueEuBooking with a document number derived the same way (a booking has no read-back, so
 *    the outbox never retries an unknown outcome: UNCERTAIN + task).
 * Received quantities: FHB via GET /stock-receipt (pollFhbReceipts, read-only), euShipments via the existing
 * booking poller. Differences and overdue deliveries become tasks (sweepInboundAlerts).
 */

export const MAX_INBOUND_LINES = 1000;
export const MAX_INBOUND_FILE_BYTES = 2 * 1024 * 1024;

// ───────────── upload parsing (pure) ─────────────

export interface ParsedLine {
  row: number;
  code: string;
  quantity: number;
}
export interface ParseError {
  row: number;
  code: "sku_missing" | "qty_invalid" | "too_many_lines" | "empty";
  value?: string;
}

const SKU_HEADERS = ["sku", "код", "артикул", "refnumber", "product", "продукт", "id"];
const QTY_HEADERS = ["qty", "quantity", "количество", "брой", "бр", "бр."];
const norm = (s: string) => s.trim().toLowerCase();

/** Pure: (SKU or warehouse code, qty) rows of an uploaded table; a header row is optional. Duplicates are summed. */
export function parseInboundTable(rows: string[][]): { lines: ParsedLine[]; errors: ParseError[] } {
  const nonEmpty = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.some((c) => c.trim() !== ""));
  if (!nonEmpty.length) return { lines: [], errors: [{ row: 0, code: "empty" }] };
  let skuCol = 0;
  let qtyCol = 1;
  let start = 0;
  const head = nonEmpty[0]!.r.map(norm);
  const hs = head.findIndex((h) => SKU_HEADERS.includes(h));
  const hq = head.findIndex((h) => QTY_HEADERS.includes(h));
  if (hs >= 0 && hq >= 0) {
    skuCol = hs;
    qtyCol = hq;
    start = 1;
  } else if (!/^\d+$/.test((nonEmpty[0]!.r[1] ?? "").trim())) {
    start = 1; // an unknown header (text where a quantity should be)
  }
  const errors: ParseError[] = [];
  const merged = new Map<string, ParsedLine>();
  for (const { r, i } of nonEmpty.slice(start)) {
    const row = i + 1;
    const code = (r[skuCol] ?? "").trim();
    const rawQty = (r[qtyCol] ?? "").trim().replace(/\s/g, "");
    if (!code) {
      errors.push({ row, code: "sku_missing" });
      continue;
    }
    if (
      !/^\d+([.,]0+)?$/.test(rawQty) ||
      Number.parseInt(rawQty, 10) < 1 ||
      Number.parseInt(rawQty, 10) > 1e6
    ) {
      errors.push({ row, code: "qty_invalid", value: rawQty.slice(0, 20) });
      continue;
    }
    const key = code.toUpperCase();
    const prev = merged.get(key);
    merged.set(key, {
      row: prev?.row ?? row,
      code: prev?.code ?? code,
      quantity: (prev?.quantity ?? 0) + Number.parseInt(rawQty, 10),
    });
  }
  const lines = [...merged.values()];
  if (lines.length > MAX_INBOUND_LINES)
    return {
      lines: lines.slice(0, MAX_INBOUND_LINES),
      errors: [...errors, { row: 0, code: "too_many_lines" }],
    };
  return { lines, errors };
}

// ───────────── scope ─────────────

type Ctx = StockCtx & ScopedActor;

/** Inbound-capable connections the member sees (FHB v3 and euShipments) under the sidebar filters. */
export async function inboundConnections(ctx: StockCtx) {
  return accountDb(ctx.accountId).fulfillmentConnection.findMany({
    where: { type: { in: ["FHB_V3", "EUSHIPMENTS"] }, ...companyFilter(ctx) },
    select: {
      id: true,
      name: true,
      type: true,
      liveMode: true,
      enabled: true,
      eushipmentsWarehouses: { select: { warehouseId: true, name: true }, orderBy: { name: "asc" } },
      fhbCarriers: { select: { code: true, name: true }, orderBy: { name: "asc" } },
    },
    orderBy: [{ type: "asc" }, { name: "asc" }],
  });
}

async function connectionInScope(ctx: StockCtx, connectionId: string) {
  const c = await accountDb(ctx.accountId).fulfillmentConnection.findFirst({
    where: { id: connectionId, type: { in: ["FHB_V3", "EUSHIPMENTS"] }, ...companyFilter(ctx) },
    select: { id: true, type: true, name: true },
  });
  if (!c) throw new DomainError("not_found");
  return c;
}

export interface ResolvedLine {
  row: number;
  code: string;
  quantity: number;
  productId: string | null;
  sku: string | null;
  name: string | null;
  vendorId: string | null;
  problem: "not_found" | "not_at_warehouse" | null;
}

/**
 * Matches uploaded codes to masters of the line: our SKU first, then the warehouse's own code at THIS connection
 * (VendorProduct.vendorId / vendorCode). EAN is never used. A master without a product at the warehouse cannot be
 * received there (the warehouse would not know it).
 */
export async function resolveInboundLines(
  ctx: StockCtx,
  connectionId: string,
  lines: { row: number; code: string; quantity: number }[],
): Promise<ResolvedLine[]> {
  await connectionInScope(ctx, connectionId);
  const db = accountDb(ctx.accountId);
  const codes = [...new Set(lines.map((l) => l.code))];
  const [bySku, byVendor] = await Promise.all([
    db.product.findMany({
      where: {
        archived: false,
        AND: [
          boardProductWhere(ctx),
          { OR: codes.map((c) => ({ sku: { equals: c, mode: "insensitive" } })) },
        ],
      },
      select: {
        id: true,
        sku: true,
        name: true,
        vendorProducts: { where: { connectionId, archived: false }, select: { vendorId: true } },
      },
    }),
    db.vendorProduct.findMany({
      where: {
        connectionId,
        archived: false,
        productId: { not: null },
        OR: codes.flatMap((c) => [
          { vendorId: { equals: c, mode: "insensitive" as const } },
          { vendorCode: { equals: c, mode: "insensitive" as const } },
        ]),
        product: { is: { archived: false, AND: [boardProductWhere(ctx)] } },
      },
      select: { vendorId: true, vendorCode: true, product: { select: { id: true, sku: true, name: true } } },
    }),
  ]);
  return lines.map((l) => {
    const up = l.code.toUpperCase();
    const p = bySku.find((x) => x.sku.toUpperCase() === up);
    if (p)
      return {
        ...l,
        productId: p.id,
        sku: p.sku,
        name: p.name,
        vendorId: p.vendorProducts[0]?.vendorId ?? null,
        problem: p.vendorProducts.length ? null : "not_at_warehouse",
      };
    const v = byVendor.find((x) => x.vendorId.toUpperCase() === up || x.vendorCode?.toUpperCase() === up);
    if (v)
      return {
        ...l,
        productId: v.product!.id,
        sku: v.product!.sku,
        name: v.product!.name,
        vendorId: v.vendorId,
        problem: null,
      };
    return { ...l, productId: null, sku: null, name: null, vendorId: null, problem: "not_found" };
  });
}

/** Product picker: masters of the line that the warehouse knows, by SKU / name / warehouse code. */
export async function pickProducts(ctx: StockCtx, connectionId: string, q: string, take = 20) {
  await connectionInScope(ctx, connectionId);
  const query = q.trim();
  if (query.length < 2) return [];
  const contains = { contains: query, mode: "insensitive" as const };
  return accountDb(ctx.accountId).product.findMany({
    where: {
      archived: false,
      vendorProducts: { some: { connectionId, archived: false } },
      AND: [
        boardProductWhere(ctx),
        {
          OR: [
            { sku: contains },
            { name: contains },
            {
              vendorProducts: {
                some: { connectionId, OR: [{ vendorId: contains }, { vendorCode: contains }] },
              },
            },
          ],
        },
      ],
    },
    select: {
      id: true,
      sku: true,
      name: true,
      vendorProducts: { where: { connectionId, archived: false }, select: { vendorId: true }, take: 1 },
    },
    orderBy: { sku: "asc" },
    take,
  });
}

// ───────────── creation ─────────────

const RequestToken = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);
const Date10 = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();

export const InboundInput = z.object({
  connectionId: z.string().min(1).max(64),
  /** Generated once when the form opens: the same token never creates a second receipt / booking. */
  requestToken: RequestToken,
  name: z.string().trim().min(1).max(50),
  expectedDate: Date10,
  trackingCode: z.string().trim().max(50).optional(),
  /** FHB parcel service code (GET /parcel-service) — optional. */
  deliveryService: z.string().trim().max(100).optional(),
  /** euShipments warehouse (fulfilment/warehouses) — required for a booking. */
  warehouseId: z.coerce.number().int().positive().optional(),
  courierInc: z.string().trim().max(50).optional(),
  packagesCount: z.coerce.number().int().min(1).max(10_000).optional(),
  lines: z
    .array(
      z.object({ productId: z.string().min(1).max(64), quantity: z.number().int().min(1).max(1_000_000) }),
    )
    .min(1)
    .max(MAX_INBOUND_LINES),
});
export type InboundInput = z.input<typeof InboundInput>;

/** `IN-XXXXXXXXXXXXXXXX` for euShipments bookings: printable ASCII, deterministic per (account, connection, token). */
export function bookingDocumentNumber(accountId: string, connectionId: string, requestToken: string) {
  const h = createHash("sha256")
    .update(`booking\n${accountId}\n${connectionId}\n${requestToken}`)
    .digest("hex");
  return `IN-${h.slice(0, 16).toUpperCase()}`;
}

/** Sums duplicate products (pure). */
export function mergeLines(lines: { productId: string; quantity: number }[]) {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l.productId, (m.get(l.productId) ?? 0) + l.quantity);
  return [...m.entries()].map(([productId, quantity]) => ({ productId, quantity }));
}

export async function createInbound(ctx: Ctx, raw: InboundInput) {
  assertCan(ctx.role, "inbound.manage");
  const input = InboundInput.parse(raw);
  const connection = await connectionInScope(ctx, input.connectionId);
  const lines = mergeLines(input.lines);
  // Every product must be a master of the member's line (the vendor services check the warehouse mapping).
  const allowed = await accountDb(ctx.accountId).product.count({
    where: { id: { in: lines.map((l) => l.productId) }, archived: false, AND: [boardProductWhere(ctx)] },
  });
  if (allowed !== lines.length) throw new DomainError("product_not_in_line");
  if (connection.type === "FHB_V3") {
    const r = await createFhbStockReceipt(ctx, {
      connectionId: connection.id,
      requestToken: input.requestToken,
      name: input.name,
      lines,
      expectedDate: input.expectedDate,
      trackingCode: input.trackingCode || undefined,
      deliveryService: input.deliveryService || undefined,
    });
    return { inboundId: r.inbound.id, created: r.created };
  }
  if (!input.warehouseId) throw new DomainError("warehouse_required");
  const documentNumber = bookingDocumentNumber(ctx.accountId, connection.id, input.requestToken);
  try {
    const r = await queueEuBooking(ctx, {
      connectionId: connection.id,
      warehouseId: input.warehouseId,
      documentNumber,
      deliveryDate: input.expectedDate,
      courierInc: input.courierInc || undefined,
      trackNumb: input.trackingCode || undefined,
      packagesCount: input.packagesCount,
      lines,
    });
    return { inboundId: r.inbound.id, created: true };
  } catch (err) {
    // Same token again (double click / retried action): the booking already exists — show it, send nothing new.
    if (err instanceof DomainError && err.code === "duplicate_reference") {
      const existing = await accountDb(ctx.accountId).inboundShipment.findUnique({
        where: { connectionId_externalRef: { connectionId: connection.id, externalRef: documentNumber } },
        select: { id: true },
      });
      if (existing) return { inboundId: existing.id, created: false };
    }
    throw err;
  }
}

// ───────────── lists ─────────────

export const INBOUND_PAGE_SIZE = 50;
export const INBOUND_TABS = ["open", "differences", "closed", "all"] as const;
export type InboundTab = (typeof INBOUND_TABS)[number];
/** Our side before the warehouse answered, or after a refusal. */
const NOT_SENT = ["QUEUED", "SUBMIT_FAILED", "FAILED", "UNCERTAIN"];

/** Pure: per-line and total difference (received − expected), null while nothing is received. */
export function inboundTotals(lines: { expectedQty: number; receivedQty: number | null }[]) {
  const expected = lines.reduce((s, l) => s + l.expectedQty, 0);
  const anyReceived = lines.some((l) => l.receivedQty !== null);
  const received = lines.reduce((s, l) => s + (l.receivedQty ?? 0), 0);
  const differing = lines.filter((l) => l.receivedQty !== null && l.receivedQty !== l.expectedQty).length;
  return { expected, received: anyReceived ? received : null, differing };
}

export async function listInbounds(
  ctx: StockCtx,
  opts: { tab?: InboundTab; connectionId?: string; q?: string; page?: number } = {},
) {
  const db = accountDb(ctx.accountId);
  const conns = await inboundConnections(ctx);
  const ids = conns.map((c) => c.id).filter((id) => !opts.connectionId || id === opts.connectionId);
  const q = opts.q?.trim() ?? "";
  const base: Prisma.InboundShipmentWhereInput = {
    connectionId: { in: ids },
    ...(q
      ? {
          OR: [
            { externalRef: { contains: q, mode: "insensitive" } },
            { vendorId: q },
            { tracking: { contains: q, mode: "insensitive" } },
            { lines: { some: { product: { sku: { contains: q, mode: "insensitive" } } } } },
          ],
        }
      : {}),
  };
  const closed: Prisma.InboundShipmentWhereInput = { status: { in: [...CLOSED_INBOUND] } };
  const tabWhere: Record<InboundTab, Prisma.InboundShipmentWhereInput> = {
    open: { NOT: closed },
    differences: { lines: { some: { receivedQty: { not: null } } } },
    closed,
    all: {},
  };
  const tab = opts.tab ?? "open";
  const rows = await db.inboundShipment.findMany({
    where: { ...base, ...tabWhere[tab] },
    include: {
      connection: { select: { id: true, name: true, type: true } },
      lines: { select: { expectedQty: true, receivedQty: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 2000,
  });
  const withTotals = rows
    .map((r) => ({ ...r, totals: inboundTotals(r.lines) }))
    .filter((r) => tab !== "differences" || r.totals.differing > 0);
  const counts = Object.fromEntries(
    await Promise.all(
      INBOUND_TABS.map(async (t) => {
        if (t !== "differences")
          return [t, await db.inboundShipment.count({ where: { ...base, ...tabWhere[t] } })];
        const d = await db.inboundShipment.findMany({
          where: { ...base, ...tabWhere.differences },
          select: { lines: { select: { expectedQty: true, receivedQty: true } } },
          take: 2000,
        });
        return [t, d.filter((x) => inboundTotals(x.lines).differing > 0).length];
      }),
    ),
  ) as Record<InboundTab, number>;
  const page = Math.max(1, opts.page ?? 1);
  return {
    connections: conns,
    counts,
    total: withTotals.length,
    rows: withTotals.slice((page - 1) * INBOUND_PAGE_SIZE, page * INBOUND_PAGE_SIZE),
  };
}

export async function inboundDetail(ctx: StockCtx, inboundId: string) {
  const db = accountDb(ctx.accountId);
  const conns = await inboundConnections(ctx);
  const inbound = await db.inboundShipment.findFirst({
    where: { id: inboundId, connectionId: { in: conns.map((c) => c.id) } },
    include: {
      connection: { select: { id: true, name: true, type: true, liveMode: true } },
      lines: {
        include: { product: { select: { id: true, sku: true, name: true, isTester: true } } },
        orderBy: { id: "asc" },
      },
    },
  });
  if (!inbound) return null;
  const keys =
    inbound.connection.type === "FHB_V3"
      ? [`fhb.stockReceipt.create:${inbound.externalRef}`, `fhb.stockReceipt.delete:${inbound.externalRef}`]
      : [`booking:${inbound.id}`];
  const [requests, alerts] = await Promise.all([
    db.outboundRequest.findMany({
      where: {
        connectionId: inbound.connectionId,
        OR: [
          { idempotencyKey: { in: keys } },
          { idempotencyKey: { startsWith: `fhb.stockReceipt.update:${inbound.externalRef}` } },
        ],
      },
      select: {
        id: true,
        operation: true,
        status: true,
        evaluatedMode: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    db.alert.findMany({
      where: { entityType: "InboundShipment", entityId: inbound.id },
      select: { id: true, kind: true, title: true, body: true, status: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  return { inbound, requests, alerts, totals: inboundTotals(inbound.lines) };
}

// ───────────── FHB received quantities (read-only) ─────────────

const FHB_DONE = ["deleted"];
const FHB_POLL_DAYS = 120;

/** GET /stock-receipt for our open FHB receipts (allowed in every mode: it only reads). */
export async function pollFhbReceipts(
  accountId: string,
  connectionId: string,
  client?: FhbClient,
  now: Date = new Date(),
) {
  const db = accountDb(accountId);
  const inbounds = await db.inboundShipment.findMany({
    where: {
      connectionId,
      vendorId: { not: null },
      status: { notIn: [...FHB_DONE, ...NOT_SENT] },
      createdAt: { gte: new Date(now.getTime() - FHB_POLL_DAYS * 86_400_000) },
    },
    select: { id: true, externalRef: true },
    take: 500,
  });
  if (!inbounds.length) return { checked: 0, missing: 0 };
  const c = client ?? (await fhbClientForConnection(accountId, connectionId));
  let checked = 0;
  let missing = 0;
  for (const i of inbounds) {
    try {
      const view = await c.getStockReceipt(i.externalRef);
      if (!view) {
        missing++;
        continue;
      }
      await applyFhbStockReceipt(accountId, connectionId, view);
      checked++;
    } catch (err) {
      logger.warn({ inboundId: i.id, err: scrubText((err as Error).message) }, "fhb receipt read failed");
    }
  }
  return { checked, missing };
}

// ───────────── discrepancy + overdue tasks ─────────────

export const INBOUND_ALERT_KINDS = ["fhb_inbound_discrepancy", "inbound_overdue"] as const;
/** Days after the expected date with nothing received before an "overdue" task. */
export const OVERDUE_DAYS = 3;

/**
 * FHB: once FHB has moved a receipt out of `created` (the only documented state; it is received or being
 * received), any line whose received ≠ expected opens one task. Both vendors: nothing received OVERDUE_DAYS after
 * the expected date → task. Resolved automatically when the numbers match / something arrives.
 * (euShipments differences are raised by its booking poller as eushipments_inbound_discrepancy.)
 */
export async function sweepInboundAlerts(now: Date = new Date()) {
  const db = systemDb();
  const open = await db.inboundShipment.findMany({
    where: { status: { notIn: [...CLOSED_INBOUND, ...NOT_SENT] }, vendorId: { not: null } },
    include: {
      connection: { select: { type: true } },
      lines: { include: { product: { select: { sku: true } } } },
    },
    take: 2000,
  });
  const wanted = new Map<
    string,
    { accountId: string; kind: string; entityId: string; title: string; body: string }
  >();
  for (const i of open) {
    const received = i.lines.some((l) => (l.receivedQty ?? 0) > 0);
    if (i.connection.type === "FHB_V3" && i.status !== "created") {
      const diffs = i.lines.filter((l) => (l.receivedQty ?? 0) !== l.expectedQty);
      if (diffs.length)
        wanted.set(`fhb_inbound_discrepancy:${i.id}`, {
          accountId: i.accountId,
          kind: "fhb_inbound_discrepancy",
          entityId: i.id,
          title: `FHB: stock receipt ${i.externalRef} received with differences`,
          body: diffs
            .map((l) => `${l.product.sku}: expected ${l.expectedQty}, received ${l.receivedQty ?? 0}`)
            .join("\n"),
        });
    }
    if (!received && i.expectedAt && now.getTime() - i.expectedAt.getTime() > OVERDUE_DAYS * 86_400_000)
      wanted.set(`inbound_overdue:${i.id}`, {
        accountId: i.accountId,
        kind: "inbound_overdue",
        entityId: i.id,
        title: `Inbound ${i.externalRef} is overdue`,
        body: `expected ${i.expectedAt.toISOString().slice(0, 10)}, nothing received yet`,
      });
  }
  const existing = await db.alert.findMany({
    where: {
      kind: { in: [...INBOUND_ALERT_KINDS] },
      entityType: "InboundShipment",
      status: { not: "RESOLVED" },
    },
    select: { id: true, accountId: true, kind: true, entityId: true },
  });
  const have = new Set(existing.map((a) => `${a.kind}:${a.entityId}`));
  let created = 0;
  let resolved = 0;
  for (const [key, w] of wanted) {
    if (have.has(key)) continue;
    await db.alert.create({
      data: {
        accountId: w.accountId,
        kind: w.kind,
        isTask: true,
        severity: "WARNING",
        title: w.title.slice(0, 300),
        body: w.body.slice(0, 2000),
        entityType: "InboundShipment",
        entityId: w.entityId,
      },
    });
    created++;
  }
  const stillOpen = new Set(open.map((i) => i.id));
  for (const a of existing) {
    if (wanted.has(`${a.kind}:${a.entityId}`)) continue;
    // A receipt that left the open set (closed/deleted) keeps its discrepancy task for a person to close.
    if (a.kind === "fhb_inbound_discrepancy" && !stillOpen.has(a.entityId!)) continue;
    const res = await db.alert.updateMany({
      where: { id: a.id, status: { not: "RESOLVED" } },
      data: { status: "RESOLVED", resolvedAt: now },
    });
    if (res.count === 1) {
      await db.alertNote.create({
        data: { accountId: a.accountId, alertId: a.id, action: "auto_resolve", note: "condition cleared" },
      });
      resolved++;
    }
  }
  return { created, resolved };
}
