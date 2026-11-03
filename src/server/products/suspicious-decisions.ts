import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { DomainError, type Actor } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { recheckOpenOrders, type EnqueueCheck, type RecheckResult } from "@/server/checks/recheck";
import type { CompanyScope } from "@/server/companies";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { PRE_APPROVAL } from "@/server/shopify/statuses";
import { UNLINKED_BY_PERSON } from "@/server/shopify/products";
import { refreshSuspiciousLinks } from "./suspicious";

/** "Съмнителни връзки" decisions: confirm (same product) or unlink — audited, then the open orders re-checked. */

type Tx = Prisma.TransactionClient;
type ScopedActor = Actor & { companyScope: CompanyScope };
const RELINKABLE = [...PRE_APPROVAL];

// ───────────── decisions ─────────────

const IdInput = z.string().min(1).max(64);

/** The row, checked to belong to a store / warehouse of a company the actor may see. */
async function scopedRow(tx: Tx, actor: ScopedActor, id: string) {
  const row = await tx.suspiciousLink.findUnique({ where: { id } });
  if (!row) throw new DomainError("not_found");
  const source =
    row.kind === "variant"
      ? await tx.store.findUnique({ where: { id: row.sourceId }, select: { companyId: true } })
      : await tx.fulfillmentConnection.findUnique({
          where: { id: row.sourceId },
          select: { companyId: true },
        });
  if (!source || (actor.companyScope && !actor.companyScope.includes(source.companyId ?? ""))) {
    throw new DomainError("not_found");
  }
  return row;
}

async function recheckAfter(
  actor: ScopedActor,
  row: { kind: string; itemId: string; productId: string },
  enqueue?: EnqueueCheck,
): Promise<RecheckResult | null> {
  try {
    return await recheckOpenOrders(
      actor.accountId,
      row.kind === "variant"
        ? { lines: { some: { variantLinkId: row.itemId } } }
        : { lines: { some: { productId: row.productId } } },
      { actor: { kind: "user", userId: actor.userId }, enqueue },
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "recheck after suspicious link decision failed");
    return null;
  }
}

/**
 * "Потвърди (същият продукт е)": the link stays and is not flagged again while both names stay as they are now.
 * Refuses when the link changed meanwhile (another product, or names no longer as shown).
 */
export async function confirmSuspiciousLink(
  actor: ScopedActor,
  rawId: string,
  deps: { enqueue?: EnqueueCheck } = {},
) {
  assertCan(actor.role, "products.suspicious");
  const id = IdInput.parse(rawId);
  const row = await withAccountTransaction(actor.accountId, (tx) => scopedRow(tx, actor, id));
  // The current names: the confirmation covers what the person sees now, never a stale row.
  await refreshSuspiciousLinks(
    actor.accountId,
    row.kind === "variant" ? { variants: { id: row.itemId } } : { vendors: { id: row.itemId } },
  );
  const fresh = await accountDb(actor.accountId).suspiciousLink.findUnique({ where: { id } });
  if (!fresh || fresh.productId !== row.productId || fresh.nameKey !== row.nameKey) {
    throw new DomainError("link_changed");
  }
  await accountDb(actor.accountId).suspiciousLink.update({
    where: { id },
    data: {
      confirmedKey: fresh.nameKey,
      confirmedAt: new Date(),
      confirmedById: actor.userId,
      flagged: false,
    },
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "product.suspicious_link_confirmed",
    entityType: row.kind === "variant" ? "StoreVariantLink" : "VendorProduct",
    entityId: row.itemId,
    after: {
      productId: row.productId,
      sku: row.productSku,
      itemName: row.itemName,
      productName: row.productName,
      score: row.score,
    },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return { recheck: await recheckAfter(actor, row, deps.enqueue) };
}

/**
 * "Развържи": removes the link (store variant or warehouse product → master). A variant is marked "unlinked" so
 * the next Shopify sync does not re-link it by SKU; lines of orders not sent anywhere lose the product (they show
 * up as unmatched until a person links the right one).
 */
export async function unlinkSuspiciousLink(
  actor: ScopedActor,
  rawId: string,
  deps: { enqueue?: EnqueueCheck } = {},
) {
  assertCan(actor.role, "products.suspicious");
  const id = IdInput.parse(rawId);
  const row = await withAccountTransaction(actor.accountId, async (tx) => {
    const r = await scopedRow(tx, actor, id);
    if (r.kind === "variant") {
      const res = await tx.storeVariantLink.updateMany({
        where: { id: r.itemId, productId: r.productId },
        data: { productId: null, matchMethod: UNLINKED_BY_PERSON, matchedAt: new Date() },
      });
      if (res.count !== 1) throw new DomainError("link_changed");
      await tx.orderLine.updateMany({
        where: { variantLinkId: r.itemId, productId: r.productId, order: { status: { in: RELINKABLE } } },
        data: { productId: null },
      });
    } else {
      const res = await tx.vendorProduct.updateMany({
        where: { id: r.itemId, productId: r.productId },
        data: { productId: null },
      });
      if (res.count !== 1) throw new DomainError("link_changed");
    }
    await tx.suspiciousLink.delete({ where: { id } });
    return r;
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "product.suspicious_link_unlinked",
    entityType: row.kind === "variant" ? "StoreVariantLink" : "VendorProduct",
    entityId: row.itemId,
    before: { productId: row.productId, sku: row.productSku },
    after: { productId: null, itemName: row.itemName, productName: row.productName, score: row.score },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return { recheck: await recheckAfter(actor, row, deps.enqueue) };
}
