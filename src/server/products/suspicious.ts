import type { Prisma } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { companyFilter, type CompanyScope } from "@/server/companies";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import {
  linkNameKey,
  nameAgreement,
  wordWeights,
  type DisagreementReason,
  type WordWeight,
} from "./name-agreement";

/**
 * "Съмнителни връзки" (owner report 2026-11-03). SKU after prefix stays the only matching key; this module
 * checks every EXISTING link (warehouse product → master, store variant → master) for names that disagree
 * (./name-agreement.ts) and:
 *   - keeps a SuspiciousLink row per flagged (or confirmed) link for the screens — `refreshSuspiciousLinks`,
 *     called (batched) after product/variant syncs, manual links, catalogue runs and imports;
 *   - answers "is this link suspicious NOW" live from the current names for the safety brakes
 *     (`suspiciousItemIds`): the Shopify stock push skips such a variant, an order line gets a soft finding.
 *     The brakes never depend on a refresh having run.
 * A person confirms ("same product") — stored with the names it covered, so a later name change flags again —
 * or unlinks (audited). Nothing here links or blocks by itself.
 */

export type LinkKind = "vendor" | "variant";

const PAGE = 500;

interface Evaluated {
  kind: LinkKind;
  itemId: string;
  productId: string;
  lineId: string | null;
  sourceId: string;
  itemName: string;
  itemCode: string | null;
  productSku: string;
  productName: string;
  score: number | null;
  reasons: DisagreementReason[];
  /** The names disagree (before any confirmation). */
  disagree: boolean;
  nameKey: string;
}

export interface LinkScope {
  variants?: Prisma.StoreVariantLinkWhereInput;
  vendors?: Prisma.VendorProductWhereInput;
}

const weightsCache = new Map<string, { stamp: string; weight: WordWeight }>();

/**
 * Word weights from every master name of the account (brand-like words count less). Cached per account until
 * the catalogue changes (count + last update): order checks run in bulk.
 */
async function accountWeights(accountId: string): Promise<WordWeight> {
  const db = accountDb(accountId);
  const agg = await db.product.aggregate({
    where: { archived: false },
    _count: { _all: true },
    _max: { updatedAt: true },
  });
  const stamp = `${agg._count._all}:${agg._max.updatedAt?.getTime() ?? 0}`;
  const hit = weightsCache.get(accountId);
  if (hit && hit.stamp === stamp) return hit.weight;
  const masters = await db.product.findMany({
    where: { archived: false },
    select: { name: true, brand: true },
  });
  const weight = wordWeights(masters);
  weightsCache.delete(accountId);
  weightsCache.set(accountId, { stamp, weight });
  if (weightsCache.size > 100) weightsCache.delete(weightsCache.keys().next().value!);
  return weight;
}

const vendorName = (raw: unknown) => {
  const n = raw && typeof raw === "object" ? (raw as { name?: unknown }).name : null;
  return typeof n === "string" && n.trim() ? n.trim() : null;
};

const productSelect = { select: { sku: true, name: true, brand: true, lineId: true } } as const;

function evaluate(
  kind: LinkKind,
  item: { id: string; sourceId: string; name: string; code: string | null; productId: string },
  product: { sku: string; name: string; brand: string | null; lineId: string | null },
  skus: (string | null)[],
  weight: WordWeight,
): Evaluated {
  const a = nameAgreement(item.name, product.name, { brand: product.brand, skus, weight });
  return {
    kind,
    itemId: item.id,
    productId: item.productId,
    lineId: product.lineId,
    sourceId: item.sourceId,
    itemName: item.name,
    itemCode: item.code,
    productSku: product.sku,
    productName: product.name,
    score: a.score,
    reasons: a.reasons,
    disagree: a.flagged,
    nameKey: linkNameKey(item.productId, item.name, product.name),
  };
}

const stripPrefix = (sku: string | null, prefix: string | null) => {
  const s = sku?.trim();
  const p = prefix?.trim();
  return s && p && s.toLowerCase().startsWith(p.toLowerCase()) && s.length > p.length ? s.slice(p.length) : s;
};

/** One page (by id) of linked store variants, evaluated. */
async function variantPage(
  accountId: string,
  where: Prisma.StoreVariantLinkWhereInput,
  weight: WordWeight,
  after?: string,
) {
  const rows = await accountDb(accountId).storeVariantLink.findMany({
    where: { AND: [where, { productId: { not: null } }], ...(after ? { id: { gt: after } } : {}) },
    select: {
      id: true,
      storeId: true,
      sku: true,
      title: true,
      productId: true,
      store: { select: { skuPrefix: true } },
      product: productSelect,
    },
    orderBy: { id: "asc" },
    take: PAGE,
  });
  return {
    last: rows.at(-1)?.id,
    items: rows
      .filter((r) => r.product && r.productId)
      .map((r) =>
        evaluate(
          "variant",
          { id: r.id, sourceId: r.storeId, name: r.title, code: r.sku, productId: r.productId! },
          r.product!,
          [r.sku, stripPrefix(r.sku, r.store.skuPrefix) ?? null, r.product!.sku],
          weight,
        ),
      ),
  };
}

/** One page (by id) of linked, non-archived warehouse products that carry a name, evaluated. */
async function vendorPage(
  accountId: string,
  where: Prisma.VendorProductWhereInput,
  weight: WordWeight,
  after?: string,
) {
  const rows = await accountDb(accountId).vendorProduct.findMany({
    where: {
      AND: [where, { productId: { not: null }, archived: false }],
      ...(after ? { id: { gt: after } } : {}),
    },
    select: {
      id: true,
      connectionId: true,
      vendorId: true,
      raw: true,
      productId: true,
      product: productSelect,
    },
    orderBy: { id: "asc" },
    take: PAGE,
  });
  const items: Evaluated[] = [];
  for (const r of rows) {
    const name = vendorName(r.raw);
    // No warehouse name (some feeds carry none): nothing to compare.
    if (!name || !r.product || !r.productId) continue;
    items.push(
      evaluate(
        "vendor",
        { id: r.id, sourceId: r.connectionId, name, code: r.vendorId, productId: r.productId },
        r.product,
        [r.vendorId, r.product.sku],
        weight,
      ),
    );
  }
  return { last: rows.at(-1)?.id, items };
}

async function* evaluatedPages(accountId: string, scope: LinkScope, weight: WordWeight) {
  if (scope.variants) {
    let after: string | undefined;
    for (;;) {
      const p = await variantPage(accountId, scope.variants, weight, after);
      if (p.items.length) yield p.items;
      if (!p.last) break;
      after = p.last;
    }
  }
  if (scope.vendors) {
    let after: string | undefined;
    for (;;) {
      const p = await vendorPage(accountId, scope.vendors, weight, after);
      if (p.items.length) yield p.items;
      if (!p.last) break;
      after = p.last;
    }
  }
}

async function confirmationsOf(accountId: string, items: Evaluated[]) {
  const out = new Map<string, string | null>();
  for (const kind of ["variant", "vendor"] as const) {
    const ids = items.filter((i) => i.kind === kind).map((i) => i.itemId);
    if (!ids.length) continue;
    const rows = await accountDb(accountId).suspiciousLink.findMany({
      where: { kind, itemId: { in: ids } },
      select: { kind: true, itemId: true, confirmedKey: true },
    });
    for (const r of rows) out.set(`${r.kind}:${r.itemId}`, r.confirmedKey);
  }
  return out;
}

const isConfirmed = (e: Evaluated, confirmed: Map<string, string | null>) =>
  confirmed.get(`${e.kind}:${e.itemId}`) === e.nameKey;

/**
 * Items of the scope whose link is suspicious right now (names disagree, not confirmed for these names).
 * Live from the current names — the safety brakes use this, never a possibly stale stored flag.
 */
export async function suspiciousItemIds(accountId: string, scope: LinkScope): Promise<Set<string>> {
  const weight = await accountWeights(accountId);
  const out = new Set<string>();
  for await (const items of evaluatedPages(accountId, scope, weight)) {
    const flagged = items.filter((i) => i.disagree);
    if (!flagged.length) continue;
    const confirmed = await confirmationsOf(accountId, flagged);
    for (const e of flagged) if (!isConfirmed(e, confirmed)) out.add(e.itemId);
  }
  return out;
}

export interface RefreshResult {
  checked: number;
  flagged: number;
  removed: number;
}

/**
 * Recomputes the stored flags of the scope, page by page (one transaction per page). Rows of items that are no
 * longer linked (or archived) are removed; a confirmation stays while it still covers the current names.
 */
export async function refreshSuspiciousLinks(accountId: string, scope: LinkScope): Promise<RefreshResult> {
  const weight = await accountWeights(accountId);
  const res: RefreshResult = { checked: 0, flagged: 0, removed: 0 };
  const now = new Date();
  for await (const items of evaluatedPages(accountId, scope, weight)) {
    res.checked += items.length;
    const confirmed = await confirmationsOf(accountId, items);
    await withAccountTransaction(
      accountId,
      async (tx) => {
        for (const e of items) {
          const key = `${e.kind}:${e.itemId}`;
          const hasRow = confirmed.has(key);
          const ok = isConfirmed(e, confirmed);
          if (!e.disagree && !ok) {
            if (hasRow) {
              await tx.suspiciousLink.deleteMany({ where: { kind: e.kind, itemId: e.itemId } });
              res.removed++;
            }
            continue;
          }
          const flagged = e.disagree && !ok;
          if (flagged) res.flagged++;
          const data = {
            productId: e.productId,
            lineId: e.lineId,
            sourceId: e.sourceId,
            itemName: e.itemName,
            itemCode: e.itemCode,
            productSku: e.productSku,
            productName: e.productName,
            score: e.score,
            reasons: e.reasons,
            flagged,
            nameKey: e.nameKey,
            computedAt: now,
          };
          await tx.suspiciousLink.upsert({
            where: { accountId_kind_itemId: { accountId, kind: e.kind, itemId: e.itemId } },
            create: { accountId, kind: e.kind, itemId: e.itemId, ...data },
            update: data,
          });
        }
      },
      { timeout: 30_000, maxWait: 15_000 },
    );
  }
  res.removed += await removeUnlinked(accountId, scope);
  return res;
}

/** Stored rows of items in the scope that are no longer linked, archived, nameless or gone. */
async function removeUnlinked(accountId: string, scope: LinkScope) {
  const db = accountDb(accountId);
  let removed = 0;
  for (const kind of ["variant", "vendor"] as const) {
    if (kind === "variant" ? !scope.variants : !scope.vendors) continue;
    let after: string | undefined;
    for (;;) {
      const rows = await db.suspiciousLink.findMany({
        where: { kind, ...(after ? { id: { gt: after } } : {}) },
        select: { id: true, itemId: true, productId: true },
        orderBy: { id: "asc" },
        take: PAGE,
      });
      if (!rows.length) break;
      after = rows.at(-1)!.id;
      const ids = rows.map((r) => r.itemId);
      const alive =
        kind === "variant"
          ? await db.storeVariantLink.findMany({
              where: { id: { in: ids } },
              select: { id: true, productId: true },
            })
          : (
              await db.vendorProduct.findMany({
                where: { id: { in: ids } },
                select: { id: true, productId: true, archived: true, raw: true },
              })
            ).map((v) => ({ id: v.id, productId: v.archived || !vendorName(v.raw) ? null : v.productId }));
      const now = new Map(alive.map((a) => [a.id, a.productId]));
      const dead = rows.filter((r) => now.get(r.itemId) !== r.productId).map((r) => r.id);
      if (dead.length) removed += (await db.suspiciousLink.deleteMany({ where: { id: { in: dead } } })).count;
    }
  }
  return removed;
}

/** The whole account (after a catalogue run or an import). */
export const ALL_LINKS: LinkScope = { variants: {}, vendors: {} };

/** Every link that involves these masters (a master renamed, linked or unlinked). */
export const linksOfProducts = (productIds: string[]): LinkScope => ({
  variants: { productId: { in: productIds } },
  vendors: { productId: { in: productIds } },
});

/**
 * Refresh after an operation, never failing it: the flags are a screen aid (the safety brakes are live), so an
 * error is logged and the next trigger repairs it.
 */
export async function refreshSuspiciousLinksSafe(accountId: string, scope: LinkScope, why: string) {
  try {
    return await refreshSuspiciousLinks(accountId, scope);
  } catch (err) {
    logger.warn({ why, err: (err as Error).message }, "suspicious links refresh failed");
    return null;
  }
}

// ───────────── screens ─────────────

export interface SuspiciousRow {
  id: string;
  kind: LinkKind;
  itemId: string;
  productId: string;
  productSku: string;
  productName: string;
  itemName: string;
  itemCode: string | null;
  source: string;
  sourceType: string;
  score: number | null;
  reasons: DisagreementReason[];
}

type ListCtx = {
  accountId: string;
  companyScope: CompanyScope;
  activeCompanyId?: string | null;
  lineCompanyIds?: string[] | null;
};

/** Stores and warehouses the member sees (sidebar company / line, else the company scope). */
async function visibleSources(ctx: ListCtx) {
  const db = accountDb(ctx.accountId);
  const where = companyFilter({
    companyScope: ctx.companyScope,
    activeCompanyId: ctx.activeCompanyId ?? null,
    lineCompanyIds: ctx.lineCompanyIds ?? null,
  });
  const [stores, conns] = await Promise.all([
    db.store.findMany({ where, select: { id: true, name: true } }),
    db.fulfillmentConnection.findMany({ where, select: { id: true, name: true, type: true } }),
  ]);
  return new Map<string, { name: string; type: string }>([
    ...stores.map((s) => [s.id, { name: s.name, type: "STORE" }] as const),
    ...conns.map((c) => [c.id, { name: c.name, type: c.type as string }] as const),
  ]);
}

export const SUSPICIOUS_LIST_LIMIT = 200;

/** Flagged links the member may see; `lineId` narrows to masters of one line. */
export async function listSuspiciousLinks(
  ctx: ListCtx,
  opts: { lineId?: string | null; take?: number } = {},
): Promise<{ rows: SuspiciousRow[]; total: number }> {
  const sources = await visibleSources(ctx);
  const where: Prisma.SuspiciousLinkWhereInput = {
    flagged: true,
    sourceId: { in: [...sources.keys()] },
    ...(opts.lineId ? { lineId: opts.lineId } : {}),
  };
  const db = accountDb(ctx.accountId);
  const [rows, total] = await Promise.all([
    db.suspiciousLink.findMany({
      where,
      orderBy: [{ score: "asc" }, { productSku: "asc" }],
      take: opts.take ?? SUSPICIOUS_LIST_LIMIT,
    }),
    db.suspiciousLink.count({ where }),
  ]);
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      kind: r.kind as LinkKind,
      itemId: r.itemId,
      productId: r.productId,
      productSku: r.productSku,
      productName: r.productName,
      itemName: r.itemName,
      itemCode: r.itemCode,
      source: sources.get(r.sourceId)?.name ?? "—",
      sourceType: sources.get(r.sourceId)?.type ?? "STORE",
      score: r.score,
      reasons: Array.isArray(r.reasons) ? (r.reasons as DisagreementReason[]) : [],
    })),
  };
}

/** Count of flagged links of the given stores / warehouses (coverage card). */
export async function countSuspicious(accountId: string, sourceIds: string[], lineId?: string | null) {
  if (!sourceIds.length) return 0;
  return accountDb(accountId).suspiciousLink.count({
    where: { flagged: true, sourceId: { in: sourceIds }, ...(lineId ? { lineId } : {}) },
  });
}
