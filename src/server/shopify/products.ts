import type { z } from "zod";
import type { CrmOrderStatus } from "@/generated/prisma/client";
import type { ShopifyClient } from "@/integrations/shopify/client";
import {
  PRODUCT_VARIANTS_QUERY,
  ProductVariants,
  VARIANTS_PAGE_QUERY,
  VARIANTS_PAGE_SIZE,
  VariantsPage,
  type ShopifyVariant,
} from "@/integrations/shopify/products";
import { weightToGrams } from "@/integrations/shopify/weights";
import { DomainError, type Actor } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { companyFilter, type CompanyScope } from "@/server/companies";
import { accountDb, isUniqueViolation, withAccountTransaction } from "@/server/db/client";
import { logger } from "@/lib/logger";
import { lineProductWhere } from "@/server/lines/lines";
import { PRE_APPROVAL } from "./statuses";
import { refreshSuspiciousLinksSafe } from "@/server/products/suspicious";

/**
 * Shopify variants → StoreVariantLink, matched to the group's master Product (SPEC §3). One physical product
 * has ONE master record; each store's variant and each warehouse's code point to it.
 * Auto-match: variant SKU with the store's prefix stripped == master SKU (case-insensitive, and only when
 * exactly one master product fits). A manual link is never overwritten by the automation. EAN/barcode is kept
 * for display only, never as a key.
 */

/** Orders whose lines may still be re-pointed to another product (nothing sent to a warehouse yet). */
const RELINKABLE: CrmOrderStatus[] = [...PRE_APPROVAL];

/** matchMethod of a variant a person unlinked: automatic SKU matching leaves it alone. */
export const UNLINKED_BY_PERSON = "unlinked";

export function stripSkuPrefix(
  sku: string | null | undefined,
  prefix: string | null | undefined,
): string | null {
  const s = sku?.trim();
  if (!s) return null;
  const p = prefix?.trim();
  return p && s.toLowerCase().startsWith(p.toLowerCase()) && s.length > p.length ? s.slice(p.length) : s;
}

/** `lineId`: the product line of the store's company (P5-00); looked up when not given. */
type StoreForSync = { id: string; skuPrefix: string | null; lineId?: string | null };
type Tx = Parameters<Parameters<typeof withAccountTransaction>[1]>[0];

/** Automatic match: SKU without the store prefix equals exactly one master SKU (case-insensitive). */
export async function matchBySku(
  tx: Tx,
  sku: string | null | undefined,
  prefix: string | null | undefined,
  lineId: string | null = null,
) {
  const key = stripSkuPrefix(sku, prefix);
  if (!key) return null;
  const products = await tx.product.findMany({
    where: { sku: { equals: key, mode: "insensitive" }, archived: false, ...lineProductWhere(lineId) },
    select: { id: true },
    take: 2,
  });
  // Two masters that differ only by case are ambiguous: leave it to a person.
  return products.length === 1
    ? { productId: products[0]!.id, matchMethod: "sku", matchedAt: new Date() }
    : null;
}

export async function upsertVariant(accountId: string, store: StoreForSync, v: ShopifyVariant) {
  return withAccountTransaction(accountId, async (tx) => {
    const existing = await tx.storeVariantLink.findUnique({
      where: { storeId_shopifyVariantGid: { storeId: store.id, shopifyVariantGid: v.id } },
    });
    const data = {
      shopifyProductGid: v.product.id,
      sku: v.sku?.trim() || null,
      barcode: v.barcodes.nodes[0]?.value ?? null,
      title: v.displayName,
      // Shopify's variant weight is kept as a suggestion for the master weight (never applied by itself).
      shopifyWeightGrams: weightToGrams(v.inventoryItem?.measurement?.weight),
    };
    const lineId =
      store.lineId !== undefined
        ? store.lineId
        : ((
            await tx.store.findUnique({
              where: { id: store.id },
              select: { company: { select: { lineId: true } } },
            })
          )?.company?.lineId ?? null);
    // A variant a person unlinked ("Съмнителни връзки" → Развържи) is never re-linked by SKU automatically.
    const match =
      existing?.productId || existing?.matchMethod === UNLINKED_BY_PERSON
        ? null
        : await matchBySku(tx, v.sku, store.skuPrefix, lineId);
    const link = existing
      ? await tx.storeVariantLink.update({ where: { id: existing.id }, data: { ...data, ...(match ?? {}) } })
      : await tx.storeVariantLink.create({
          data: { accountId, storeId: store.id, shopifyVariantGid: v.id, ...data, ...(match ?? {}) },
        });
    // Automatic match only fills lines that have no product yet.
    if (match)
      await tx.orderLine.updateMany({
        where: { variantLinkId: link.id, productId: null, productChoice: { is: null } },
        data: { productId: match.productId },
      });
    return { linkId: link.id, matched: !!link.productId };
  });
}

export async function syncStoreProducts(accountId: string, store: StoreForSync, client: ShopifyClient) {
  store = {
    ...store,
    lineId: store.lineId !== undefined ? store.lineId : await storeLineId(accountId, store.id),
  };
  let after: string | null = null;
  const counts = { variants: 0, matched: 0 };
  for (let page = 0; page < 100_000; page++) {
    const res: z.infer<typeof VariantsPage> = await client.query(
      VARIANTS_PAGE_QUERY,
      { first: VARIANTS_PAGE_SIZE, after, query: null },
      VariantsPage,
    );
    for (const v of res.productVariants.nodes) {
      counts.variants++;
      if ((await upsertVariant(accountId, store, v)).matched) counts.matched++;
    }
    if (!res.productVariants.pageInfo.hasNextPage) break;
    after = res.productVariants.pageInfo.endCursor ?? null;
  }
  logger.info({ storeId: store.id, ...counts }, "shopify products synced");
  // Names may have changed (or a SKU now names another product): re-check this store's links, batched.
  await refreshSuspiciousLinksSafe(accountId, { variants: { storeId: store.id } }, "shopify_products");
  return counts;
}

async function storeLineId(accountId: string, storeId: string) {
  const s = await accountDb(accountId).store.findUnique({
    where: { id: storeId },
    select: { company: { select: { lineId: true } } },
  });
  return s?.company?.lineId ?? null;
}

/** Webhook follow-up for products/update: re-read the product's variants from Shopify (all pages). */
export async function refreshShopifyProduct(
  accountId: string,
  store: StoreForSync,
  client: ShopifyClient,
  productGid: string,
) {
  let after: string | null = null;
  for (let page = 0; page < 1000; page++) {
    const res: z.infer<typeof ProductVariants> = await client.query(
      PRODUCT_VARIANTS_QUERY,
      { id: productGid, after },
      ProductVariants,
    );
    if (!res.product) return;
    for (const v of res.product.variants.nodes) await upsertVariant(accountId, store, v);
    if (!res.product.variants.pageInfo.hasNextPage) break;
    after = res.product.variants.pageInfo.endCursor ?? null;
  }
  await refreshSuspiciousLinksSafe(
    accountId,
    { variants: { storeId: store.id, shopifyProductGid: productGid } },
    "shopify_product_update",
  );
}

// ───────────── the "unmatched" work queue ─────────────

type ScopedActor = Actor & { companyScope: CompanyScope };

export async function listUnmatchedVariants(
  ctx: {
    accountId: string;
    companyScope: CompanyScope;
    activeCompanyId: string | null;
    lineCompanyIds?: string[] | null;
  },
  take = 200,
) {
  const storeWhere = companyFilter(ctx);
  return accountDb(ctx.accountId).storeVariantLink.findMany({
    where: { productId: null, store: storeWhere },
    include: { store: { select: { name: true, code: true, skuPrefix: true } } },
    orderBy: [{ store: { name: "asc" } }, { title: "asc" }],
    take,
  });
}

/** Loads a link the actor may see (its store's company is in scope); not_found otherwise. */
async function scopedLink(tx: Tx, actor: ScopedActor, linkId: string) {
  const link = await tx.storeVariantLink.findUnique({ where: { id: linkId }, include: { store: true } });
  if (!link || (actor.companyScope && !actor.companyScope.includes(link.store.companyId ?? ""))) {
    throw new DomainError("not_found");
  }
  return link;
}

/**
 * Points the variant (and the lines of orders not yet sent anywhere) at the product. A person's decision
 * also replaces a previous link, so re-linking from A to B moves those order lines to B.
 */
async function applyLink(tx: Tx, linkId: string, productId: string, method: "manual" | "created") {
  await tx.storeVariantLink.update({
    where: { id: linkId },
    data: { productId, matchMethod: method, matchedAt: new Date() },
  });
  await tx.orderLine.updateMany({
    // A line whose product a person chose by hand keeps it.
    where: { variantLinkId: linkId, order: { status: { in: RELINKABLE } }, productChoice: { is: null } },
    data: { productId },
  });
}

async function auditLink(
  actor: ScopedActor,
  linkId: string,
  before: string | null,
  productId: string,
  method: string,
) {
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "variant.link",
    entityType: "StoreVariantLink",
    entityId: linkId,
    before: { productId: before },
    after: { productId, method },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}

export async function linkVariant(actor: ScopedActor, linkId: string, productSku: string) {
  assertCan(actor.role, "products.match");
  const { before, productId } = await withAccountTransaction(actor.accountId, async (tx) => {
    const link = await scopedLink(tx, actor, linkId);
    // Never a master of another product line (P5-00); unassigned masters stay linkable.
    const lineId = link.store.companyId
      ? ((await tx.company.findUnique({ where: { id: link.store.companyId }, select: { lineId: true } }))
          ?.lineId ?? null)
      : null;
    const products = await tx.product.findMany({
      where: {
        sku: { equals: productSku.trim(), mode: "insensitive" },
        archived: false,
        ...lineProductWhere(lineId),
      },
      select: { id: true, sku: true },
    });
    const product =
      products.find((p) => p.sku === productSku.trim()) ?? (products.length === 1 ? products[0] : null);
    if (!product) throw new DomainError("product_not_found");
    await applyLink(tx, linkId, product.id, "manual");
    return { before: link.productId, productId: product.id };
  });
  await auditLink(actor, linkId, before, productId, "manual");
  await refreshSuspiciousLinksSafe(actor.accountId, { variants: { id: linkId } }, "variant_link");
}

/** Creates the master product from a Shopify variant (SKU without the store prefix) and links it — atomically. */
export async function createProductFromVariant(actor: ScopedActor, linkId: string) {
  assertCan(actor.role, "products.match");
  const result = await withAccountTransaction(actor.accountId, async (tx) => {
    const link = await scopedLink(tx, actor, linkId);
    const sku = stripSkuPrefix(link.sku, link.store.skuPrefix);
    if (!sku) throw new DomainError("variant_without_sku");
    if (
      await tx.product.findFirst({
        where: { sku: { equals: sku, mode: "insensitive" } },
        select: { id: true },
      })
    ) {
      throw new DomainError("product_exists");
    }
    const lineId =
      (
        await tx.company.findFirst({
          where: { id: link.store.companyId ?? "" },
          select: { lineId: true },
        })
      )?.lineId ?? null;
    const product = await tx.product.create({
      data: { accountId: actor.accountId, sku, name: cleanVariantTitle(link.title), lineId },
    });
    // Informational only (EAN is never a key).
    if (link.barcode) {
      await tx.productEan.create({
        data: { accountId: actor.accountId, productId: product.id, ean: link.barcode, source: "shopify" },
      });
    }
    await applyLink(tx, linkId, product.id, "created");
    return { product, before: link.productId };
  }).catch((err) => {
    if (isUniqueViolation(err)) throw new DomainError("product_exists");
    throw err;
  });
  await auditLink(actor, linkId, result.before, result.product.id, "created");
  await refreshSuspiciousLinksSafe(actor.accountId, { variants: { id: linkId } }, "variant_link");
  return result.product;
}

/** "Sample EDP 50 ml - Default Title" → "Sample EDP 50 ml" (single-variant products carry Shopify's placeholder). */
export function cleanVariantTitle(title: string) {
  return title.replace(/\s+-\s+Default Title$/i, "").trim();
}
