import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import {
  ordersWithProducts,
  recheckOpenOrders,
  type EnqueueCheck,
  type RecheckResult,
} from "@/server/checks/recheck";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import type { StoreClientFactory } from "@/server/fulfill/writeback";
import type { ScopedActor } from "@/server/stores";
import { processWeightWrite } from "./shopify-weight";

/**
 * Master product weight (Product.weightGrams, whole grams). One value for every order of every store and
 * warehouse: euShipments needs it for every order (awb.totalWeight) and for create-product. A person sets it
 * (Продукти, or "Въведи тегло" on an order); suggestions come from what we already mirror:
 *   - euShipments get-products WEIGHT (kg, the unit of create-product `weight`, INTEGRATION_NOTES §4.2);
 *   - FHB product `weight` (the unit is NOT documented in the FHB reference — shown as kg, one click only,
 *     never used by the bulk fill);
 *   - the Shopify variant weight (inventoryItem.measurement.weight, read by the variant sync).
 * The bulk fill only touches masters WITHOUT a weight (conditional update), so a weight a person entered is never
 * overwritten by automation. Saving re-runs the checks of open orders that contain the product.
 */

export const MIN_WEIGHT_GRAMS = 1;
export const MAX_WEIGHT_GRAMS = 100_000;
export const WEIGHT_SOURCES = ["manual", "eushipments", "fhb", "shopify"] as const;
export type WeightSource = (typeof WEIGHT_SOURCES)[number];

export const WeightInput = z.object({
  grams: z.coerce.number().int().min(MIN_WEIGHT_GRAMS).max(MAX_WEIGHT_GRAMS),
  /** Where the value came from ("Използвай" on a suggestion keeps its source; typed = manual). */
  source: z.enum(WEIGHT_SOURCES).default("manual"),
  /** "Обнови теглото и в Shopify": one write per linked store variant (store mode permitting). */
  writeToShopify: z.boolean().default(false),
});

export interface WeightSuggestion {
  source: Exclude<WeightSource, "manual">;
  grams: number;
  /** Connection or store name. */
  from: string;
  /** The raw value as the source reported it (e.g. "0.45" kg). */
  raw: string;
  /** FHB: unit not documented. */
  unitAssumed?: boolean;
}

const kgToGrams = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(",", ".")) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const g = Math.round(n * 1000);
  return g >= MIN_WEIGHT_GRAMS && g <= MAX_WEIGHT_GRAMS ? g : null;
};

/** Suggestions per product from the warehouse mirrors and the Shopify variants (reads only). */
export async function weightSuggestions(
  accountId: string,
  productIds: string[],
): Promise<Map<string, WeightSuggestion[]>> {
  const out = new Map<string, WeightSuggestion[]>();
  if (!productIds.length) return out;
  const db = accountDb(accountId);
  const [vps, links] = await Promise.all([
    db.vendorProduct.findMany({
      where: { productId: { in: productIds }, archived: false },
      select: { productId: true, raw: true, connection: { select: { type: true, name: true } } },
    }),
    db.storeVariantLink.findMany({
      where: { productId: { in: productIds }, shopifyWeightGrams: { not: null } },
      select: { productId: true, shopifyWeightGrams: true, store: { select: { name: true } } },
    }),
  ]);
  const push = (id: string, s: WeightSuggestion) => {
    const list = out.get(id) ?? [];
    if (!list.some((x) => x.source === s.source && x.grams === s.grams && x.from === s.from)) list.push(s);
    out.set(id, list);
  };
  for (const vp of vps) {
    const raw = (vp.raw ?? {}) as { weight?: unknown };
    const grams = kgToGrams(raw.weight);
    if (!vp.productId || grams === null) continue;
    if (vp.connection.type === "EUSHIPMENTS")
      push(vp.productId, { source: "eushipments", grams, from: vp.connection.name, raw: String(raw.weight) });
    else if (vp.connection.type === "FHB_V3")
      push(vp.productId, {
        source: "fhb",
        grams,
        from: vp.connection.name,
        raw: String(raw.weight),
        unitAssumed: true,
      });
  }
  for (const l of links)
    if (l.productId && l.shopifyWeightGrams && l.shopifyWeightGrams <= MAX_WEIGHT_GRAMS)
      push(l.productId, {
        source: "shopify",
        grams: l.shopifyWeightGrams,
        from: l.store.name,
        raw: `${l.shopifyWeightGrams} g`,
      });
  return out;
}

export interface ShopifyWeightQueued {
  queued: number;
  /** Stores whose "Тегло към Shopify" is DISABLED (nothing recorded for them). */
  skippedStores: string[];
  writeIds: string[];
}

export interface SetWeightResult {
  productId: string;
  grams: number;
  shopify: ShopifyWeightQueued | null;
  recheck: RecheckResult;
}

/**
 * Masters a company-restricted member may see and change: those of a line that holds one of their companies,
 * plus masters not assigned to any line yet (as the Продукти list shows them, lineProductWhere). Unscoped: all.
 */
export function productScopeWhere(actor: ScopedActor): Prisma.ProductWhereInput {
  return actor.companyScope
    ? { OR: [{ lineId: null }, { line: { companies: { some: { id: { in: actor.companyScope } } } } }] }
    : {};
}

async function assertProductInScope(actor: ScopedActor, productId: string) {
  if (!actor.companyScope) return;
  const ok = await accountDb(actor.accountId).product.findFirst({
    where: { AND: [{ id: productId }, productScopeWhere(actor)] },
    select: { id: true },
  });
  if (!ok) throw new DomainError("not_found");
}

/** Stores in which this person may change the product (company scope); all for unscoped members. */
function storeScope(actor: ScopedActor) {
  return actor.companyScope ? { store: { companyId: { in: actor.companyScope } } } : {};
}

/**
 * Queues one Shopify weight write per linked variant of the stores whose weight mode is not DISABLED.
 * Idempotent per (variant, weight): an existing row for the same weight is re-armed when nothing went out
 * for it (DRY_RUN / REFUSED / FAILED) or it was sent earlier (another weight may have been set since; the
 * sender reads back first, so an equal weight is never sent twice). Older waiting rows of the variant are
 * superseded.
 */
export async function queueShopifyWeight(
  actor: ScopedActor,
  productId: string,
  grams: number,
): Promise<ShopifyWeightQueued> {
  assertCan(actor.role, "products.weight");
  await assertProductInScope(actor, productId);
  const db = accountDb(actor.accountId);
  const links = await db.storeVariantLink.findMany({
    where: { productId, ...storeScope(actor) },
    select: { id: true, storeId: true, store: { select: { name: true, weightWriteMode: true } } },
  });
  const skipped = new Set<string>();
  const ids: string[] = [];
  for (const l of links) {
    if (l.store.weightWriteMode === "DISABLED") {
      skipped.add(l.store.name);
      continue;
    }
    const id = await withAccountTransaction(actor.accountId, async (tx, { lockKey }) => {
      await lockKey(`shopify-weight:${l.id}`);
      await tx.shopifyWeightWrite.updateMany({
        where: { variantLinkId: l.id, weightGrams: { not: grams }, status: { in: ["PENDING", "PAUSED"] } },
        data: { status: "REFUSED", lastError: "superseded" },
      });
      const existing = await tx.shopifyWeightWrite.findUnique({
        where: { variantLinkId_weightGrams: { variantLinkId: l.id, weightGrams: grams } },
      });
      if (!existing) {
        const row = await tx.shopifyWeightWrite.create({
          data: {
            accountId: actor.accountId,
            storeId: l.storeId,
            productId,
            variantLinkId: l.id,
            weightGrams: grams,
            createdById: actor.userId,
          },
        });
        return row.id;
      }
      if (["DRY_RUN_RECORDED", "REFUSED", "FAILED", "SENT"].includes(existing.status))
        await tx.shopifyWeightWrite.updateMany({
          where: { id: existing.id, status: existing.status },
          data: {
            status: "PENDING",
            attempts: 0,
            nextAttemptAt: null,
            lastError: null,
            createdById: actor.userId,
          },
        });
      return existing.id;
    });
    ids.push(id);
  }
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "shopify.weight.queued",
    entityType: "Product",
    entityId: productId,
    after: { grams, writeIds: ids, skippedStores: [...skipped] },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return { queued: ids.length, skippedStores: [...skipped], writeIds: ids };
}

export async function setProductWeight(
  actor: ScopedActor,
  productId: string,
  raw: z.input<typeof WeightInput>,
  deps: { enqueue?: EnqueueCheck; clients?: StoreClientFactory; now?: Date } = {},
): Promise<SetWeightResult> {
  assertCan(actor.role, "products.weight");
  const input = WeightInput.parse(raw);
  const db = accountDb(actor.accountId);
  const before = await db.product.findFirst({
    where: { AND: [{ id: productId }, productScopeWhere(actor)] },
    select: { id: true, archived: true, weightGrams: true, weightSource: true },
  });
  if (!before || before.archived) throw new DomainError("not_found");
  const now = deps.now ?? new Date();
  await db.product.update({
    where: { id: productId },
    data: {
      weightGrams: input.grams,
      weightSource: input.source,
      weightSetAt: now,
      weightSetById: actor.userId,
    },
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "product.weight",
    entityType: "Product",
    entityId: productId,
    before: { weightGrams: before.weightGrams, weightSource: before.weightSource },
    after: { weightGrams: input.grams, weightSource: input.source, writeToShopify: input.writeToShopify },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  let shopify: ShopifyWeightQueued | null = null;
  if (input.writeToShopify) {
    shopify = await queueShopifyWeight(actor, productId, input.grams);
    // The sender's gate for the outcomes that never call Shopify (DRY_RUN record, DISABLED, pause): visible on
    // the product at once. LIVE rows stay PENDING for the worker.
    for (const id of shopify.writeIds) await processWeightWrite(id, deps.clients, now, { offlineOnly: true });
  }
  const recheck = await recheckOpenOrders(actor.accountId, ordersWithProducts([productId]), {
    actor: { kind: "user", userId: actor.userId },
    enqueue: deps.enqueue,
  });
  return { productId, grams: input.grams, shopify, recheck };
}

export interface BulkFillResult {
  /** Masters without a weight that were looked at. */
  candidates: number;
  filled: number;
  /** No euShipments weight known for the product. */
  noSuggestion: number;
  /** Two euShipments connections disagree — left for a person. */
  conflicts: number;
  /** Got a weight from someone else meanwhile (never overwritten). */
  skipped: number;
  recheck: RecheckResult;
}

const BULK_BATCH = 200;

/**
 * "Попълни теглата от склада": masters WITHOUT a weight get the euShipments get-products weight (documented in
 * kg). Batched; the update is conditional on weightGrams still being empty, so nothing a person entered (or
 * entered meanwhile) is ever overwritten. Shopify is not touched by the bulk fill.
 */
export async function fillWeightsFromWarehouse(
  actor: ScopedActor,
  opts: { lineId?: string | null; enqueue?: EnqueueCheck } = {},
): Promise<BulkFillResult> {
  assertCan(actor.role, "products.weight");
  const db = accountDb(actor.accountId);
  const result: BulkFillResult = {
    candidates: 0,
    filled: 0,
    noSuggestion: 0,
    conflicts: 0,
    skipped: 0,
    recheck: { total: 0, checked: 0, queued: 0, cleared: 0, failed: 0 },
  };
  const filledIds: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const batch = await db.product.findMany({
      where: {
        AND: [
          { archived: false, weightGrams: null },
          opts.lineId ? { lineId: opts.lineId } : {},
          productScopeWhere(actor),
        ],
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: BULK_BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!batch.length) break;
    cursor = batch[batch.length - 1]!.id;
    result.candidates += batch.length;
    const sugg = await weightSuggestions(
      actor.accountId,
      batch.map((p) => p.id),
    );
    for (const p of batch) {
      const eu = [
        ...new Set((sugg.get(p.id) ?? []).filter((s) => s.source === "eushipments").map((s) => s.grams)),
      ];
      if (!eu.length) {
        result.noSuggestion++;
        continue;
      }
      if (eu.length > 1) {
        result.conflicts++;
        continue;
      }
      const res = await db.product.updateMany({
        where: { id: p.id, weightGrams: null },
        data: {
          weightGrams: eu[0]!,
          weightSource: "eushipments",
          weightSetAt: new Date(),
          weightSetById: actor.userId,
        },
      });
      if (res.count === 1) {
        result.filled++;
        filledIds.push(p.id);
      } else result.skipped++;
    }
    if (batch.length < BULK_BATCH) break;
  }
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "product.weight_bulk_fill",
    entityType: "Product",
    after: { ...result, recheck: undefined, productIds: filledIds.slice(0, 500) },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  if (filledIds.length)
    result.recheck = await recheckOpenOrders(actor.accountId, ordersWithProducts(filledIds), {
      actor: { kind: "user", userId: actor.userId },
      enqueue: opts.enqueue,
    });
  return result;
}

/** Product weight panel: master weight, suggestions, linked variants and their Shopify weight writes. */
export async function productWeightView(actor: ScopedActor, productId: string) {
  assertCan(actor.role, "account.read");
  const db = accountDb(actor.accountId);
  const product = await db.product.findFirst({
    where: { AND: [{ id: productId }, productScopeWhere(actor)] },
    select: {
      id: true,
      sku: true,
      name: true,
      archived: true,
      weightGrams: true,
      weightSource: true,
      weightSetAt: true,
      weightSetById: true,
    },
  });
  if (!product) throw new DomainError("not_found");
  const [suggestions, variants, writes, setBy] = await Promise.all([
    weightSuggestions(actor.accountId, [productId]),
    db.storeVariantLink.findMany({
      where: { productId, ...storeScope(actor) },
      select: {
        id: true,
        title: true,
        sku: true,
        shopifyWeightGrams: true,
        store: { select: { id: true, name: true, weightWriteMode: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    db.shopifyWeightWrite.findMany({
      where: { productId, ...storeScope(actor) },
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: {
        id: true,
        variantLinkId: true,
        weightGrams: true,
        status: true,
        evaluatedMode: true,
        request: true,
        lastError: true,
        sentAt: true,
        updatedAt: true,
        store: { select: { name: true } },
      },
    }),
    product.weightSetById
      ? db.membership.findFirst({
          where: { userId: product.weightSetById },
          select: { user: { select: { name: true, email: true } } },
        })
      : null,
  ]);
  return {
    product,
    setByName: setBy ? (setBy.user.name ?? setBy.user.email) : null,
    suggestions: suggestions.get(productId) ?? [],
    variants,
    writes,
    /** Default of "Обнови теглото и в Shopify": on only if some linked store allows it. */
    shopifyAllowed: variants.some((v) => v.store.weightWriteMode !== "DISABLED"),
  };
}
