import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { assertCan } from "@/server/auth/rbac";
import { accountDb } from "@/server/db/client";
import { DIRECTORY_PAGE_SIZE, directoryConnections, type DirectoryCtx } from "./directory";

/**
 * Фактури (P10-05). Accounting/invoicing is a v1 non-goal (SPEC §1) and no vendor reference documents an
 * invoice LIST endpoint: the warehouses' own invoices stay in their cabinets (ZOE, euShipments "Статистика →
 * Списък с фактури"). What the CRM does have are the documented per-order invoice fields FHB returns on every
 * order view (GET /order, order/history: `invoice` = PDF URL, `invoice_number`, `invoice_date`,
 * fhb-kika-v3.md "Response 200"), already stored in FhbOrderMirror.raw by the FHB read sync. This lists them.
 */

export const INVOICE_TABS = ["all", "pdf", "number"] as const;
export type InvoiceTab = (typeof INVOICE_TABS)[number];

export const InvoiceFilter = z.object({
  tab: z.enum(INVOICE_TABS).catch("all").default("all"),
  q: z.string().trim().max(80).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).catch(1).default(1),
});

/** FHB order views carry the three fields as strings; empty or missing means "none". */
const RawInvoice = z.looseObject({
  invoice: z.unknown().optional(),
  invoice_number: z.unknown().optional(),
  invoice_date: z.unknown().optional(),
});
const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;

/** Only plain http(s) links are ever rendered as links (the value came from the vendor). */
export function safeInvoiceUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const hasPdf: Prisma.FhbOrderMirrorWhereInput = { raw: { path: ["invoice"], string_contains: "http" } };
/** A non-empty invoice number (FHB sends "" or omits it when the order has none). */
const hasNumber: Prisma.FhbOrderMirrorWhereInput = {
  raw: { path: ["invoice_number"], string_contains: "" },
  NOT: { raw: { path: ["invoice_number"], equals: "" } },
};

export async function listInvoices(ctx: DirectoryCtx, raw: unknown, connectionTypes?: readonly string[]) {
  assertCan(ctx.role, "invoices.read");
  const f = InvoiceFilter.parse(raw ?? {});
  const conns = await directoryConnections(ctx, connectionTypes);
  const fhbIds = conns.filter((c) => c.type === "FHB_V3").map((c) => c.id);
  const db = accountDb(ctx.accountId);
  const q = f.q?.trim();
  const base: Prisma.FhbOrderMirrorWhereInput = {
    connectionId: { in: fhbIds },
    ...(q
      ? {
          OR: [
            { externalId: { contains: q, mode: "insensitive" } },
            { raw: { path: ["invoice_number"], string_contains: q } },
            { trackingNumbers: { has: q } },
          ],
        }
      : {}),
  };
  const tabWhere = (t: InvoiceTab): Prisma.FhbOrderMirrorWhereInput =>
    t === "pdf"
      ? hasPdf
      : t === "number"
        ? { AND: [hasNumber, { NOT: hasPdf }] }
        : { OR: [hasPdf, hasNumber] };
  const counts = Object.fromEntries(
    await Promise.all(
      INVOICE_TABS.map(
        async (t) =>
          [
            t,
            fhbIds.length ? await db.fhbOrderMirror.count({ where: { AND: [base, tabWhere(t)] } }) : 0,
          ] as const,
      ),
    ),
  ) as Record<InvoiceTab, number>;
  const total = counts[f.tab];
  const pages = Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE));
  const page = Math.min(f.page, pages);
  const rows = fhbIds.length
    ? await db.fhbOrderMirror.findMany({
        where: { AND: [base, tabWhere(f.tab)] },
        orderBy: [{ vendorCreatedAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
        skip: (page - 1) * DIRECTORY_PAGE_SIZE,
        take: DIRECTORY_PAGE_SIZE,
        select: {
          id: true,
          connectionId: true,
          externalId: true,
          rawStatus: true,
          status: true,
          country: true,
          vendorCreatedAt: true,
          lastSyncAt: true,
          raw: true,
        },
      })
    : [];
  // Our shipment (and order) for each mirror row, if the CRM created it: same deterministic external id.
  const shipments = rows.length
    ? await db.fulfillment.findMany({
        where: {
          OR: fhbIds.map((connectionId) => ({
            connectionId,
            externalId: { in: rows.filter((r) => r.connectionId === connectionId).map((r) => r.externalId) },
          })),
        },
        select: { connectionId: true, externalId: true, orderId: true, order: { select: { number: true } } },
      })
    : [];
  const shipmentOf = new Map(shipments.map((s) => [`${s.connectionId}:${s.externalId}`, s]));
  const name = new Map(conns.map((c) => [c.id, c.name]));
  return {
    filter: { ...f, page },
    counts,
    total,
    page,
    pages,
    connections: conns,
    rows: rows.map((r) => {
      const inv = RawInvoice.safeParse(r.raw ?? {});
      const s = shipmentOf.get(`${r.connectionId}:${r.externalId}`);
      return {
        id: r.id,
        connection: { id: r.connectionId, name: name.get(r.connectionId) ?? "—" },
        externalId: r.externalId,
        rawStatus: r.rawStatus,
        status: r.status,
        country: r.country,
        vendorCreatedAt: r.vendorCreatedAt,
        lastSyncAt: r.lastSyncAt,
        invoiceUrl: inv.success ? safeInvoiceUrl(inv.data.invoice) : null,
        invoiceNumber: inv.success ? str(inv.data.invoice_number) : null,
        invoiceDate: inv.success ? str(inv.data.invoice_date) : null,
        order: s ? { id: s.orderId, number: s.order.number } : null,
      };
    }),
  };
}
