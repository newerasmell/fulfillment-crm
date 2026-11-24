import { DomainError } from "@/server/accounts";
import { assertCan } from "@/server/auth/rbac";
import { transitionOrder } from "@/server/pipeline";
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

/** „Обнови от Shopify“ on one order: see refreshOrderFromShopifyAction. */
export async function refreshOrderFromShopify(
  actor: { accountId: string; userId: string; role: Role; companyScope: CompanyScope },
  orderId: string,
  enqueue: (d: { accountId: string; storeId: string; orderId: string }) => Promise<unknown>,
) {
  assertCan(actor.role, "stores.sync");
  const order = await accountDb(actor.accountId).order.findFirst({
    where: {
      id: orderId,
      ...(actor.companyScope ? { companyId: { in: actor.companyScope } } : {}),
    },
    select: { id: true, status: true, storeId: true, shopifyOrderGid: true },
  });
  if (!order) throw new DomainError("not_found");
  if (!order.storeId || !order.shopifyOrderGid) throw new DomainError("not_shopify");
  // Never reopen an order the worker could not read: the store must be connected (and not archived).
  const store = await accountDb(actor.accountId).store.findFirst({
    where: { id: order.storeId, archivedAt: null },
    select: { connectionStatus: true },
  });
  if ((store?.connectionStatus as { ok?: boolean } | null)?.ok !== true)
    throw new DomainError("store_not_connected");
  // Approved but not sent: back to review, so the refreshed amounts / lines / COD replace the approved ones.
  let reopened = false;
  if (order.status === "APPROVED") {
    assertCan(actor.role, "orders.review");
    const t = await transitionOrder(actor.accountId, {
      orderId: order.id,
      to: "NEEDS_REVIEW",
      cause: "reopen",
      actor: { kind: "user", userId: actor.userId },
      source: "shopify.refreshOrder",
      reason: "refresh from Shopify",
    });
    reopened = t.changed;
  }
  await enqueue({ accountId: actor.accountId, storeId: order.storeId, orderId: order.id });
  return { reopened };
}
