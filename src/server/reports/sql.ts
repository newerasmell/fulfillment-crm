import { Prisma } from "@/generated/prisma/client";
import { assertCan, type Permission } from "@/server/auth/rbac";
import { companyFilter, type CompanyScope } from "@/server/companies";
import { basePrisma, TenantScopeError } from "@/server/db/client";

/**
 * Справки (P10-04): the sanctioned raw-SQL path for report aggregates Prisma cannot express (GROUP BY a Sofia
 * calendar day, percentiles, JSON array elements). Same safety as src/server/db/vector.ts: every call runs in its
 * own read-only transaction with the RLS setting of withAccountTransaction (app.account_id, bypass off) AND an
 * explicit "accountId" filter in the SQL, a statement timeout, and only bound parameters (never SQL text from
 * input). Results are small (grouped rows), never one row per order.
 */

export interface ReportCtx {
  accountId: string;
  role: string;
  companyScope: CompanyScope;
  activeCompanyId: string | null;
  activeLineId: string | null;
  lineCompanyIds: string[] | null;
  /** Connection types of the header warehouse scope; undefined = every warehouse. */
  connectionTypes?: readonly string[];
}

export function assertReport(ctx: ReportCtx, extra?: Permission) {
  assertCan(ctx.role as never, "reports.read");
  if (extra) assertCan(ctx.role as never, extra);
}

/** Prisma `where` fragment for company-owned rows (sidebar company / product line / the member's companies). */
export const scopeWhere = (ctx: ReportCtx) =>
  companyFilter({
    companyScope: ctx.companyScope,
    activeCompanyId: ctx.activeCompanyId,
    lineCompanyIds: ctx.lineCompanyIds,
  });

/** Pure: the same scope as a list of company ids (null = no company filter). */
export function scopeCompanyIds(ctx: ReportCtx): string[] | null {
  const f = scopeWhere(ctx) as { companyId?: string | { in: string[] } };
  if (f.companyId === undefined) return null;
  return typeof f.companyId === "string" ? [f.companyId] : f.companyId.in;
}

/** SQL fragment `AND <col> IN (…)` for the company scope; `false` when the scope is empty (nothing visible). */
export function companySql(ctx: ReportCtx, column: Prisma.Sql): Prisma.Sql | false {
  const ids = scopeCompanyIds(ctx);
  if (ids === null) return Prisma.empty;
  if (ids.length === 0) return false;
  return Prisma.sql`AND ${column} IN (${Prisma.join(ids)})`;
}

/** SQL fragment `AND <col>::text IN (…)` for the warehouse scope. */
export function connectionTypeSql(ctx: ReportCtx, column: Prisma.Sql): Prisma.Sql {
  if (!ctx.connectionTypes) return Prisma.empty;
  if (ctx.connectionTypes.length === 0) return Prisma.sql`AND FALSE`;
  return Prisma.sql`AND ${column}::text IN (${Prisma.join([...ctx.connectionTypes])})`;
}

/** Runs one aggregate query for one account (RLS on, read only, 20 s timeout). */
export async function reportQuery<T>(accountId: string, query: Prisma.Sql): Promise<T[]> {
  if (!accountId) throw new TenantScopeError("accountId is required");
  return basePrisma().$transaction(async (tx) => {
    // SET TRANSACTION must come before any other statement of the transaction.
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    await tx.$executeRaw`SELECT set_config('app.account_id', ${accountId}, TRUE), set_config('app.bypass_rls', 'off', TRUE), set_config('statement_timeout', '20000', TRUE)`;
    return tx.$queryRaw<T[]>(query);
  });
}

/** Pure: a SQL numeric sum (as text) to cents, so sums of one currency never drift. */
export const toCents = (v: string | number | null | undefined) =>
  v == null || v === "" ? 0 : Math.round(Number(v) * 100);
