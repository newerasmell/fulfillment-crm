import { z } from "zod";
import type { ShopifyClient } from "@/integrations/shopify/client";
import {
  PRODUCT_VARIANTS_QUERY,
  ProductVariants,
  VARIANTS_PAGE_QUERY,
  VariantsPage,
  type ShopifyVariant,
} from "@/integrations/shopify/products";
import { DomainError, type Actor } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import type { CompanyScope } from "@/server/companies";
import { accountDb, isUniqueViolation, withAccountTransaction } from "@/server/db/client";
import { logger } from "@/lib/logger";

/**
 * Shopify variants → StoreVariantLink, matched to the group's master Product (SPEC §3). One physical product
 * has ONE master record; each store's variant and each warehouse's code point to it.
 * Auto-match: variant SKU with the store's prefix stripped == master SKU (case-insensitive). A manual link is
 * never overwritten by the automation. EAN/barcode is kept for display and suggestions, never as the key.
 */

export function stripSkuPrefix(
  sku: string | null | undefined,
  prefix: string | null | undefined,
): string | null {
  const s = sku?.trim();
  if (!s) return null;
  const p = prefix?.trim();
  return p && s.toLowerCase().startsWith(p.toLowerCase()) && s.length > p.length ? s.slice(p.length) : s;
}

type StoreForSync = { id: string; skuPrefix: string | null };
type Tx = Parameters<Parameters<typeof withAccountTransaction>[1]>[0];

/** Automatic match: SKU without the store prefix equals a master SKU (case-insensitive). */
export async function matchBySku(tx: Tx, sku: string | null | undefined, prefix: string | null | undefined) {
  const key = stripSkuPrefix(sku, prefix);
  if (!key) return null;
  const product = await tx.product.findFirst({
    where: { sku: { equals: key, mode: "insensitive" }, archived: false },
    select: { id: true },
  });
  return product ? { productId: product.id, matchMethod: "sku", matchedAt: new Date() } : null;
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
    };
    const match = existing?.productId ? null : await matchBySku(tx, v.sku, store.skuPrefix);
    const link = existing
      ? await tx.storeVariantLink.update({ where: { id: existing.id }, data: { ...data, ...(match ?? {}) } })
      : await tx.storeVariantLink.create({
          data: { accountId, storeId: store.id, shopifyVariantGid: v.id, ...data, ...(match ?? {}) },
        });
    if (match) await attachOrderLines(tx, link.id, match.productId);
    return { linkId: link.id, matched: !!(link.productId ?? match) };
  });
}

/** Order lines imported before the variant was matched get the product now (only if still unset). */
async function attachOrderLines(tx: Tx, linkId: string, productId: string) {
  await tx.orderLine.updateMany({ where: { variantLinkId: linkId, productId: null }, data: { productId } });
}

export async function syncStoreProducts(accountId: string, store: StoreForSync, client: ShopifyClient) {
  let after: string | null = null;
  const counts = { variants: 0, matched: 0 };
  for (let page = 0; page < 1000; page++) {
    const res: z.infer<typeof VariantsPage> = await client.query(
      VARIANTS_PAGE_QUERY,
      { first: 100, after, query: null },
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
  return counts;
}

/** Webhook follow-up for products/update: re-read the product's variants from Shopify. */
export async function refreshShopifyProduct(
  accountId: string,
  store: StoreForSync,
  client: ShopifyClient,
  productGid: string,
) {
  const { product } = await client.query(PRODUCT_VARIANTS_QUERY, { id: productGid }, ProductVariants);
  for (const v of product?.variants.nodes ?? []) await upsertVariant(accountId, store, v);
}

// ───────────── the "unmatched" work queue ─────────────

export async function listUnmatchedVariants(
  ctx: { accountId: string; companyScope: CompanyScope; activeCompanyId: string | null },
  take = 200,
) {
  const storeWhere = ctx.activeCompanyId
    ? { companyId: ctx.activeCompanyId }
    : ctx.companyScope
      ? { companyId: { in: ctx.companyScope } }
      : {};
  return accountDb(ctx.accountId).storeVariantLink.findMany({
    where: { productId: null, store: storeWhere },
    include: { store: { select: { name: true, code: true, skuPrefix: true } } },
    orderBy: [{ store: { name: "asc" } }, { title: "asc" }],
    take,
  });
}

async function linkVariantTo(
  actor: Actor & { companyScope: CompanyScope },
  linkId: string,
  productId: string,
  method: "manual" | "created",
) {
  await withAccountTransaction(actor.accountId, async (tx) => {
    const link = await tx.storeVariantLink.findUnique({
      where: { id: linkId },
      include: { store: { select: { companyId: true } } },
    });
    if (!link || (actor.companyScope && !actor.companyScope.includes(link.store.companyId ?? ""))) {
      throw new DomainError("not_found");
    }
    await tx.storeVariantLink.update({
      where: { id: linkId },
      data: { productId, matchMethod: method, matchedAt: new Date() },
    });
    await attachOrderLines(tx, linkId, productId);
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "variant.link",
    entityType: "StoreVariantLink",
    entityId: linkId,
    after: { productId, method },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}

export async function linkVariant(
  actor: Actor & { companyScope: CompanyScope },
  linkId: string,
  productSku: string,
) {
  assertCan(actor.role, "products.match");
  const product = await accountDb(actor.accountId).product.findFirst({
    where: { sku: { equals: productSku.trim(), mode: "insensitive" }, archived: false },
  });
  if (!product) throw new DomainError("product_not_found");
  await linkVariantTo(actor, linkId, product.id, "manual");
}

/** Creates the master product from a Shopify variant (SKU without the store prefix) and links it. */
export async function createProductFromVariant(
  actor: Actor & { companyScope: CompanyScope },
  linkId: string,
) {
  assertCan(actor.role, "products.match");
  const db = accountDb(actor.accountId);
  const link = await db.storeVariantLink.findUnique({ where: { id: linkId }, include: { store: true } });
  if (!link) throw new DomainError("not_found");
  const sku = stripSkuPrefix(link.sku, link.store.skuPrefix);
  if (!sku) throw new DomainError("variant_without_sku");
  let product;
  try {
    product = await db.product.create({ data: { accountId: actor.accountId, sku, name: link.title } });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError("product_exists");
    throw err;
  }
  if (link.barcode) {
    // Informational only (EAN is never a key); a barcode already recorded elsewhere is simply not repeated.
    await db.productEan
      .create({
        data: { accountId: actor.accountId, productId: product.id, ean: link.barcode, source: "shopify" },
      })
      .catch((err) => {
        if (!isUniqueViolation(err)) throw err;
      });
  }
  await linkVariantTo(actor, linkId, product.id, "created");
  return product;
}
