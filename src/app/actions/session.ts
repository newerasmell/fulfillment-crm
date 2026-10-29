"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthError, CredentialsSignin } from "next-auth";
import { signIn, signOut } from "@/auth";
import { isLocale, LOCALE_COOKIE } from "@/i18n/locales";
import { recordAudit } from "@/server/audit";
import { ACCOUNT_COOKIE, getAccountContext, requireUser } from "@/server/auth/session";
import { systemDb } from "@/server/db/client";
import { isScope, SCOPE_COOKIE } from "@/components/shell/scope";
import { safeNext } from "@/lib/safe-next";

const COOKIE = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

export async function loginAction(_prev: { error?: string } | undefined, form: FormData) {
  try {
    await signIn("credentials", {
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
      code: String(form.get("code") ?? ""),
      redirectTo: safeNext(form.get("next")),
    });
  } catch (err) {
    if (err instanceof CredentialsSignin) return { error: err.code };
    if (err instanceof AuthError) return { error: "invalid" };
    throw err; // NEXT_REDIRECT on success
  }
  return {};
}

export async function logoutAction() {
  await signOut({ redirectTo: "/login" });
}

export async function switchAccountAction(accountId: string) {
  const user = await requireUser();
  const membership = await systemDb().membership.findUnique({
    where: { userId_accountId: { userId: user.id, accountId } },
  });
  if (!membership) return; // not a member: ignore silently, the cookie stays as it was
  (await cookies()).set(ACCOUNT_COOKIE, accountId, { ...COOKIE, maxAge: 60 * 60 * 24 * 365 });
  await recordAudit({ accountId, userId: user.id, action: "account.switch" });
  redirect("/");
}

export async function setLocaleAction(locale: string) {
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, { ...COOKIE, httpOnly: false, maxAge: 60 * 60 * 24 * 365 });
  const ctx = await getAccountContext();
  if (ctx) await systemDb().user.update({ where: { id: ctx.user.id }, data: { locale } });
}

export async function setScopeAction(scope: string) {
  if (!isScope(scope)) return;
  await requireUser();
  (await cookies()).set(SCOPE_COOKIE, scope, { ...COOKIE, maxAge: 60 * 60 * 24 * 365 });
}
