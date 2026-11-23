import { assertCan } from "@/server/auth/rbac";
import { companyFilter, type CompanyScope } from "@/server/companies";
import { accountDb } from "@/server/db/client";
import type { Role } from "@/generated/prisma/client";

/**
 * „Изтегли поръчките сега“ (owner request 2026-11-23): the same read-only order pull the schedule runs
 * (reconcile), now, for every connected store the member sees — colleagues starting work need the night's
 * orders at once. One waiting pull per store (the queue keeps one), so repeated clicks queue nothing more.
 */
export async function pullOrdersNow(
  ctx: {
    accountId: string;
    role: Role;
    companyScope: CompanyScope;
    activeCompanyId: string | null;
    lineCompanyIds?: string[] | null;
  },
  enqueue: (storeId: string) => Promise<string | null>,
) {
  assertCan(ctx.role, "stores.sync");
  const stores = await accountDb(ctx.accountId).store.findMany({
    where: { ...companyFilter(ctx), archivedAt: null, credentialId: { not: null } },
    select: { id: true, connectionStatus: true },
    orderBy: { name: "asc" },
  });
  let queued = 0;
  let already = 0;
  let skipped = 0;
  for (const s of stores) {
    // A store whose connection test failed is left alone (the jobs would skip it anyway).
    if ((s.connectionStatus as { ok?: boolean } | null)?.ok !== true) {
      skipped++;
      continue;
    }
    if ((await enqueue(s.id)) === null) already++;
    else queued++;
  }
  return { queued, already, skipped };
}

/** When the stores the member sees were last pulled (the oldest of them decides), for the button's hint. */
export async function lastOrdersPull(ctx: {
  accountId: string;
  companyScope: CompanyScope;
  activeCompanyId: string | null;
  lineCompanyIds?: string[] | null;
}) {
  const stores = await accountDb(ctx.accountId).store.findMany({
    where: { ...companyFilter(ctx), archivedAt: null, credentialId: { not: null } },
    select: { syncCursors: true, connectionStatus: true },
  });
  // The same stores the pull covers (a store whose connection test failed is never pulled).
  const times = stores
    .filter((s) => (s.connectionStatus as { ok?: boolean } | null)?.ok === true)
    .map((s) => (s.syncCursors as { ordersSyncedAt?: string } | null)?.ordersSyncedAt)
    .filter((v): v is string => !!v)
    .map((v) => new Date(v))
    .filter((d) => !Number.isNaN(d.getTime()));
  if (!times.length) return null;
  return new Date(Math.min(...times.map((d) => d.getTime())));
}
