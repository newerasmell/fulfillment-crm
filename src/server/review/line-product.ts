import { z } from "zod";
import { logger } from "@/lib/logger";
import type { Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { assertCan } from "@/server/auth/rbac";
import { checkOrder } from "@/server/checks";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { lineConnectionsWhere, lineProductWhere } from "@/server/lines/lines";
import { STOCK_CONNECTION_TYPES } from "@/server/routing/engine";
import type { ScopedActor } from "@/server/stores";
import { EDITABLE_STATUSES } from "./service";

/**
 * "Избери продукт за реда" (owner request 2026-11-05). Some shop items are decided per order: a "Mystery Decant"
 * has no fixed product; a person (later an agent) picks which real product to send from the customer's other items,
 * stock and earlier orders. The pick is for THIS order line only:
 *   - line.productId is set and an OrderLineProductChoice row remembers it was chosen by hand, so order re-imports
 *     (orders/updated webhooks, reconcile) and product re-links keep it;
 *   - the Shopify variant link is NOT changed, so the next order of the same item asks again;
 *   - allowed only before the order is sent (the review statuses), audited, and the order is checked again.
 * Clearing the pick puts the line back to its variant's product (or unmatched).
 */

const Choose = z.object({
  orderId: z.string().min(1).max(64),
  lineId: z.string().min(1).max(64),
  productId: z.string().min(1).max(64),
  note: z
    .string()
    .trim()
    .max(300)
    .nullish()
    .transform((v) => v || null),
});
const Clear = z.object({ orderId: z.string().min(1).max(64), lineId: z.string().min(1).max(64) });

const isEditable = (s: string) => (EDITABLE_STATUSES as readonly string[]).includes(s);

async function scopedLine(tx: Prisma.TransactionClient, actor: ScopedActor, orderId: string, lineId: string) {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, companyId: true, company: { select: { lineId: true } } },
  });
  if (!order || (actor.companyScope && !actor.companyScope.includes(order.companyId ?? "")))
    throw new DomainError("not_found");
  if (!isEditable(order.status)) throw new DomainError("not_editable");
  const line = await tx.orderLine.findFirst({
    where: { id: lineId, orderId },
    select: {
      id: true,
      title: true,
      sku: true,
      productId: true,
      variantLinkId: true,
      variantLink: { select: { productId: true } },
      productChoice: { select: { productId: true, note: true, previousProductId: true } },
    },
  });
  if (!line) throw new DomainError("not_found");
  return { order, line };
}

export async function chooseLineProduct(actor: ScopedActor, input: unknown) {
  assertCan(actor.role, "orders.review");
  const v = Choose.parse(input);
  await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("Order", v.orderId);
    const { order, line } = await scopedLine(tx, actor, v.orderId, v.lineId);
    const product = await tx.product.findFirst({
      where: { id: v.productId, archived: false, ...lineProductWhere(order.company?.lineId) },
      select: { id: true, sku: true },
    });
    if (!product) throw new DomainError("product_not_found");
    await tx.orderLineProductChoice.upsert({
      where: { accountId_orderLineId: { accountId: actor.accountId, orderLineId: line.id } },
      create: {
        accountId: actor.accountId,
        orderLineId: line.id,
        productId: product.id,
        previousProductId: line.productId,
        userId: actor.userId,
        note: v.note,
      },
      update: { productId: product.id, userId: actor.userId, note: v.note },
    });
    await tx.orderLine.update({ where: { id: line.id }, data: { productId: product.id } });
    await tx.auditLog.create({
      data: {
        accountId: actor.accountId,
        userId: actor.userId,
        action: "order.line_product_chosen",
        entityType: "Order",
        entityId: order.id,
        before: { lineId: line.id, title: line.title, productId: line.productId },
        after: { lineId: line.id, productId: product.id, sku: product.sku, note: v.note },
        ip: actor.ip ?? null,
        userAgent: actor.userAgent?.slice(0, 300) ?? null,
      },
    });
  });
  return recheck(actor, v.orderId);
}

export async function clearLineProduct(actor: ScopedActor, input: unknown) {
  assertCan(actor.role, "orders.review");
  const v = Clear.parse(input);
  const changed = await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("Order", v.orderId);
    const { order, line } = await scopedLine(tx, actor, v.orderId, v.lineId);
    if (!line.productChoice) return false;
    // A Shopify line goes back to what its variant links to now; a line without a variant (manual order) to the
    // product it had before the first pick.
    const back = line.variantLinkId
      ? (line.variantLink?.productId ?? null)
      : line.productChoice.previousProductId;
    await tx.orderLineProductChoice.delete({
      where: { accountId_orderLineId: { accountId: actor.accountId, orderLineId: line.id } },
    });
    await tx.orderLine.update({ where: { id: line.id }, data: { productId: back } });
    await tx.auditLog.create({
      data: {
        accountId: actor.accountId,
        userId: actor.userId,
        action: "order.line_product_cleared",
        entityType: "Order",
        entityId: order.id,
        before: { lineId: line.id, productId: line.productId, note: line.productChoice.note },
        after: { lineId: line.id, productId: back },
        ip: actor.ip ?? null,
        userAgent: actor.userAgent?.slice(0, 300) ?? null,
      },
    });
    return true;
  });
  if (!changed) return null;
  return recheck(actor, v.orderId);
}

/** The pick is saved; a failing re-check must not report the save as failed (the check sweep runs it again). */
async function recheck(actor: ScopedActor, orderId: string) {
  try {
    return await checkOrder(actor.accountId, orderId, { actor: { kind: "user", userId: actor.userId } });
  } catch (err) {
    logger.warn({ orderId, err: String(err) }, "re-check after a line product pick failed");
    return null;
  }
}

export const LINE_PRODUCT_SEARCH_LIMIT = 20;

/**
 * Masters to pick from for one order line: by SKU, name or a warehouse code, of the order company's product line,
 * with sellable stock per warehouse (local mirrors only).
 */
export async function searchLineProducts(actor: ScopedActor, orderId: string, raw: string) {
  assertCan(actor.role, "orders.review");
  const q = raw.trim().slice(0, 100);
  if (q.length < 2) return { products: [], connections: [] };
  const db = accountDb(actor.accountId);
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { companyId: true, company: { select: { lineId: true } } },
  });
  if (!order || (actor.companyScope && !actor.companyScope.includes(order.companyId ?? "")))
    throw new DomainError("not_found");
  const contains = { contains: q, mode: "insensitive" as const };
  const [connections, products] = await Promise.all([
    db.fulfillmentConnection.findMany({
      where: { type: { in: [...STOCK_CONNECTION_TYPES] }, ...lineConnectionsWhere(order.company?.lineId) },
      select: { id: true, name: true, type: true },
      orderBy: { name: "asc" },
    }),
    db.product.findMany({
      where: {
        archived: false,
        AND: [
          lineProductWhere(order.company?.lineId),
          {
            OR: [
              { sku: contains },
              { name: contains },
              { vendorProducts: { some: { OR: [{ vendorId: contains }, { vendorCode: contains }] } } },
            ],
          },
        ],
      },
      select: {
        id: true,
        sku: true,
        name: true,
        isTester: true,
        vendorProducts: {
          where: { archived: false },
          select: { connectionId: true, stockLevel: { select: { sellable: true } } },
          orderBy: { id: "asc" },
        },
      },
      orderBy: { sku: "asc" },
      take: LINE_PRODUCT_SEARCH_LIMIT,
    }),
  ]);
  return {
    connections,
    products: products.map((p) => {
      const stock: Record<string, number | null> = {};
      for (const vp of p.vendorProducts)
        if (!(vp.connectionId in stock)) stock[vp.connectionId] = vp.stockLevel?.sellable ?? null;
      return { id: p.id, sku: p.sku, name: p.name, isTester: p.isTester, stock };
    }),
  };
}
