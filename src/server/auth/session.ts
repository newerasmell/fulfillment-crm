import "server-only";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/auth";
import type { Role } from "@/generated/prisma/client";
import { clientIp } from "@/lib/client-ip";
import { companyScopeOf, type CompanyScope } from "@/server/companies";
import { accountDb, systemDb } from "@/server/db/client";
import { companiesForLine, listLines, pickActiveLine, visibleLines } from "@/server/lines/lines";
import type { Actor } from "@/server/accounts";
import { can, type Permission } from "./rbac";

export const ACCOUNT_COOKIE = "crm_account";
/** Company filter chosen in the sidebar: a company id, or absent for "all my companies". */
export const COMPANY_COOKIE = "crm_company";
/** Product line chosen in the sidebar (P5-00): a line id, or absent for "all lines" (OWNER/ADMIN only). */
export const LINE_COOKIE = "crm_line";

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  locale: string;
}

/** The logged-in user, re-validated against the database on every request (disabled / revoked sessions). */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  const sv = (session as { sv?: number }).sv ?? 0;
  const user = await systemDb().user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true, locale: true, disabled: true, sessionVersion: true },
  });
  if (!user || user.disabled || user.sessionVersion !== sv) return null;
  return { id: user.id, email: user.email, name: user.name, locale: user.locale };
});

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export interface AccountContext {
  user: CurrentUser;
  accountId: string;
  accountName: string;
  role: Role;
  membershipId: string;
  memberships: { accountId: string; accountName: string; role: Role }[];
  /** Companies of the group this member may see (null = all of them). */
  companyScope: CompanyScope;
  /** Non-archived companies visible to the member, for menus. */
  companies: { id: string; name: string }[];
  /** Company chosen in the sidebar filter, or null for all visible companies. */
  activeCompanyId: string | null;
  /** Product lines the member may pick (P5-00); empty when the group has none. */
  lines: { id: string; name: string; color: string }[];
  /** Line chosen in the sidebar, or null for all lines (only OWNER/ADMIN, or when the group has no lines). */
  activeLineId: string | null;
  /** Companies of the active line the member may see (null = no line filter). Used by companyFilter. */
  lineCompanyIds: string[] | null;
  ip: string | null;
  userAgent: string | null;
}

/** Pure: the sidebar company filter, accepted only if it names a company the member may see. */
export function pickActiveCompany(companies: { id: string }[], cookieValue?: string): string | null {
  return companies.some((c) => c.id === cookieValue) ? cookieValue! : null;
}

/** Pure: which membership is active given the cookie value. Exported for tests. */
export function pickActiveMembership<T extends { accountId: string }>(
  memberships: T[],
  cookieValue?: string,
) {
  return memberships.find((m) => m.accountId === cookieValue) ?? memberships[0] ?? null;
}

export const getAccountContext = cache(async (): Promise<AccountContext | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  // Membership lookup is cross-account by nature (which accounts may this user enter?).
  const rows = await systemDb().membership.findMany({
    where: { userId: user.id },
    select: { id: true, accountId: true, role: true, account: { select: { name: true } } },
    orderBy: { account: { name: "asc" } },
  });
  const memberships = rows.map((r) => ({
    membershipId: r.id,
    accountId: r.accountId,
    accountName: r.account.name,
    role: r.role,
  }));
  const jar = await cookies();
  const active = pickActiveMembership(memberships, jar.get(ACCOUNT_COOKIE)?.value);
  if (!active) return null;
  const companyScope = await companyScopeOf(active.accountId, active.membershipId, active.role);
  const allCompanies = await accountDb(active.accountId).company.findMany({
    where: { archivedAt: null, ...(companyScope ? { id: { in: companyScope } } : {}) },
    select: { id: true, name: true, lineId: true },
    orderBy: { name: "asc" },
  });
  const seesAllLines = active.role === "OWNER" || active.role === "ADMIN";
  const lines = visibleLines(
    await listLines(active.accountId),
    allCompanies.map((c) => c.id),
    seesAllLines,
  );
  const activeLineId = pickActiveLine(lines, jar.get(LINE_COOKIE)?.value, seesAllLines);
  // With a line picked, the company menu and every company-owned list narrow to that line's companies.
  // Restricted members also keep their companies without a line (partial rollout), see companiesForLine.
  const companies = companiesForLine(allCompanies, activeLineId, seesAllLines).map(({ id, name }) => ({
    id,
    name,
  }));
  const h = await headers();
  return {
    user,
    accountId: active.accountId,
    accountName: active.accountName,
    role: active.role,
    membershipId: active.membershipId,
    memberships: memberships.map(({ accountId, accountName, role }) => ({ accountId, accountName, role })),
    companyScope,
    companies,
    activeCompanyId: pickActiveCompany(companies, jar.get(COMPANY_COOKIE)?.value),
    lines: lines.map(({ id, name, color }) => ({ id, name, color })),
    activeLineId,
    lineCompanyIds: activeLineId ? companies.map((c) => c.id) : null,
    ip: clientIp((n) => h.get(n)),
    userAgent: h.get("user-agent"),
  };
});

/** For pages: logged in + member of an account (+ optional permission). */
export async function requireAccountContext(permission?: Permission): Promise<AccountContext> {
  await requireUser();
  const ctx = await getAccountContext();
  if (!ctx) redirect("/no-access");
  // Pages the role may not see behave as if they did not exist; server actions check again themselves.
  if (permission && !can(ctx.role, permission)) notFound();
  return ctx;
}

export function actorFrom(ctx: AccountContext): Actor & { companyScope: CompanyScope } {
  return {
    userId: ctx.user.id,
    accountId: ctx.accountId,
    role: ctx.role,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    companyScope: ctx.companyScope,
  };
}
