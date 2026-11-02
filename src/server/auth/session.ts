import "server-only";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/auth";
import type { Role } from "@/generated/prisma/client";
import { clientIp } from "@/lib/client-ip";
import { systemDb } from "@/server/db/client";
import type { Actor } from "@/server/accounts";
import { can, type Permission } from "./rbac";

export const ACCOUNT_COOKIE = "crm_account";

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
  memberships: { accountId: string; accountName: string; role: Role }[];
  ip: string | null;
  userAgent: string | null;
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
    select: { accountId: true, role: true, account: { select: { name: true } } },
    orderBy: { account: { name: "asc" } },
  });
  const memberships = rows.map((r) => ({
    accountId: r.accountId,
    accountName: r.account.name,
    role: r.role,
  }));
  const active = pickActiveMembership(memberships, (await cookies()).get(ACCOUNT_COOKIE)?.value);
  if (!active) return null;
  const h = await headers();
  return {
    user,
    accountId: active.accountId,
    accountName: active.accountName,
    role: active.role,
    memberships,
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

export function actorFrom(ctx: AccountContext): Actor {
  return {
    userId: ctx.user.id,
    accountId: ctx.accountId,
    role: ctx.role,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  };
}
