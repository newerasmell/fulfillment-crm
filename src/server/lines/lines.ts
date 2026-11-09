import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { DomainError, type Actor } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import type { CompanyScope } from "@/server/companies";
import {
  accountDb,
  isUniqueViolation,
  withAccountTransaction,
  type AccountTxHelpers,
} from "@/server/db/client";
import { LINE_COLOR_KEYS } from "./colors";

/**
 * Product lines (P5-00, owner decision 2026-11-02). A group has product lines (e.g. cosmetics, textiles); every
 * company belongs to exactly one line, and the companies of a line sell identical goods. Master products belong
 * to one line; matching, suggestions and the routing stock fallback never cross lines. Lines are archived,
 * never deleted. Managing lines and assigning companies is OWNER/ADMIN (`lines.manage`) and audited.
 */

export type ScopedActor = Actor & { companyScope: CompanyScope };

export const LineInput = z.object({
  name: z.string().trim().min(2).max(80),
  color: z.enum(LINE_COLOR_KEYS as [string, ...string[]]),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
});

export interface LineSummary {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  archivedAt: Date | null;
  companyIds: string[];
}

/** Every line of the group (archived too when asked), with its companies. */
export async function listLines(accountId: string, opts: { includeArchived?: boolean } = {}) {
  const rows = await accountDb(accountId).productLine.findMany({
    where: opts.includeArchived ? {} : { archivedAt: null },
    select: {
      id: true,
      name: true,
      color: true,
      sortOrder: true,
      archivedAt: true,
      companies: { select: { id: true } },
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return rows.map(({ companies, ...l }) => ({ ...l, companyIds: companies.map((c) => c.id) }));
}

/**
 * Lines a member may pick in the sidebar: OWNER/ADMIN (never company-restricted) see every active line;
 * anyone else sees the lines of the companies they may see.
 */
export function visibleLines(lines: LineSummary[], visibleCompanyIds: string[], seesAll: boolean) {
  if (seesAll) return lines.filter((l) => !l.archivedAt);
  const visible = new Set(visibleCompanyIds);
  return lines.filter((l) => !l.archivedAt && l.companyIds.some((c) => visible.has(c)));
}

/** Pure: the sidebar line filter. Only OWNER/ADMIN may stay on "all lines"; others default to their first line. */
export function pickActiveLine(
  lines: { id: string }[],
  cookieValue: string | undefined,
  mayPickAll: boolean,
): string | null {
  if (lines.some((l) => l.id === cookieValue)) return cookieValue!;
  if (mayPickAll || lines.length === 0) return null;
  return lines[0]!.id;
}

/**
 * Pure: companies shown while a line is active. Members who cannot pick "all lines" (restricted roles) also keep
 * their companies that are not in any line yet — otherwise a partial rollout (one company put into a line) would
 * hide every order, alert and stock row of their other companies with no way back.
 */
export function companiesForLine<T extends { lineId: string | null }>(
  companies: T[],
  activeLineId: string | null,
  mayPickAll: boolean,
): T[] {
  if (!activeLineId) return companies;
  return companies.filter((c) => c.lineId === activeLineId || (!mayPickAll && c.lineId === null));
}

async function audit(actor: Actor, action: string, entityId: string, before?: unknown, after?: unknown) {
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action,
    entityType: action.startsWith("company.") ? "Company" : "ProductLine",
    entityId,
    before,
    after,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}

export async function createLine(actor: Actor, raw: z.input<typeof LineInput>) {
  assertCan(actor.role, "lines.manage");
  const input = LineInput.parse(raw);
  let line;
  try {
    line = await accountDb(actor.accountId).productLine.create({
      data: { accountId: actor.accountId, ...input },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError("line_exists");
    throw err;
  }
  await audit(actor, "line.create", line.id, undefined, input);
  return line;
}

export async function updateLine(actor: Actor, lineId: string, raw: z.input<typeof LineInput>) {
  assertCan(actor.role, "lines.manage");
  const input = LineInput.parse(raw);
  const db = accountDb(actor.accountId);
  const before = await db.productLine.findUnique({ where: { id: lineId } });
  if (!before) throw new DomainError("not_found");
  try {
    await db.productLine.update({ where: { id: lineId }, data: input });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError("line_exists");
    throw err;
  }
  await audit(
    actor,
    "line.update",
    lineId,
    { name: before.name, color: before.color, sortOrder: before.sortOrder },
    input,
  );
}

/** Archiving hides a line from menus; its companies and products keep the link (history stays readable). */
export async function setLineArchived(actor: Actor, lineId: string, archived: boolean) {
  assertCan(actor.role, "lines.manage");
  const res = await accountDb(actor.accountId).productLine.updateMany({
    where: { id: lineId },
    data: { archivedAt: archived ? new Date() : null },
  });
  if (res.count !== 1) throw new DomainError("not_found");
  await audit(actor, archived ? "line.archive" : "line.unarchive", lineId);
}

/** Puts a company into a line (or takes it out with null). A company is in at most one line by construction. */
export async function setCompanyLine(actor: Actor, companyId: string, lineId: string | null) {
  assertCan(actor.role, "lines.manage");
  const before = await withAccountTransaction(actor.accountId, async (tx) => {
    const company = await tx.company.findUnique({ where: { id: companyId } });
    if (!company) throw new DomainError("not_found");
    if (lineId) {
      const line = await tx.productLine.findUnique({ where: { id: lineId } });
      if (!line || line.archivedAt) throw new DomainError("not_found");
    }
    await tx.company.update({ where: { id: companyId }, data: { lineId } });
    return company.lineId;
  });
  if (before !== lineId) await audit(actor, "company.line", companyId, { lineId: before }, { lineId });
}

// ───────────── helpers shared by catalogue, suggestions, mapping and coverage ─────────────

export interface LineMembers {
  lineId: string;
  companyIds: string[];
  connections: { id: string; name: string; type: string; companyId: string | null; skuPrefixRule: unknown }[];
  stores: { id: string; name: string; code: string; companyId: string | null; skuPrefix: string | null }[];
}

/**
 * Companies, product-holding warehouse connections and stores of one line. With a company scope (restricted
 * member) only the line's companies inside that scope count: another company of the same line stays invisible
 * (its warehouse ids, variant SKUs, names) and untouchable (import, suggestions) for that member.
 */
export async function lineMembers(
  accountId: string,
  lineId: string,
  scope: CompanyScope = null,
): Promise<LineMembers> {
  const tx = accountDb(accountId);
  const companies = await tx.company.findMany({
    where: { lineId, ...(scope ? { id: { in: scope } } : {}) },
    select: { id: true },
  });
  const companyIds = companies.map((c) => c.id);
  const [connections, stores] = await Promise.all([
    tx.fulfillmentConnection.findMany({
      where: { companyId: { in: companyIds }, type: { in: ["FHB_V3", "EUSHIPMENTS"] } },
      select: { id: true, name: true, type: true, companyId: true, skuPrefixRule: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
    tx.store.findMany({
      where: { companyId: { in: companyIds } },
      select: { id: true, name: true, code: true, companyId: true, skuPrefix: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
  ]);
  return { lineId, companyIds, connections, stores };
}

/** A line the actor may work with: it exists and (for restricted members) holds one of their companies. */
export async function assertLineInScope(actor: ScopedActor, lineId: string) {
  const line = await accountDb(actor.accountId).productLine.findUnique({
    where: { id: lineId },
    include: { companies: { select: { id: true } } },
  });
  if (!line) throw new DomainError("not_found");
  if (actor.companyScope && !line.companies.some((c) => actor.companyScope!.includes(c.id))) {
    throw new DomainError("not_found");
  }
  return line;
}

/** The connection's SKU prefix ({"prefix":"R"}), or "". */
export function connectionPrefix(rule: unknown): string {
  return rule && typeof rule === "object" && typeof (rule as { prefix?: unknown }).prefix === "string"
    ? (rule as { prefix: string }).prefix.trim()
    : "";
}

/** Vendor id / variant SKU → master SKU: the prefix stripped (case-insensitive), trimmed; null when empty. */
export function skuAfterPrefix(
  id: string | null | undefined,
  prefix: string | null | undefined,
): string | null {
  const s = id?.trim();
  if (!s) return null;
  const p = prefix?.trim();
  return p && s.toLowerCase().startsWith(p.toLowerCase()) && s.length > p.length
    ? s.slice(p.length).trim()
    : s;
}

/** Serialises master-product writes of one line (catalogue run, import apply) inside a transaction. */
export async function lockLine(helpers: AccountTxHelpers, lineId: string) {
  await helpers.lockKey(`product-line:${lineId}`);
}

/**
 * Product filter for automatic matching from a company's sync: masters of the company's line, plus masters
 * not assigned to any line yet (back-compatible until every master has a line). Companies without a line keep
 * the old group-wide matching. Never another line's masters.
 */
export function lineProductWhere(lineId: string | null | undefined): Prisma.ProductWhereInput {
  return lineId ? { OR: [{ lineId }, { lineId: null }] } : {};
}

/**
 * Warehouse connections of one product line (their company's line). The order page shows only these columns for
 * an order of that line (owner request 2026-11-09: textile stores showed the cosmetics warehouses too). No line →
 * no filter. `alsoIds`: connections the order already uses (its shipments / routing) stay visible.
 */
export function lineConnectionsWhere(
  lineId: string | null | undefined,
  alsoIds: string[] = [],
): Prisma.FulfillmentConnectionWhereInput {
  if (!lineId) return {};
  return { OR: [{ company: { lineId } }, ...(alsoIds.length ? [{ id: { in: alsoIds } }] : [])] };
}
