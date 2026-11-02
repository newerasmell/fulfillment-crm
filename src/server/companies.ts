import { z } from "zod";
import { DomainError, type Actor } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, isUniqueViolation, withAccountTransaction } from "@/server/db/client";

/**
 * Companies (фирми) inside a group. The group is the tenant (database isolation); which companies a member
 * may see is a permission. Only OPERATOR / WAREHOUSE / VIEWER can be limited: OWNERs and ADMINs manage people,
 * credentials and connections of the whole group, so they always see every company (a restricted admin could
 * otherwise widen their own or others' access). No MembershipCompany rows = all companies.
 * Products and stock belong to the group, so stock of every company can serve any company's orders.
 */

/** null = every company of the group; otherwise the ids this member is limited to. */
export type CompanyScope = string[] | null;

export const RESTRICTABLE_ROLES = ["OPERATOR", "WAREHOUSE", "VIEWER"] as const;
export const isRestrictableRole = (role: Actor["role"]) =>
  (RESTRICTABLE_ROLES as readonly string[]).includes(role);

export async function companyScopeOf(
  accountId: string,
  membershipId: string,
  role: Actor["role"],
): Promise<CompanyScope> {
  if (!isRestrictableRole(role)) return null;
  const rows = await accountDb(accountId).membershipCompany.findMany({
    where: { membershipId },
    select: { companyId: true },
  });
  return rows.length ? rows.map((r) => r.companyId) : null;
}

/** Prisma `where` fragment limiting rows with a companyId to the member's companies. */
export function companyWhere(scope: CompanyScope): { companyId?: { in: string[] } } {
  return scope ? { companyId: { in: scope } } : {};
}

/**
 * `where` fragment for screens: the company picked in the sidebar if any, otherwise every company the member
 * may see. Use it on every query of company-owned rows (stores, connections, orders).
 */
export function companyFilter(ctx: { companyScope: CompanyScope; activeCompanyId: string | null }) {
  return ctx.activeCompanyId ? { companyId: ctx.activeCompanyId } : companyWhere(ctx.companyScope);
}

export async function listCompanies(
  actor: Actor & { companyScope?: CompanyScope },
  opts: { includeArchived?: boolean } = {},
) {
  const scope = actor.companyScope ?? null;
  return accountDb(actor.accountId).company.findMany({
    where: {
      ...(opts.includeArchived ? {} : { archivedAt: null }),
      ...(scope ? { id: { in: scope } } : {}),
    },
    select: { id: true, name: true, archivedAt: true, createdAt: true },
    orderBy: { name: "asc" },
  });
}

export const CompanyInput = z.object({ name: z.string().trim().min(2).max(200) });

export async function createCompany(actor: Actor, raw: z.input<typeof CompanyInput>) {
  assertCan(actor.role, "companies.manage");
  const { name } = CompanyInput.parse(raw);
  let company;
  try {
    company = await accountDb(actor.accountId).company.create({ data: { accountId: actor.accountId, name } });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError("company_exists");
    throw err;
  }
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "company.create",
    entityType: "Company",
    entityId: company.id,
    after: { name },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return company;
}

/** Archiving hides a company from menus and new work; its history stays. Never a hard delete. */
export async function setCompanyArchived(actor: Actor, companyId: string, archived: boolean) {
  assertCan(actor.role, "companies.archive");
  const res = await accountDb(actor.accountId).company.updateMany({
    where: { id: companyId },
    data: { archivedAt: archived ? new Date() : null },
  });
  if (res.count !== 1) throw new DomainError("not_found");
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: archived ? "company.archive" : "company.unarchive",
    entityType: "Company",
    entityId: companyId,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}

/**
 * Sets a member's company access. `all: true` = every company; otherwise `companyIds` must name at least one
 * company (an empty restriction is refused instead of silently meaning "all"). Only OPERATOR / WAREHOUSE /
 * VIEWER members can be restricted, and only by OWNERs/ADMINs (who are never restricted themselves).
 */
export async function setMemberCompanies(
  actor: Actor,
  membershipId: string,
  access: { all: true } | { all: false; companyIds: string[] },
) {
  assertCan(actor.role, "members.manage");
  const ids = access.all ? [] : [...new Set(access.companyIds)];
  if (!access.all && ids.length === 0) throw new DomainError("pick_company");
  const before = await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("Membership", membershipId);
    const m = await tx.membership.findUnique({ where: { id: membershipId }, include: { companies: true } });
    if (!m) throw new DomainError("not_found");
    if (!isRestrictableRole(m.role)) throw new DomainError("role_sees_all");
    const current = m.companies.map((c) => c.companyId);
    if (ids.length) {
      // Active companies, or ones the member already had (an archived company stays selectable, so saving
      // the form never silently drops it — and never turns the restriction into "all").
      const found = await tx.company.count({
        where: { id: { in: ids }, OR: [{ archivedAt: null }, { id: { in: current } }] },
      });
      if (found !== ids.length) throw new DomainError("not_found");
    }
    await tx.membershipCompany.deleteMany({ where: { membershipId } });
    if (ids.length) {
      await tx.membershipCompany.createMany({
        data: ids.map((companyId) => ({ accountId: actor.accountId, membershipId, companyId })),
      });
    }
    return current;
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "member.companies",
    entityType: "Membership",
    entityId: membershipId,
    before: { companies: before.length ? before : "all" },
    after: { companies: ids.length ? ids : "all" },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}
