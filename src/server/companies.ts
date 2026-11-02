import { z } from "zod";
import { DomainError, type Actor } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, isUniqueViolation, withAccountTransaction } from "@/server/db/client";

/**
 * Companies (фирми) inside a group. The group is the tenant (database isolation); which companies a member
 * may see is a permission: no MembershipCompany rows = all companies; OWNERs always see all.
 * Products and stock belong to the group, so stock of every company can serve any company's orders.
 */

/** null = every company of the group; otherwise the ids this member is limited to. */
export type CompanyScope = string[] | null;

export async function companyScopeOf(
  accountId: string,
  membershipId: string,
  role: Actor["role"],
): Promise<CompanyScope> {
  if (role === "OWNER") return null;
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
 * Limits a member to some companies (empty list = all). Owners cannot be limited; only someone who manages
 * members may change it, and an ADMIN cannot change another ADMIN's or an OWNER's scope.
 */
export async function setMemberCompanies(actor: Actor, membershipId: string, companyIds: string[]) {
  assertCan(actor.role, "members.manage");
  const ids = [...new Set(companyIds)];
  const before = await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("Membership", membershipId);
    const m = await tx.membership.findUnique({ where: { id: membershipId }, include: { companies: true } });
    if (!m) throw new DomainError("not_found");
    if (m.role === "OWNER") throw new DomainError("owner_sees_all");
    if (actor.role !== "OWNER" && m.role === "ADMIN" && m.userId !== actor.userId) {
      throw new DomainError("forbidden");
    }
    if (ids.length) {
      const found = await tx.company.count({ where: { id: { in: ids } } });
      if (found !== ids.length) throw new DomainError("not_found");
    }
    await tx.membershipCompany.deleteMany({ where: { membershipId } });
    if (ids.length) {
      await tx.membershipCompany.createMany({
        data: ids.map((companyId) => ({ accountId: actor.accountId, membershipId, companyId })),
      });
    }
    return m.companies.map((c) => c.companyId);
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "member.companies",
    entityType: "Membership",
    entityId: membershipId,
    before: { companies: before },
    after: { companies: ids },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}
