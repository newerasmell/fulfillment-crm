import { z } from "zod";
import type { CrmOrderStatus, Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { companyFilter } from "@/server/companies";
import { safeTimeZone, zonedDay, zonedDayEnd, zonedDayStart } from "@/lib/tz";
import { accountDb, systemDb } from "@/server/db/client";
import type { BoardCtx } from "@/server/returns/board";
import type { ScopedActor } from "@/server/stores";

/**
 * Товарителници (P10-01): every shipment the CRM knows, in one list — Fulfillment rows of FHB, FHB Joy and
 * euShipments (incl. rerouted / cancelled ones) and the shipments behind manual shipments (Joy labels, AWBs,
 * pre-AWBs, warehouse manual orders once queued: each has its Fulfillment row). Reads the local tables only (the
 * FHB / euShipments read syncs and callbacks keep them current); never a vendor call. Scoped by account
 * (accountDb) and by the member's companies / sidebar company / line (companyFilter on the order).
 */

export const SHIPMENT_TABS = [
  "preparing",
  "shipped",
  "delivered",
  "returning",
  "problem",
  "cancelled",
  "all",
] as const;
export type ShipmentTab = (typeof SHIPMENT_TABS)[number];
/** Extra chip next to the tabs: shipped but not delivered after N days. */
export type ShipmentView = ShipmentTab | "delayed";
export const PAGE_SIZE = 50;
export const EXPORT_CAP = 20_000;
export const DEFAULT_DELAYED_DAYS = 7;

export const STATUS_GROUPS: Record<Exclude<ShipmentTab, "all">, readonly CrmOrderStatus[]> = {
  preparing: [
    "IMPORTED",
    "CHECKING",
    "NEEDS_REVIEW",
    "READY",
    "APPROVED",
    "QUEUED",
    "SUBMITTING",
    "ACCEPTED",
    "PROCESSING",
  ],
  shipped: ["SHIPPED"],
  delivered: ["DELIVERED", "COD_PAID", "FULFILLED_EXTERNALLY"],
  returning: ["RETURNING", "RETURN_RECEIVED"],
  problem: ["SUBMIT_FAILED", "EXCEPTION", "ON_HOLD", "BLOCKED", "UNKNOWN"],
  cancelled: ["CANCELLED"],
};

export function statusGroup(status: CrmOrderStatus): Exclude<ShipmentTab, "all"> {
  for (const [g, list] of Object.entries(STATUS_GROUPS))
    if (list.includes(status)) return g as Exclude<ShipmentTab, "all">;
  return "problem";
}

export const isShipmentView = (v: unknown): v is ShipmentView =>
  typeof v === "string" && ((SHIPMENT_TABS as readonly string[]).includes(v) || v === "delayed");

const DateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)));

export interface ShipmentFilter {
  view?: ShipmentView;
  connectionId?: string;
  carrier?: string;
  /** YYYY-MM-DD, created at (inclusive, calendar days in the account's time zone). */
  from?: string;
  to?: string;
  q?: string;
  /** Connection types of the header warehouse scope (all / FHB / euShipments). */
  connectionTypes?: readonly string[];
  page?: number;
}

/** Parses the board's URL parameters (Zod at the boundary: anything malformed is dropped). */
export function parseShipmentFilter(sp: Record<string, string | undefined>): ShipmentFilter {
  const short = (v: string | undefined, n: number) => (v ? v.trim().slice(0, n) || undefined : undefined);
  const date = (v: string | undefined) => (v && DateParam.safeParse(v).success ? v : undefined);
  const page = Number(sp.page);
  return {
    view: isShipmentView(sp.tab) ? sp.tab : undefined,
    connectionId: short(sp.connection, 64),
    carrier: short(sp.carrier, 64),
    from: date(sp.from),
    to: date(sp.to),
    q: short(sp.q, 80),
    page: Number.isInteger(page) && page > 0 && page < 10_000 ? page : 1,
  };
}

// ───────────────────────── settings ─────────────────────────

export async function getShipmentSettings(accountId: string) {
  const s = await accountDb(accountId).shipmentBoardSettings.findUnique({ where: { accountId } });
  return { delayedDays: s?.delayedDays ?? DEFAULT_DELAYED_DAYS };
}

const SettingsInput = z.object({ delayedDays: z.coerce.number().int().min(1).max(60) });

export async function updateShipmentSettings(actor: ScopedActor, input: { delayedDays: unknown }) {
  assertCan(actor.role, "shipments.settings");
  const v = SettingsInput.parse(input);
  const before = await getShipmentSettings(actor.accountId);
  await accountDb(actor.accountId).shipmentBoardSettings.upsert({
    where: { accountId: actor.accountId },
    create: { accountId: actor.accountId, delayedDays: v.delayedDays },
    update: { delayedDays: v.delayedDays },
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "shipments.settings",
    entityType: "ShipmentBoardSettings",
    entityId: actor.accountId,
    before,
    after: v,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return v;
}

// ───────────────────────── where ─────────────────────────

const scopeWhere = (ctx: BoardCtx): Prisma.FulfillmentWhereInput => ({
  order: companyFilter({
    companyScope: ctx.companyScope ?? null,
    activeCompanyId: ctx.activeCompanyId ?? null,
    lineCompanyIds: ctx.lineCompanyIds ?? null,
  }),
});

const DAY = 86_400_000;

export function delayedWhere(delayedDays: number, now: Date): Prisma.FulfillmentWhereInput {
  const before = new Date(now.getTime() - delayedDays * DAY);
  return {
    status: "SHIPPED",
    deliveredAt: null,
    OR: [{ shippedAt: { lte: before } }, { shippedAt: null, createdAt: { lte: before } }],
  };
}

function viewWhere(view: ShipmentView, delayedDays: number, now: Date): Prisma.FulfillmentWhereInput {
  if (view === "all") return {};
  if (view === "delayed") return delayedWhere(delayedDays, now);
  return { status: { in: [...STATUS_GROUPS[view]] } };
}

/** Search: order number, our shipment id, vendor ids, tracking number (exact), customer name, phone. */
export function searchWhere(raw: string): Prisma.FulfillmentWhereInput {
  const q = raw.trim().slice(0, 80);
  const phone = q.replace(/[\s()/-]/g, "");
  const or: Prisma.FulfillmentWhereInput[] = [
    { order: { number: { contains: q, mode: "insensitive" } } },
    { externalId: { contains: q, mode: "insensitive" } },
    { vendorOrderId: { equals: q } },
    { vendorUid: { equals: q } },
    { trackingNumbers: { has: q } },
    { order: { customerName: { contains: q, mode: "insensitive" } } },
  ];
  if (q.toUpperCase() !== q) or.push({ trackingNumbers: { has: q.toUpperCase() } });
  if (/^\+?\d{5,}$/.test(phone)) or.push({ order: { phone: { contains: phone.replace(/^\+/, "") } } });
  return { OR: or };
}

/** The account's time zone (Account.timezone, default Europe/Sofia): date filters and CSV dates use its days. */
export async function accountTimeZone(accountId: string) {
  const a = await systemDb().account.findUnique({ where: { id: accountId }, select: { timezone: true } });
  return safeTimeZone(a?.timezone);
}

function baseWhere(ctx: BoardCtx, f: ShipmentFilter, tz: string): Prisma.FulfillmentWhereInput {
  const and: Prisma.FulfillmentWhereInput[] = [scopeWhere(ctx)];
  if (f.connectionTypes) and.push({ connection: { type: { in: f.connectionTypes as never } } });
  if (f.connectionId) and.push({ connectionId: f.connectionId });
  if (f.carrier) and.push({ carrier: f.carrier });
  if (f.from) and.push({ createdAt: { gte: zonedDayStart(f.from, tz) } });
  if (f.to) and.push({ createdAt: { lt: zonedDayEnd(f.to, tz) } });
  if (f.q) and.push(searchWhere(f.q));
  return { AND: and };
}

const SELECT = {
  id: true,
  externalId: true,
  vendorOrderId: true,
  vendorUid: true,
  carrier: true,
  status: true,
  rawStatus: true,
  trackingNumbers: true,
  trackingUrls: true,
  codStatus: true,
  submittedAt: true,
  shippedAt: true,
  deliveredAt: true,
  createdAt: true,
  updatedAt: true,
  connectionId: true,
  connection: { select: { id: true, name: true, type: true } },
  order: {
    select: {
      id: true,
      number: true,
      companyId: true,
      customerName: true,
      phone: true,
      countryCode: true,
      paymentMethod: true,
      currency: true,
      codAmount: true,
      codLocalAmount: true,
      codLocalCurrency: true,
    },
  },
  manualShipment: { select: { kind: true } },
  reroutesFrom: { select: { status: true, toConnectionId: true }, orderBy: { createdAt: "desc" }, take: 1 },
  fhbTicket: { select: { id: true, state: true } },
} satisfies Prisma.FulfillmentSelect;

type Row = Prisma.FulfillmentGetPayload<{ select: typeof SELECT }>;

// ───────────────────────── view helpers ─────────────────────────

const safeUrl = (u: string) => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
};

/** Tracking numbers with their link when the vendor gave one per number; extra links are listed after. */
export function trackingLinks(numbers: string[], urls: string[]) {
  const clean = urls.map(safeUrl);
  if (numbers.length > 0 && numbers.length === urls.length)
    return {
      items: numbers.map((n, i) => ({ number: n, url: clean[i] ?? null })),
      extraUrls: [] as string[],
    };
  return {
    items: numbers.map((n) => ({ number: n, url: null as string | null })),
    extraUrls: clean.filter((u): u is string => !!u),
  };
}

/** Days from creation until delivery (or until now / cancellation for shipments still open or cancelled). */
export function ageDays(
  r: { createdAt: Date; submittedAt: Date | null; deliveredAt: Date | null; updatedAt: Date; status: string },
  now: Date,
) {
  const start = r.submittedAt ?? r.createdAt;
  const end = r.deliveredAt ?? (r.status === "CANCELLED" ? r.updatedAt : now);
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / DAY));
}

const num = (d: Prisma.Decimal | null) => (d == null ? null : Number(d));

function codOf(o: Row["order"]) {
  if (o.paymentMethod !== "COD") return null;
  if (o.codLocalAmount != null && o.codLocalCurrency)
    return { amount: num(o.codLocalAmount)!, currency: o.codLocalCurrency };
  if (o.codAmount != null) return { amount: num(o.codAmount)!, currency: o.currency };
  return null;
}

/** Carrier codes → names from the mirrors (FHB parcel services, euShipments couriers); unknown codes stay raw. */
async function carrierNames(
  accountId: string,
  pairs: { connectionId: string; type: string; carrier: string }[],
) {
  const db = accountDb(accountId);
  const fhb = pairs.filter((p) => p.type === "FHB_V3");
  const eu = pairs.filter((p) => p.type === "EUSHIPMENTS" && /^\d{1,9}$/.test(p.carrier));
  const [fhbRows, euRows] = await Promise.all([
    fhb.length
      ? db.fhbCarrier.findMany({
          where: {
            connectionId: { in: [...new Set(fhb.map((p) => p.connectionId))] },
            code: { in: [...new Set(fhb.map((p) => p.carrier))] },
          },
          select: { connectionId: true, code: true, name: true },
        })
      : [],
    eu.length
      ? db.eushipmentsCourier.findMany({
          where: {
            connectionId: { in: [...new Set(eu.map((p) => p.connectionId))] },
            courierId: { in: [...new Set(eu.map((p) => Number(p.carrier)))] },
          },
          select: { connectionId: true, courierId: true, name: true },
        })
      : [],
  ]);
  const m = new Map<string, string>();
  for (const r of fhbRows) if (r.name) m.set(`${r.connectionId}:${r.code}`, r.name);
  for (const r of euRows) m.set(`${r.connectionId}:${r.courierId}`, r.name);
  return (connectionId: string, carrier: string | null) =>
    carrier ? (m.get(`${connectionId}:${carrier}`) ?? carrier) : null;
}

async function companiesOf(accountId: string, ids: string[]) {
  const rows = ids.length
    ? await accountDb(accountId).company.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, line: { select: { name: true, color: true } } },
      })
    : [];
  return new Map(rows.map((c) => [c.id, c]));
}

/**
 * The shipment that carries each order's COD: the order's latest non-cancelled Fulfillment. A rerouted order
 * (cancelled original + new shipment) or a reship shows the amount once, never on a cancelled row.
 */
async function codCarriers(accountId: string, orderIds: string[]) {
  if (!orderIds.length) return new Map<string, string>();
  const rows = await accountDb(accountId).fulfillment.findMany({
    where: { orderId: { in: orderIds }, status: { not: "CANCELLED" } },
    select: { id: true, orderId: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const m = new Map<string, string>();
  for (const r of rows) if (!m.has(r.orderId)) m.set(r.orderId, r.id);
  return m;
}

async function toViews(accountId: string, rows: Row[], delayedDays: number, now: Date) {
  const codOrderIds = [
    ...new Set(rows.filter((r) => r.order.paymentMethod === "COD").map((r) => r.order.id)),
  ];
  const [carrierName, companies, codCarrier] = await Promise.all([
    carrierNames(
      accountId,
      rows
        .filter((r) => r.carrier)
        .map((r) => ({ connectionId: r.connectionId, type: r.connection.type, carrier: r.carrier! })),
    ),
    companiesOf(accountId, [...new Set(rows.map((r) => r.order.companyId).filter((x): x is string => !!x))]),
    codCarriers(accountId, codOrderIds),
  ]);
  const delayedBefore = now.getTime() - delayedDays * DAY;
  return rows.map((r) => {
    const company = r.order.companyId ? companies.get(r.order.companyId) : undefined;
    const reroute = r.reroutesFrom[0];
    return {
      id: r.id,
      externalId: r.externalId,
      vendorOrderId: r.vendorOrderId,
      status: r.status,
      group: statusGroup(r.status),
      rawStatus: r.rawStatus,
      connection: r.connection,
      carrier: r.carrier,
      carrierName: carrierName(r.connectionId, r.carrier),
      tracking: trackingLinks(r.trackingNumbers, r.trackingUrls),
      trackingNumbers: r.trackingNumbers,
      cod: codCarrier.get(r.order.id) === r.id ? codOf(r.order) : null,
      codStatus: r.codStatus,
      createdAt: r.createdAt,
      submittedAt: r.submittedAt,
      shippedAt: r.shippedAt,
      deliveredAt: r.deliveredAt,
      ageDays: ageDays(r, now),
      delayed:
        r.status === "SHIPPED" && !r.deliveredAt && (r.shippedAt ?? r.createdAt).getTime() <= delayedBefore,
      manualKind: r.manualShipment?.kind ?? null,
      rerouted: reroute ? { status: reroute.status } : null,
      ticket: r.fhbTicket ? { id: r.fhbTicket.id, state: r.fhbTicket.state } : null,
      order: {
        id: r.order.id,
        number: r.order.number,
        customerName: r.order.customerName,
        phone: r.order.phone,
        country: r.order.countryCode,
      },
      company: company ? { name: company.name, line: company.line } : null,
    };
  });
}
export type ShipmentRowView = Awaited<ReturnType<typeof toViews>>[number];

// ───────────────────────── list / export / detail ─────────────────────────

export async function listShipments(ctx: BoardCtx, f: ShipmentFilter = {}, now = new Date()) {
  assertCan(ctx.role, "account.read");
  const db = accountDb(ctx.accountId);
  const [settings, tz] = await Promise.all([
    getShipmentSettings(ctx.accountId),
    accountTimeZone(ctx.accountId),
  ]);
  const base = baseWhere(ctx, f, tz);
  const view = f.view ?? "all";
  const where = { AND: [base, viewWhere(view, settings.delayedDays, now)] };
  const [total, ...counts] = await Promise.all([
    db.fulfillment.count({ where }),
    ...SHIPMENT_TABS.map((t) =>
      db.fulfillment.count({ where: { AND: [base, viewWhere(t, settings.delayedDays, now)] } }),
    ),
    db.fulfillment.count({ where: { AND: [base, delayedWhere(settings.delayedDays, now)] } }),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, f.page ?? 1), pages);
  const rows = await db.fulfillment.findMany({
    where,
    select: SELECT,
    orderBy:
      view === "delayed"
        ? [{ shippedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }]
        : [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });
  const tabCounts = Object.fromEntries(SHIPMENT_TABS.map((t, i) => [t, counts[i] ?? 0])) as Record<
    ShipmentTab,
    number
  >;
  return {
    settings,
    counts: { ...tabCounts, delayed: counts[SHIPMENT_TABS.length] ?? 0 },
    total,
    page,
    pages,
    rows: await toViews(ctx.accountId, rows, settings.delayedDays, now),
  };
}

/** Filter options: the warehouses and carriers that occur in the member's shipments. */
export async function shipmentFilterOptions(ctx: BoardCtx, f: Pick<ShipmentFilter, "connectionTypes"> = {}) {
  assertCan(ctx.role, "account.read");
  const db = accountDb(ctx.accountId);
  const where: Prisma.FulfillmentWhereInput = {
    AND: [
      scopeWhere(ctx),
      ...(f.connectionTypes ? [{ connection: { type: { in: f.connectionTypes as never } } }] : []),
    ],
  };
  const groups = await db.fulfillment.groupBy({ by: ["connectionId", "carrier"], where });
  const connections = await db.fulfillmentConnection.findMany({
    where: { id: { in: [...new Set(groups.map((g) => g.connectionId))] } },
    select: { id: true, name: true, type: true },
    orderBy: { name: "asc" },
  });
  const typeOf = new Map(connections.map((c) => [c.id, c.type]));
  const name = await carrierNames(
    ctx.accountId,
    groups
      .filter((g) => g.carrier)
      .map((g) => ({
        connectionId: g.connectionId,
        type: typeOf.get(g.connectionId) ?? "",
        carrier: g.carrier!,
      })),
  );
  const carriers = new Map<string, string>();
  for (const g of groups)
    if (g.carrier) carriers.set(g.carrier, name(g.connectionId, g.carrier) ?? g.carrier);
  return {
    connections,
    carriers: [...carriers]
      .map(([code, label]) => ({ code, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

/**
 * CSV rows of the current filter (every page, capped at EXPORT_CAP). COD only for roles that may see it.
 * Keyset pages on (createdAt, id) so shipments created during the export never repeat or skip rows; dates are
 * days in the account's time zone.
 */
export async function exportShipmentsCsv(
  ctx: BoardCtx,
  f: ShipmentFilter = {},
  opts: { withCod: boolean },
  now = new Date(),
) {
  assertCan(ctx.role, "account.read");
  if (opts.withCod) assertCan(ctx.role, "cod.read");
  const db = accountDb(ctx.accountId);
  const [settings, tz] = await Promise.all([
    getShipmentSettings(ctx.accountId),
    accountTimeZone(ctx.accountId),
  ]);
  const where = { AND: [baseWhere(ctx, f, tz), viewWhere(f.view ?? "all", settings.delayedDays, now)] };
  const iso = (d: Date | null) => (d ? zonedDay(d, tz) : "");
  const header = [
    "order",
    "shipment",
    "company",
    "warehouse",
    "carrier",
    "tracking",
    "status",
    "vendor_status",
    "customer",
    "country",
    ...(opts.withCod ? ["cod", "cod_currency"] : []),
    "created",
    "submitted",
    "shipped",
    "delivered",
    "age_days",
    "delayed",
    "manual_kind",
  ];
  const out: string[][] = [header];
  let cursor: { createdAt: Date; id: string } | null = null;
  for (let done = 0; done < EXPORT_CAP;) {
    const after: Prisma.FulfillmentWhereInput[] = cursor
      ? [
          {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          },
        ]
      : [];
    const rows: Row[] = await db.fulfillment.findMany({
      where: { AND: [where, ...after] },
      select: SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.min(1000, EXPORT_CAP - done),
    });
    done += rows.length;
    const last = rows.at(-1);
    if (last) cursor = { createdAt: last.createdAt, id: last.id };
    for (const v of await toViews(ctx.accountId, rows, settings.delayedDays, now))
      out.push([
        v.order.number,
        v.externalId,
        v.company?.name ?? "",
        v.connection.name,
        v.carrierName ?? "",
        v.trackingNumbers.join(" "),
        v.status,
        v.rawStatus ?? "",
        v.order.customerName ?? "",
        v.order.country ?? "",
        ...(opts.withCod ? [v.cod ? v.cod.amount.toFixed(2) : "", v.cod?.currency ?? ""] : []),
        iso(v.createdAt),
        iso(v.submittedAt),
        iso(v.shippedAt),
        iso(v.deliveredAt),
        String(v.ageDays),
        v.delayed ? "yes" : "",
        v.manualKind ?? "",
      ]);
    if (rows.length < 1000) break;
  }
  return out;
}

/** Detail drawer: the shipment (same scope as the board) with its vendor events and ticket. */
export async function getShipment(ctx: BoardCtx, id: string, now = new Date()) {
  assertCan(ctx.role, "account.read");
  const sid = z.string().min(1).max(64).parse(id);
  const db = accountDb(ctx.accountId);
  const row = await db.fulfillment.findFirst({
    where: { AND: [{ id: sid }, scopeWhere(ctx)] },
    select: SELECT,
  });
  if (!row) throw new DomainError("not_found");
  const settings = await getShipmentSettings(ctx.accountId);
  const [view] = await toViews(ctx.accountId, [row], settings.delayedDays, now);
  const [events, extra, ticket] = await Promise.all([
    db.fulfillmentEvent.findMany({
      where: { fulfillmentId: sid },
      orderBy: { occurredAt: "desc" },
      take: 50,
      select: { id: true, occurredAt: true, source: true, rawStatus: true, status: true },
    }),
    db.fulfillment.findUnique({
      where: { id: sid },
      select: { variableSymbol: true, deliveryPoint: true, vendorUid: true },
    }),
    db.fhbTicket.findUnique({
      where: { accountId_fulfillmentId: { accountId: ctx.accountId, fulfillmentId: sid } },
      select: { id: true, state: true, eventCount: true, firstEventAt: true, lastEventAt: true },
    }),
  ]);
  return { ...view!, ...extra!, events, ticketDetail: ticket };
}
