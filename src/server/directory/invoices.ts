import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { assertCan } from "@/server/auth/rbac";
import { companyFilter } from "@/server/companies";
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

const RawInvoice = z.looseObject({
  invoice: z.unknown().optional(),
  invoice_number: z.unknown().optional(),
  invoice_date: z.unknown().optional(),
});
/** FHB order views carry the three fields as strings (fhb-kika-v3.md); anything else, "" or missing = none. */
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v.trim() || v : null);

/** Only plain http(s) links are ever rendered as links (the value came from the vendor). */
export function safeInvoiceUrl(v: unknown): string | null {
  if (typeof v !== "string" || !/^https?:\/\//.test(v)) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

// The same predicates as the rendering (str / safeInvoiceUrl), so tab counts and rows agree: a PDF is a
// string that STARTS with http(s)://, an invoice number is a non-empty JSON string.
const hasPdf: Prisma.FhbOrderMirrorWhereInput = {
  OR: [
    { raw: { path: ["invoice"], string_starts_with: "https://" } },
    { raw: { path: ["invoice"], string_starts_with: "http://" } },
  ],
};
const hasNumber: Prisma.FhbOrderMirrorWhereInput = {
  raw: { path: ["invoice_number"], string_starts_with: "" },
  NOT: { raw: { path: ["invoice_number"], equals: "" } },
};
/**
 * NOT on a JSON-path filter is SQL NULL (row dropped) when the key is missing or JSON null, so "no PDF" must
 * name those cases explicitly — otherwise an order without an `invoice` key falls out of the "number" tab.
 */
const noPdf: Prisma.FhbOrderMirrorWhereInput = {
  OR: [{ NOT: hasPdf }, { raw: { path: ["invoice"], equals: Prisma.AnyNull } }],
};
const TAB_WHERE: Record<InvoiceTab, Prisma.FhbOrderMirrorWhereInput> = {
  all: { OR: [hasPdf, hasNumber] },
  pdf: hasPdf,
  number: { AND: [hasNumber, noPdf] },
};

/** (connectionId, externalId) pairs as a `where`, grouped per connection. */
function pairsWhere(pairs: { connectionId: string; externalId: string }[]) {
  const by = new Map<string, string[]>();
  for (const p of pairs) by.set(p.connectionId, [...(by.get(p.connectionId) ?? []), p.externalId]);
  return [...by].map(([connectionId, ids]) => ({ connectionId, externalId: { in: ids } }));
}

/**
 * Scope is the ORDER's company, not the warehouse's: routing can ship company B's order from company A's FHB
 * warehouse (same product line), so a row of a CRM shipment (Fulfillment with the same connection + external
 * id) is visible exactly when that order's company is in the member's scope, through any FHB connection of the
 * account. A mirror row the CRM did not create falls back to the connection's company. Only the cross-company
 * shipments are loaded as id lists (out-of-scope orders on in-scope warehouses, in-scope orders on other
 * warehouses); an unrestricted member needs neither.
 */
export async function listInvoices(ctx: DirectoryCtx, raw: unknown, connectionTypes?: readonly string[]) {
  assertCan(ctx.role, "invoices.read");
  const f = InvoiceFilter.parse(raw ?? {});
  const conns = await directoryConnections(ctx, connectionTypes);
  const scopedIds = conns.filter((c) => c.type === "FHB_V3").map((c) => c.id);
  const db = accountDb(ctx.accountId);
  const allFhb =
    !connectionTypes || connectionTypes.includes("FHB_V3")
      ? await db.fulfillmentConnection.findMany({
          where: { type: "FHB_V3" },
          select: { id: true, name: true },
        })
      : [];
  const scope = companyFilter({
    companyScope: ctx.companyScope ?? null,
    activeCompanyId: ctx.activeCompanyId ?? null,
    lineCompanyIds: ctx.lineCompanyIds ?? null,
  }).companyId;
  const orderCompanies = scope === undefined ? null : typeof scope === "string" ? [scope] : scope.in;
  const inScope: Prisma.OrderWhereInput = orderCompanies ? { companyId: { in: orderCompanies } } : {};
  const otherIds = allFhb.map((c) => c.id).filter((id) => !scopedIds.includes(id));
  const [excluded, included] = orderCompanies
    ? await Promise.all([
        scopedIds.length
          ? db.fulfillment.findMany({
              where: {
                connectionId: { in: scopedIds },
                order: { OR: [{ companyId: null }, { companyId: { notIn: orderCompanies } }] },
              },
              select: { connectionId: true, externalId: true },
            })
          : [],
        otherIds.length
          ? db.fulfillment.findMany({
              where: { connectionId: { in: otherIds }, order: inScope },
              select: { connectionId: true, externalId: true },
            })
          : [],
      ])
    : [[], []];
  const visible: Prisma.FhbOrderMirrorWhereInput[] = [
    ...(scopedIds.length
      ? [
          {
            connectionId: { in: scopedIds },
            ...(excluded.length ? { NOT: { OR: pairsWhere(excluded) } } : {}),
          },
        ]
      : []),
    ...pairsWhere(included),
  ];
  const q = f.q?.trim();
  const base: Prisma.FhbOrderMirrorWhereInput = {
    OR: visible,
    ...(q
      ? {
          AND: [
            {
              OR: [
                { externalId: { contains: q, mode: "insensitive" } },
                { raw: { path: ["invoice_number"], string_contains: q } },
                { trackingNumbers: { has: q } },
              ],
            },
          ],
        }
      : {}),
  };
  // Two counts, not three: pdf and number are disjoint, so number = all − pdf.
  const [all, pdf] = visible.length
    ? await Promise.all([
        db.fhbOrderMirror.count({ where: { AND: [base, TAB_WHERE.all] } }),
        db.fhbOrderMirror.count({ where: { AND: [base, TAB_WHERE.pdf] } }),
      ])
    : [0, 0];
  const counts: Record<InvoiceTab, number> = { all, pdf, number: all - pdf };
  const total = counts[f.tab];
  const pages = Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE));
  const page = Math.min(f.page, pages);
  const rows = total
    ? await db.fhbOrderMirror.findMany({
        where: { AND: [base, TAB_WHERE[f.tab]] },
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
  // Our shipment (and order) for each row, if the CRM created it: same deterministic external id. Limited to
  // in-scope orders again, so an order link never leaks even if the visibility lists raced a re-route.
  const shipments = rows.length
    ? await db.fulfillment.findMany({
        where: { OR: pairsWhere(rows), order: inScope },
        select: { connectionId: true, externalId: true, orderId: true, order: { select: { number: true } } },
      })
    : [];
  const shipmentOf = new Map(shipments.map((s) => [`${s.connectionId}:${s.externalId}`, s]));
  const name = new Map(allFhb.map((c) => [c.id, c.name]));
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
