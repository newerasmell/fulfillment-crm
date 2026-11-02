import type { CrmOrderStatus, Prisma } from "@/generated/prisma/client";
import type { ShopifyClient } from "@/integrations/shopify/client";
import {
  ORDER_BY_ID_QUERY,
  OrderById,
  ORDERS_PAGE_QUERY,
  OrdersPage,
  type ShopifyOrder,
} from "@/integrations/shopify/orders";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { logger } from "@/lib/logger";
import { jsonEqual } from "@/lib/json-equal";
import { matchBySku } from "./products";

/**
 * Shopify → CRM order import. Idempotent: the same Shopify version imported twice changes nothing, and an
 * older version (out-of-order webhook, slow reconcile page) never overwrites a newer one.
 * Before an order is approved, Shopify is the source of truth for lines and address; after approval the CRM
 * is, and Shopify-side changes become operator tasks instead of silent edits.
 */

/** Statuses in which the order is still only "known", not acted on: Shopify changes apply directly. */
const PRE_APPROVAL = new Set<CrmOrderStatus>([
  "IMPORTED",
  "CHECKING",
  "NEEDS_REVIEW",
  "READY",
  "ON_HOLD",
  "BLOCKED",
]);

type Address = NonNullable<ShopifyOrder["shippingAddress"]>;

/** Light normalisation only (phase 1): trims, ISO country, collapsed spaces. Full rules come with P3-04/P4. */
export function normaliseAddress(a: Address | null | undefined) {
  if (!a) return null;
  const t = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim() || null;
  return {
    name: t(a.name) ?? t([a.firstName, a.lastName].filter(Boolean).join(" ")),
    company: t(a.company),
    address1: t(a.address1),
    address2: t(a.address2),
    city: t(a.city),
    province: t(a.province),
    provinceCode: t(a.provinceCode),
    zip: t(a.zip),
    country: t(a.country),
    countryCode: t(a.countryCodeV2)?.toUpperCase() ?? null,
    phone: t(a.phone),
  };
}

export function isCod(gateways: string[], codGateways: string[]) {
  const cod = new Set(codGateways.map((g) => g.trim().toLowerCase()));
  return gateways.some((g) => cod.has(g.trim().toLowerCase()));
}

const money = (m: { shopMoney: { amount: string } } | null | undefined) => m?.shopMoney.amount ?? "0";
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

export type StoreForImport = {
  id: string;
  companyId: string | null;
  codGateways: string[];
  skuPrefix: string | null;
};

export interface ImportResult {
  orderId: string;
  outcome: "created" | "updated" | "stale";
}

export async function importShopifyOrder(
  accountId: string,
  store: StoreForImport,
  o: ShopifyOrder,
): Promise<ImportResult> {
  const updatedAt = new Date(o.updatedAt);
  return withAccountTransaction(accountId, async (tx) => {
    const existing = await tx.order.findUnique({
      where: { accountId_storeId_shopifyOrderGid: { accountId, storeId: store.id, shopifyOrderGid: o.id } },
      select: {
        id: true,
        status: true,
        shopifyUpdatedAt: true,
        shippingAddress: true,
        shippingAddressOriginal: true,
      },
    });
    if (existing?.shopifyUpdatedAt && existing.shopifyUpdatedAt >= updatedAt) {
      return { orderId: existing.id, outcome: "stale" as const };
    }

    const cod = isCod(o.paymentGatewayNames, store.codGateways);
    const shipping = normaliseAddress(o.shippingAddress);
    const customerName =
      shipping?.name ?? ([o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(" ") || null);
    const tags = o.test ? [...o.tags, "shopify-test"] : o.tags;
    const preApproval = !existing || PRE_APPROVAL.has(existing.status);
    // Keep an operator's corrected address: only refresh the normalised copy if nobody edited it.
    const addressUntouched =
      !existing ||
      jsonEqual(
        existing.shippingAddress,
        normaliseAddress(existing.shippingAddressOriginal as Address | null),
      );

    const common = {
      companyId: store.companyId,
      number: o.name,
      customerName,
      email: o.email ?? o.customer?.defaultEmailAddress?.emailAddress ?? null,
      phone: o.phone ?? o.shippingAddress?.phone ?? o.customer?.defaultPhoneNumber?.phoneNumber ?? null,
      shippingAddressOriginal: json(o.shippingAddress),
      ...(addressUntouched && preApproval ? { shippingAddress: json(shipping) } : {}),
      billingAddress: json(normaliseAddress(o.billingAddress)),
      countryCode: shipping?.countryCode ?? null,
      currency: o.currencyCode,
      subtotal: money(o.subtotalPriceSet),
      total: money(o.totalPriceSet),
      paymentMethod: cod ? ("COD" as const) : ("PREPAID" as const),
      codAmount: cod
        ? Number(money(o.totalOutstandingSet)) > 0
          ? money(o.totalOutstandingSet)
          : money(o.totalPriceSet)
        : null,
      tags,
      note: o.note ?? null,
      risk: json(
        o.risk
          ? { recommendation: o.risk.recommendation, levels: o.risk.assessments.map((a) => a.riskLevel) }
          : null,
      ),
      placedAt: new Date(o.processedAt),
      cancelledAt: o.cancelledAt ? new Date(o.cancelledAt) : null,
      shopifyFinancialStatus: o.displayFinancialStatus ?? null,
      shopifyFulfillmentStatus: o.displayFulfillmentStatus,
      shopifyUpdatedAt: updatedAt,
      raw: json(o),
    };

    let orderId: string;
    let outcome: ImportResult["outcome"];
    if (!existing) {
      const created = await tx.order.create({
        data: {
          accountId,
          source: "SHOPIFY",
          storeId: store.id,
          shopifyOrderGid: o.id,
          status: o.cancelledAt ? "CANCELLED" : "IMPORTED",
          ...common,
        },
      });
      orderId = created.id;
      outcome = "created";
    } else {
      let status: CrmOrderStatus | undefined;
      if (o.cancelledAt && existing.status !== "CANCELLED") {
        if (PRE_APPROVAL.has(existing.status)) status = "CANCELLED";
        else
          await openTask(
            tx,
            accountId,
            existing.id,
            "shopify_cancelled_after_approval",
            `Order ${o.name} was cancelled in Shopify after approval — check the warehouse`,
          );
      }
      await tx.order.update({
        where: { id: existing.id },
        data: { ...common, ...(status ? { status } : {}) },
      });
      orderId = existing.id;
      outcome = "updated";
      if (!preApproval) {
        await openTask(
          tx,
          accountId,
          existing.id,
          "shopify_changed_after_approval",
          `Order ${o.name} changed in Shopify after approval — compare before shipping`,
        );
      }
    }

    if (preApproval) await replaceLines(tx, accountId, store, orderId, o);
    return { orderId, outcome };
  });
}

async function replaceLines(
  tx: Prisma.TransactionClient,
  accountId: string,
  store: StoreForImport,
  orderId: string,
  o: ShopifyOrder,
) {
  const storeId = store.id;
  const variantGids = o.lineItems.nodes.map((l) => l.variant?.id).filter((v): v is string => !!v);
  const links = await tx.storeVariantLink.findMany({
    where: { storeId, shopifyVariantGid: { in: variantGids } },
    select: { id: true, shopifyVariantGid: true, productId: true },
  });
  const linkByGid = new Map(links.map((l) => [l.shopifyVariantGid, l]));
  // Variants not seen yet (order arrived before the product sync) get a stub link now, so the product sync or
  // the matching queue can attach these lines to a master product later.
  for (const l of o.lineItems.nodes) {
    if (!l.variant || !l.product || linkByGid.has(l.variant.id)) continue;
    const stub = await tx.storeVariantLink.upsert({
      where: { storeId_shopifyVariantGid: { storeId, shopifyVariantGid: l.variant.id } },
      create: {
        accountId,
        storeId,
        shopifyVariantGid: l.variant.id,
        shopifyProductGid: l.product.id,
        sku: l.sku?.trim() || null,
        title: l.name,
        ...((await matchBySku(tx, l.sku, store.skuPrefix)) ?? {}),
      },
      update: {},
      select: { id: true, shopifyVariantGid: true, productId: true },
    });
    linkByGid.set(stub.shopifyVariantGid, stub);
  }
  const keep = o.lineItems.nodes.filter((l) => l.currentQuantity > 0);
  await tx.orderLine.deleteMany({ where: { orderId, shopifyLineGid: { notIn: keep.map((l) => l.id) } } });
  for (const l of keep) {
    const link = l.variant ? linkByGid.get(l.variant.id) : undefined;
    const data = {
      variantLinkId: link?.id ?? null,
      productId: link?.productId ?? null,
      sku: l.sku ?? null,
      title: l.name,
      quantity: l.currentQuantity,
      unitPrice: money(l.discountedUnitPriceAfterAllDiscountsSet),
    };
    await tx.orderLine.upsert({
      where: { orderId_shopifyLineGid: { orderId, shopifyLineGid: l.id } },
      create: { accountId, orderId, shopifyLineGid: l.id, ...data },
      update: data,
    });
  }
}

async function openTask(
  tx: Prisma.TransactionClient,
  accountId: string,
  orderId: string,
  kind: string,
  title: string,
) {
  const open = await tx.alert.findFirst({
    where: { entityType: "Order", entityId: orderId, kind, status: { not: "RESOLVED" } },
  });
  if (open) return;
  await tx.alert.create({
    data: {
      accountId,
      kind,
      isTask: true,
      severity: "WARNING",
      title,
      entityType: "Order",
      entityId: orderId,
    },
  });
}

export type SyncMode = { kind: "reconcile" } | { kind: "backfill"; days: number };

/**
 * Pulls orders page by page. Reconcile: everything updated since the stored cursor (minus a one-minute
 * overlap; re-imports are no-ops). Backfill: everything created in the last N days.
 */
export async function syncStoreOrders(
  accountId: string,
  store: StoreForImport & { syncCursors: unknown; createdAt: Date },
  client: ShopifyClient,
  mode: SyncMode,
  now = new Date(),
) {
  const cursors = (store.syncCursors ?? {}) as { ordersUpdatedAt?: string };
  const since =
    mode.kind === "backfill"
      ? `created_at:>='${new Date(now.getTime() - mode.days * 86_400_000).toISOString()}'`
      : `updated_at:>='${new Date(new Date(cursors.ordersUpdatedAt ?? new Date(store.createdAt.getTime() - 86_400_000)).getTime() - 60_000).toISOString()}'`;
  let after: string | null = null;
  let maxUpdated = cursors.ordersUpdatedAt ? new Date(cursors.ordersUpdatedAt) : null;
  const counts = { created: 0, updated: 0, stale: 0 };
  for (let page = 0; page < 1000; page++) {
    const res: {
      orders: { nodes: ShopifyOrder[]; pageInfo: { hasNextPage: boolean; endCursor?: string | null } };
    } = await client.query(ORDERS_PAGE_QUERY, { first: 50, after, query: since }, OrdersPage);
    for (const o of res.orders.nodes) {
      counts[(await importShopifyOrder(accountId, store, o)).outcome]++;
      const u = new Date(o.updatedAt);
      if (!maxUpdated || u > maxUpdated) maxUpdated = u;
    }
    if (mode.kind === "reconcile" && maxUpdated) {
      await accountDb(accountId).store.update({
        where: { id: store.id },
        data: { syncCursors: { ...(cursors as object), ordersUpdatedAt: maxUpdated.toISOString() } },
      });
    }
    if (!res.orders.pageInfo.hasNextPage) break;
    after = res.orders.pageInfo.endCursor ?? null;
  }
  logger.info({ storeId: store.id, mode: mode.kind, ...counts }, "shopify orders synced");
  return counts;
}

/** Webhook follow-up: re-reads the order from Shopify (never trusts the webhook body) and imports it. */
export async function refreshShopifyOrder(
  accountId: string,
  store: StoreForImport,
  client: ShopifyClient,
  orderGid: string,
) {
  const { order } = await client.query(ORDER_BY_ID_QUERY, { id: orderGid }, OrderById);
  return order ? importShopifyOrder(accountId, store, order) : null;
}
