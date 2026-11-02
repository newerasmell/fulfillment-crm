import type { CrmOrderStatus, Prisma } from "@/generated/prisma/client";
import type { ShopifyClient } from "@/integrations/shopify/client";
import type { z } from "zod";
import {
  ORDER_BY_ID_QUERY,
  ORDER_LINES_QUERY,
  OrderById,
  OrderLines,
  ORDERS_PAGE_QUERY,
  ORDERS_PAGE_SIZE,
  OrdersPage,
  type ShopifyOrder,
} from "@/integrations/shopify/orders";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { logger } from "@/lib/logger";
import { jsonEqual } from "@/lib/json-equal";
import { matchBySku } from "./products";
import { PRE_APPROVAL } from "./statuses";

/**
 * Shopify → CRM order import. Idempotent: the same Shopify version imported twice changes nothing, and an
 * older version (out-of-order webhook, slow reconcile page) never overwrites a newer one.
 * Before an order is approved, Shopify is the source of truth for lines and address; after approval the CRM
 * is, and Shopify-side changes become operator tasks instead of silent edits.
 */

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

/** What, if it changes in Shopify after approval, an operator must look at (not status or our own write-backs). */
function meaningful(o: ShopifyOrder) {
  return {
    lines: o.lineItems.nodes
      .filter((l) => l.currentQuantity > 0)
      .map((l) => [l.id, l.variant?.id ?? null, l.currentQuantity])
      .sort(),
    address: normaliseAddress(o.shippingAddress),
    total: money(o.totalPriceSet),
    outstanding: money(o.totalOutstandingSet),
    gateways: [...o.paymentGatewayNames].sort(),
    email: o.email ?? null,
    phone: o.phone ?? null,
    cancelled: !!o.cancelledAt,
  };
}

export async function importShopifyOrder(
  accountId: string,
  store: StoreForImport,
  o: ShopifyOrder,
): Promise<ImportResult> {
  const updatedAt = new Date(o.updatedAt);
  return withAccountTransaction(
    accountId,
    async (tx, { lockKey }) => {
      // Webhook and reconcile workers may import the same order at the same moment: serialise them, so the
      // "older never overwrites newer" check and the create-or-update decision see each other's result.
      await lockKey(`shopify-order:${store.id}:${o.id}`);
      const existing = await tx.order.findUnique({
        where: { accountId_storeId_shopifyOrderGid: { accountId, storeId: store.id, shopifyOrderGid: o.id } },
        select: {
          id: true,
          status: true,
          shopifyUpdatedAt: true,
          shippingAddress: true,
          shippingAddressOriginal: true,
          raw: true,
        },
      });
      if (existing?.shopifyUpdatedAt && existing.shopifyUpdatedAt >= updatedAt) {
        return { orderId: existing.id, outcome: "stale" as const };
      }

      const shopifyState = {
        cancelledAt: o.cancelledAt ? new Date(o.cancelledAt) : null,
        shopifyFinancialStatus: o.displayFinancialStatus ?? null,
        shopifyFulfillmentStatus: o.displayFulfillmentStatus,
        shopifyUpdatedAt: updatedAt,
        raw: json(o),
      };

      // After approval the CRM is the source of truth: amounts, COD and recipient were already decided (and
      // possibly sent to the warehouse). Only Shopify's own status fields follow; real changes become a task.
      if (existing && !PRE_APPROVAL.has(existing.status)) {
        await tx.order.update({ where: { id: existing.id }, data: shopifyState });
        const before = existing.raw ? meaningful(existing.raw as unknown as ShopifyOrder) : null;
        if (o.cancelledAt && existing.status !== "CANCELLED" && !before?.cancelled) {
          await openTask(
            tx,
            accountId,
            existing.id,
            "shopify_cancelled_after_approval",
            `Order ${o.name} was cancelled in Shopify after approval — check the warehouse`,
          );
        }
        const now = meaningful(o);
        if (before && !jsonEqual({ ...before, cancelled: false }, { ...now, cancelled: false })) {
          await openTask(
            tx,
            accountId,
            existing.id,
            "shopify_changed_after_approval",
            `Order ${o.name} changed in Shopify after approval — compare before shipping`,
          );
        }
        return { orderId: existing.id, outcome: "updated" as const };
      }

      // COD only when a COD gateway was used AND money is still owed; a COD gateway with nothing outstanding
      // (paid otherwise, or marked paid) must never be collected at the door.
      const codGateway = isCod(o.paymentGatewayNames, store.codGateways);
      const outstanding = Number(money(o.totalOutstandingSet));
      const cod = codGateway && outstanding > 0;
      const shipping = normaliseAddress(o.shippingAddress);
      const customerName =
        shipping?.name ?? ([o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(" ") || null);
      const tags = o.test ? [...o.tags, "shopify-test"] : o.tags;
      // Keep an operator's corrected address: only refresh the normalised copy if nobody edited it.
      const addressUntouched =
        !existing ||
        jsonEqual(
          existing.shippingAddress,
          normaliseAddress(existing.shippingAddressOriginal as Address | null),
        );

      const data = {
        ...shopifyState,
        companyId: store.companyId,
        number: o.name,
        customerName,
        email: o.email ?? o.customer?.defaultEmailAddress?.emailAddress ?? null,
        phone: o.phone ?? o.shippingAddress?.phone ?? o.customer?.defaultPhoneNumber?.phoneNumber ?? null,
        shippingAddressOriginal: json(o.shippingAddress),
        ...(addressUntouched ? { shippingAddress: json(shipping) } : {}),
        billingAddress: json(normaliseAddress(o.billingAddress)),
        countryCode: shipping?.countryCode ?? null,
        currency: o.currencyCode,
        subtotal: money(o.subtotalPriceSet),
        total: money(o.totalPriceSet),
        paymentMethod: cod ? ("COD" as const) : ("PREPAID" as const),
        codAmount: cod ? money(o.totalOutstandingSet) : null,
        tags,
        note: o.note ?? null,
        risk: json(
          o.risk
            ? { recommendation: o.risk.recommendation, levels: o.risk.assessments.map((a) => a.riskLevel) }
            : null,
        ),
        placedAt: new Date(o.processedAt),
      };

      let orderId: string;
      let outcome: ImportResult["outcome"];
      if (!existing) {
        // Shopify test orders are held: they must never reach a warehouse by accident.
        const status: CrmOrderStatus = o.cancelledAt ? "CANCELLED" : o.test ? "ON_HOLD" : "IMPORTED";
        const created = await tx.order.create({
          data: { accountId, source: "SHOPIFY", storeId: store.id, shopifyOrderGid: o.id, status, ...data },
        });
        orderId = created.id;
        outcome = "created";
      } else {
        await tx.order.update({
          where: { id: existing.id },
          data: {
            ...data,
            ...(o.cancelledAt && existing.status !== "CANCELLED" ? { status: "CANCELLED" as const } : {}),
          },
        });
        orderId = existing.id;
        outcome = "updated";
      }
      if (codGateway && !cod && !o.cancelledAt) {
        await openTask(
          tx,
          accountId,
          orderId,
          "cod_nothing_outstanding",
          `Order ${o.name} used a cash-on-delivery method but nothing is outstanding — imported as prepaid, check before shipping`,
        );
      }
      await replaceLines(tx, accountId, store, orderId, o);
      return { orderId, outcome };
    },
    IMPORT_TX,
  );
}

/** Waiting for another import of the same order plus many line upserts can exceed Prisma's 5 s default. */
const IMPORT_TX = { timeout: 30_000, maxWait: 15_000 };

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

/** Backfill runs in windows of created_at (one job each), so a long history never outlives a job. */
export type SyncMode = { kind: "reconcile" } | { kind: "backfill"; from: string; to: string };

/** Splits "the last N days" into week-long windows, newest first. */
export function backfillWindows(days: number, now = new Date(), windowDays = 7) {
  const out: { from: string; to: string }[] = [];
  const start = now.getTime() - days * 86_400_000;
  for (let to = now.getTime(); to > start; to -= windowDays * 86_400_000) {
    out.push({
      from: new Date(Math.max(start, to - windowDays * 86_400_000)).toISOString(),
      to: new Date(to).toISOString(),
    });
  }
  return out;
}

/** One bad order must not stop the store's sync: record it for a person and go on. */
async function importOrAlert(
  accountId: string,
  store: StoreForImport,
  client: ShopifyClient,
  o: ShopifyOrder,
) {
  try {
    return (await importShopifyOrder(accountId, store, await completeOrderLines(client, o))).outcome;
  } catch (err) {
    logger.error(
      { storeId: store.id, order: o.id, err: (err as Error).message },
      "shopify order import failed",
    );
    const db = accountDb(accountId);
    const open = await db.alert.findFirst({
      where: {
        kind: "shopify_import_failed",
        entityType: "ShopifyOrder",
        entityId: o.id,
        status: { not: "RESOLVED" },
      },
    });
    if (!open) {
      await db.alert.create({
        data: {
          accountId,
          kind: "shopify_import_failed",
          isTask: true,
          severity: "WARNING",
          title: `Shopify order ${o.name} could not be imported — it is retried on its next change`,
          entityType: "ShopifyOrder",
          entityId: o.id,
        },
      });
    }
    return "failed" as const;
  }
}

/** Shopify's search index lags behind writes: re-read this much before the cursor (re-imports are no-ops). */
const RECONCILE_OVERLAP_MS = 10 * 60_000;

/** Orders come with the first ORDER_LINES_FIRST lines; fetch the rest so an order is never imported half. */
export async function completeOrderLines(client: ShopifyClient, o: ShopifyOrder): Promise<ShopifyOrder> {
  let current = o;
  // If the order changes while we page its lines, the pages mix two versions: start over from the new one.
  for (let attempt = 0; attempt < 3; attempt++) {
    let pageInfo = current.lineItems.pageInfo;
    const nodes = [...current.lineItems.nodes];
    let changed = false;
    for (let page = 0; pageInfo?.hasNextPage && page < 200; page++) {
      const { order } = await client.query(
        ORDER_LINES_QUERY,
        { id: current.id, after: pageInfo.endCursor ?? null },
        OrderLines,
      );
      if (!order) throw new Error(`order ${current.id} disappeared while reading its lines`);
      if (order.updatedAt !== current.updatedAt) {
        changed = true;
        break;
      }
      nodes.push(...order.lineItems.nodes);
      pageInfo = order.lineItems.pageInfo;
    }
    if (!changed) {
      if (pageInfo?.hasNextPage) throw new Error(`order ${current.id}: more than 1000 line items`);
      return { ...current, lineItems: { nodes, pageInfo: null } };
    }
    const { order } = await client.query(ORDER_BY_ID_QUERY, { id: current.id }, OrderById);
    if (!order) throw new Error(`order ${current.id} disappeared while reading its lines`);
    current = order;
  }
  throw new Error(`order ${o.id} kept changing while reading its lines`);
}

/**
 * Pulls orders page by page. Reconcile: everything updated since the stored cursor (minus an overlap).
 * Backfill: everything created inside one window (see backfillWindows).
 */
export async function syncStoreOrders(
  accountId: string,
  store: StoreForImport & { syncCursors: unknown; createdAt: Date },
  client: ShopifyClient,
  mode: SyncMode,
) {
  const cursors = (store.syncCursors ?? {}) as { ordersUpdatedAt?: string };
  const cursorStart = new Date(cursors.ordersUpdatedAt ?? store.createdAt.getTime() - 86_400_000);
  const since =
    mode.kind === "backfill"
      ? `created_at:>='${mode.from}' AND created_at:<'${mode.to}'`
      : `updated_at:>='${new Date(cursorStart.getTime() - RECONCILE_OVERLAP_MS).toISOString()}'`;
  let after: string | null = null;
  let maxUpdated = cursors.ordersUpdatedAt ? new Date(cursors.ordersUpdatedAt) : null;
  const counts = { created: 0, updated: 0, stale: 0, failed: 0 };
  for (let page = 0; page < 100_000; page++) {
    const res: z.infer<typeof OrdersPage> = await client.query(
      ORDERS_PAGE_QUERY,
      { first: ORDERS_PAGE_SIZE, after, query: since },
      OrdersPage,
    );
    for (const o of res.orders.nodes) {
      counts[await importOrAlert(accountId, store, client, o)]++;
      const u = new Date(o.updatedAt);
      if (!maxUpdated || u > maxUpdated) maxUpdated = u;
    }
    if (mode.kind === "reconcile" && maxUpdated) {
      // Read-modify-write of the JSON is safe: one sync job per store at a time (stately queue).
      const fresh = await accountDb(accountId).store.findUniqueOrThrow({
        where: { id: store.id },
        select: { syncCursors: true },
      });
      await accountDb(accountId).store.update({
        where: { id: store.id },
        data: {
          syncCursors: {
            ...((fresh.syncCursors ?? {}) as object),
            ordersUpdatedAt: maxUpdated.toISOString(),
          },
        },
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
  return order ? importShopifyOrder(accountId, store, await completeOrderLines(client, order)) : null;
}
