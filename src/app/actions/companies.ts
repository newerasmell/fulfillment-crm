"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, COMPANY_COOKIE, requireAccountContext } from "@/server/auth/session";
import { createCompany, setCompanyArchived, setMemberCompanies } from "@/server/companies";

type Result = { ok?: boolean; error?: string } | undefined;

function toError(err: unknown): Result {
  if (err instanceof ForbiddenError) return { error: "forbidden" };
  if (err instanceof DomainError) return { error: err.code };
  if (err instanceof z.ZodError) return { error: "invalid" };
  throw err;
}

export async function createCompanyAction(_prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await createCompany(actorFrom(ctx), { name: String(form.get("name") ?? "") });
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function setCompanyArchivedAction(companyId: string, archived: boolean) {
  const ctx = await requireAccountContext();
  try {
    await setCompanyArchived(actorFrom(ctx), companyId, archived);
  } catch (err) {
    toError(err);
  }
  revalidatePath("/", "layout");
}

export async function setMemberCompaniesAction(_prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await setMemberCompanies(
      actorFrom(ctx),
      String(form.get("membershipId") ?? ""),
      form.getAll("companyIds").map(String),
    );
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/settings/members");
  return { ok: true };
}

/** Sidebar filter: "all" or one of the companies this member may see. */
export async function setCompanyFilterAction(companyId: string) {
  const ctx = await requireAccountContext();
  const jar = await cookies();
  if (companyId === "all" || !ctx.companies.some((c) => c.id === companyId)) jar.delete(COMPANY_COOKIE);
  else {
    jar.set(COMPANY_COOKIE, companyId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  revalidatePath("/", "layout");
}
