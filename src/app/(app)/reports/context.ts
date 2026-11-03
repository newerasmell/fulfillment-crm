import "server-only";
import { cookies } from "next/headers";
import { isScope, SCOPE_COOKIE, SCOPE_TYPES, type Scope } from "@/components/shell/scope";
import type { AccountContext } from "@/server/auth/session";
import type { ReportCtx } from "@/server/reports";

/** Report scope from the account context (company / product line) and the header warehouse scope cookie. */
export async function reportCtxOf(ctx: AccountContext): Promise<{ rc: ReportCtx; scope: Scope }> {
  const raw = (await cookies()).get(SCOPE_COOKIE)?.value;
  const scope = isScope(raw) ? raw : "all";
  return {
    scope,
    rc: {
      accountId: ctx.accountId,
      role: ctx.role,
      companyScope: ctx.companyScope,
      activeCompanyId: ctx.activeCompanyId,
      activeLineId: ctx.activeLineId,
      lineCompanyIds: ctx.lineCompanyIds,
      connectionTypes: scope === "all" ? undefined : SCOPE_TYPES[scope],
    },
  };
}
