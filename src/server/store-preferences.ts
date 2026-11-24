import { z } from "zod";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { companyFilter, type CompanyScope } from "@/server/companies";
import { accountDb } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";

/**
 * „Моите магазини“ (owner request 2026-11-24): each member picks the stores they work with; the orders list starts
 * filtered to them (the filter can always widen to all). Stores grouped by product line (e.g. clothes / perfumes),
 * alphabetical, for the pickers.
 */

export const STORE_PICK_MAX = 100;

/** The member's stores (only those still visible to them); empty = all. */
export async function myStoreIds(actor: { accountId: string; userId: string; companyScope: CompanyScope }) {
  const pref = await accountDb(actor.accountId).memberStorePreference.findUnique({
    where: { accountId_userId: { accountId: actor.accountId, userId: actor.userId } },
    select: { storeIds: true },
  });
  if (!pref?.storeIds.length) return [];
  const visible = await accountDb(actor.accountId).store.findMany({
    where: {
      id: { in: pref.storeIds },
      ...(actor.companyScope ? { companyId: { in: actor.companyScope } } : {}),
    },
    select: { id: true },
  });
  return visible.map((s) => s.id);
}

export async function saveMyStores(actor: ScopedActor, rawIds: string[]) {
  assertCan(actor.role, "account.read");
  const ids = z
    .array(z.string().min(1).max(64))
    .max(STORE_PICK_MAX)
    .parse([...new Set(rawIds)]);
  // Only stores the member may see.
  const ok = ids.length
    ? (
        await accountDb(actor.accountId).store.findMany({
          where: {
            id: { in: ids },
            ...(actor.companyScope ? { companyId: { in: actor.companyScope } } : {}),
          },
          select: { id: true },
        })
      ).map((s) => s.id)
    : [];
  await accountDb(actor.accountId).memberStorePreference.upsert({
    where: { accountId_userId: { accountId: actor.accountId, userId: actor.userId } },
    create: { accountId: actor.accountId, userId: actor.userId, storeIds: ok },
    update: { storeIds: ok },
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "member.stores",
    entityType: "User",
    entityId: actor.userId,
    after: { storeIds: ok },
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
  });
  return ok;
}

/** Stores grouped by product line, lines and stores alphabetical; stores of a company without a line come last. */
export async function storesByLine(
  ctx: { accountId: string; companyScope: CompanyScope; activeCompanyId: string | null },
  opts: { includeArchived?: boolean } = {},
) {
  const stores = await accountDb(ctx.accountId).store.findMany({
    where: { ...companyFilter(ctx), ...(opts.includeArchived ? {} : { archivedAt: null }) },
    select: {
      id: true,
      name: true,
      archivedAt: true,
      company: { select: { line: { select: { id: true, name: true } } } },
    },
  });
  const groups = new Map<string, { lineId: string | null; line: string | null; stores: typeof stores }>();
  for (const s of stores) {
    const line = s.company?.line ?? null;
    const key = line?.id ?? "";
    const g = groups.get(key) ?? { lineId: line?.id ?? null, line: line?.name ?? null, stores: [] };
    g.stores.push(s);
    groups.set(key, g);
  }
  const collator = new Intl.Collator("bg", { sensitivity: "base", numeric: true });
  const out = [...groups.values()].sort((a, b) =>
    a.line === null ? 1 : b.line === null ? -1 : collator.compare(a.line, b.line),
  );
  for (const g of out) g.stores.sort((a, b) => collator.compare(a.name, b.name));
  return out.map((g) => ({
    lineId: g.lineId,
    line: g.line,
    stores: g.stores.map((s) => ({ id: s.id, name: s.name, archived: !!s.archivedAt })),
  }));
}

export type StoreGroups = Awaited<ReturnType<typeof storesByLine>>;
