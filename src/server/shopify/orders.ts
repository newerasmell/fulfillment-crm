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
import {
  FINGERPRINT_SELECT,
  currentOrderFingerprint,
  orderFingerprint,
  recordInitialStatus,
  transition,
} from "@/server/pipeline";
import { matchBySku } from "./products";
import { checkStockGuard } from "@/server/stock/guard-check";
import { syncStockWait } from "@/server/stock/waiting";
import { hasStoreTag } from "./order-tag-match";
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

/** Paid in full: nothing outstanding on an order that costs something (a free order proves nothing). Pure. */
export function paidInFull(outstanding: number, total: number) {
  return Number.isFinite(outstanding) && Number.isFinite(total) && total > 0 && outstanding <= 0;
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

/** The phone the import stores as Order.phone (order, then shipping address, then customer). */
export function shopifyPhone(o: ShopifyOrder | null | undefined): string | null {
  if (!o) return null;
  return o.phone ?? o.shippingAddress?.phone ?? o.customer?.defaultPhoneNumber?.phoneNumber ?? null;
}

/** Shopify says every item is fulfilled (by someone else: before approval nothing was sent from the CRM). */
const shopifyFulfilled = (o: ShopifyOrder) => o.displayFulfillmentStatus === "FULFILLED";

export async function importShopifyOrder(
  accountId: string,
  store: StoreForImport,
  o: ShopifyOrder,
): Promise<ImportResult> {
  const updatedAt = new Date(o.updatedAt);
  return withAccountTransaction(
    accountId,
    async (tx, { lockKey, lockKeyShared }) => {
      // A store edit / delete (store-lifecycle.ts) takes this key exclusively: it waits for imports in flight and
      // its "no orders yet" re-check sees them, so the code or domain never changes under a first import.
      await lockKeyShared(`store:${store.id}`);
      // Webhook and reconcile workers may import the same order at the same moment: serialise them, so the
      // "older never overwrites newer" check and the create-or-update decision see each other's result.
      await lockKey(`shopify-order:${store.id}:${o.id}`);
      const existing = await tx.order.findUnique({
        where: { accountId_storeId_shopifyOrderGid: { accountId, storeId: store.id, shopifyOrderGid: o.id } },
        select: {
          ...FINGERPRINT_SELECT,
          id: true,
          status: true,
          shopifyUpdatedAt: true,
          shippingAddress: true,
          shippingAddressOriginal: true,
          raw: true,
          codOverride: { select: { paymentMethod: true, codAmount: true } },
        },
      });
      if (existing?.shopifyUpdatedAt && existing.shopifyUpdatedAt >= updatedAt) {
        return { orderId: existing.id, outcome: "stale" as const };
      }
      // "Само поръчки с таг": without the store's tag an order is set aside (AWAITING_TAG) until it gets it.
      const gate = await tx.storeOrderTag.findUnique({
        where: { accountId_storeId: { accountId, storeId: store.id } },
        select: { tag: true },
      });
      const tagged = !gate || hasStoreTag(o.tags, gate.tag);

      const shopifyState = {
        cancelledAt: o.cancelledAt ? new Date(o.cancelledAt) : null,
        shopifyFinancialStatus: o.displayFinancialStatus ?? null,
        shopifyFulfillmentStatus: o.displayFulfillmentStatus,
        shopifyUpdatedAt: updatedAt,
        raw: json(o),
      };

      // Approved (or refused by the warehouse) and the store's tag is gone: set aside again, and its data follows
      // Shopify like any order before approval (it is checked from the start once it has the tag again).
      let setAside = false;
      if (
        existing &&
        !tagged &&
        !o.cancelledAt &&
        !PRE_APPROVAL.has(existing.status) &&
        existing.status !== "FULFILLED_EXTERNALLY" &&
        existing.status !== "CANCELLED"
      ) {
        const moved = await transition(tx, {
          orderId: existing.id,
          to: "AWAITING_TAG",
          cause: "tag_missing",
          actor: { kind: "system" },
          source: "shopify.import",
          reason: gate!.tag,
        });
        setAside = moved.changed;
      }

      // After approval the CRM is the source of truth: amounts, COD and recipient were already decided (and
      // possibly sent to the warehouse). Only Shopify's own status fields follow; real changes become a task.
      if (existing && !PRE_APPROVAL.has(existing.status) && !setAside) {
        await tx.order.update({ where: { id: existing.id }, data: shopifyState });
        // Shipped outside the CRM / already closed here: Shopify's later changes (refunds…) need no task.
        if (existing.status === "FULFILLED_EXTERNALLY" || existing.status === "CANCELLED") {
          return { orderId: existing.id, outcome: "updated" as const };
        }
        // Already with a warehouse and the store's tag was removed in Shopify: nothing is stopped, a person checks.
        if (
          !tagged &&
          !o.cancelledAt &&
          hasStoreTag((existing.raw as { tags?: string[] } | null)?.tags, gate!.tag)
        )
          await openTask(
            tx,
            accountId,
            existing.id,
            "shopify_tag_removed_after_send",
            `Order ${o.name} lost the tag "${gate!.tag}" in Shopify after it was sent to the warehouse — check it`,
          );
        const before = existing.raw ? meaningful(existing.raw as unknown as ShopifyOrder) : null;
        if (o.cancelledAt && !before?.cancelled) {
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
      // Fully paid (card, PayPal…: nothing outstanding on a non-free order): never held by the anti-sabotage guard
      // (owner request 2026-11-10) — a fake order does not pay.
      const paidUp = paidInFull(outstanding, Number(money(o.totalPriceSet)));
      const shipping = normaliseAddress(o.shippingAddress);
      const customerName =
        shipping?.name ?? ([o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(" ") || null);
      const tags = o.test ? [...o.tags, "shopify-test"] : o.tags;
      // Keep an operator's correction: only refresh the normalised copy if nobody edited it. "Untouched"
      // covers the contact fields too — a phone-only fix can leave shippingAddress byte-identical (e.g. the
      // order phone set to the value the address phone already had).
      const previousOriginal = existing
        ? normaliseAddress(existing.shippingAddressOriginal as Address | null)
        : null;
      const addressUntouched =
        !existing ||
        (jsonEqual(existing.shippingAddress, previousOriginal) &&
          existing.phone === shopifyPhone(existing.raw as ShopifyOrder | null) &&
          existing.countryCode === (previousOriginal?.countryCode ?? null));

      const data = {
        ...shopifyState,
        companyId: store.companyId,
        number: o.name,
        customerName,
        email: o.email ?? o.customer?.defaultEmailAddress?.emailAddress ?? null,
        shippingAddressOriginal: json(o.shippingAddress),
        // An operator's correction (address, phone, country — src/server/review) is kept; the original is
        // always refreshed above.
        ...(addressUntouched
          ? {
              shippingAddress: json(shipping),
              phone: shopifyPhone(o),
              countryCode: shipping?.countryCode ?? null,
            }
          : {}),
        billingAddress: json(normaliseAddress(o.billingAddress)),
        currency: o.currencyCode,
        subtotal: money(o.subtotalPriceSet),
        total: money(o.totalPriceSet),
        // A person's manual COD (OrderCodOverride) is kept over Shopify's payment facts.
        ...(existing?.codOverride
          ? {
              paymentMethod: existing.codOverride.paymentMethod,
              codAmount: existing.codOverride.codAmount,
            }
          : {
              paymentMethod: cod ? ("COD" as const) : ("PREPAID" as const),
              codAmount: cod ? money(o.totalOutstandingSet) : null,
            }),
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
        // Already fulfilled in Shopify when we first see it (history, or shipped by hand): nothing to review.
        // Противосаботаж: more units than the store's product line allows → held, reserves nothing (other stores
        // keep selling) until a person approves or cancels it.
        const guard =
          store.companyId && !paidUp
            ? await tx.lineStockGuard.findFirst({
                where: { accountId, line: { companies: { some: { id: store.companyId } } } },
                select: { enabled: true, maxPerProduct: true, maxPerOrder: true },
              })
            : null;
        // Counted per master product (two variants of one product count together), else per Shopify variant.
        const variantIds = o.lineItems.nodes.map((l) => l.variant?.id).filter((v): v is string => !!v);
        const masters = guard?.enabled
          ? new Map(
              (
                await tx.storeVariantLink.findMany({
                  where: { storeId: store.id, shopifyVariantGid: { in: variantIds } },
                  select: { shopifyVariantGid: true, productId: true },
                })
              ).map((v) => [v.shopifyVariantGid, v.productId]),
            )
          : new Map<string, string | null>();
        const verdict = checkStockGuard(
          guard,
          o.lineItems.nodes.map((l) => ({
            key: (l.variant?.id && masters.get(l.variant.id)) || l.variant?.id || l.id,
            quantity: l.currentQuantity,
          })),
        );
        const status: CrmOrderStatus = o.cancelledAt
          ? "CANCELLED"
          : shopifyFulfilled(o)
            ? "FULFILLED_EXTERNALLY"
            : o.test
              ? "ON_HOLD"
              : verdict.hold
                ? "QTY_HOLD"
                : tagged
                  ? "IMPORTED"
                  : "AWAITING_TAG";
        const created = await tx.order.create({
          data: { accountId, source: "SHOPIFY", storeId: store.id, shopifyOrderGid: o.id, status, ...data },
        });
        await recordInitialStatus(tx, {
          accountId,
          orderId: created.id,
          status,
          actor: { kind: "system" },
          source: "shopify.import",
        });
        orderId = created.id;
        outcome = "created";
        if (status === "QTY_HOLD")
          await openTask(
            tx,
            accountId,
            created.id,
            "order_qty_hold",
            `Order ${o.name}: ${verdict.totalQty} units (${verdict.maxProductQty} of one product) — above the anti-sabotage limit, held: approve or cancel`,
          );
      } else {
        await tx.order.update({ where: { id: existing.id }, data });
        // Still before approval here (PRE_APPROVAL): Shopify's cancel / fulfil applies directly.
        if (o.cancelledAt || shopifyFulfilled(o)) {
          await transition(tx, {
            orderId: existing.id,
            ...(o.cancelledAt
              ? { to: "CANCELLED" as const, cause: "shopify_cancelled" as const }
              : { to: "FULFILLED_EXTERNALLY" as const, cause: "shopify_fulfilled" as const }),
            actor: { kind: "system" },
            source: "shopify.import",
          });
        }
        // Held for its quantity and now paid in full: released like a person's approval (it starts over).
        if (existing.status === "QTY_HOLD" && paidUp && !o.cancelledAt && !shopifyFulfilled(o)) {
          await transition(tx, {
            orderId: existing.id,
            to: tagged ? "IMPORTED" : "AWAITING_TAG",
            cause: "qty_release",
            actor: { kind: "system" },
            source: "shopify.import",
            reason: "paid in full",
            mode: "follow",
          });
        }
        orderId = existing.id;
        outcome = "updated";
      }
      // (Not while it waits for the store's tag: it is not work yet; the next import after tagging opens it.)
      if (codGateway && !cod && !o.cancelledAt && tagged) {
        await openTask(
          tx,
          accountId,
          orderId,
          "cod_nothing_outstanding",
          `Order ${o.name} used a cash-on-delivery method but nothing is outstanding — imported as prepaid, check before shipping`,
        );
      }
      await replaceLines(tx, accountId, store, orderId, o);
      // The data a check validated changed (address, phone, COD, lines…): a check or review of the old data
      // must not authorise it. The order starts over at IMPORTED and the check sweep validates it again
      // (the approve guard also compares the check's fingerprint, for a check still running right now).
      if (existing && !o.cancelledAt && !shopifyFulfilled(o)) {
        const after = await currentOrderFingerprint(tx, orderId);
        if (after !== orderFingerprint(existing)) {
          await transition(tx, {
            orderId,
            to: "IMPORTED",
            cause: "data_changed",
            actor: { kind: "system" },
            source: "shopify.import",
            mode: "follow",
          });
        }
        // The tag appeared → into review from the start; it is gone (or newly required) → set aside again.
        await transition(tx, {
          orderId,
          ...(tagged
            ? { to: "IMPORTED" as const, cause: "tag_added" as const }
            : { to: "AWAITING_TAG" as const, cause: "tag_missing" as const }),
          actor: { kind: "system" },
          source: "shopify.import",
          ...(gate ? { reason: gate.tag } : {}),
          mode: "follow",
        });
      }
      // "Липсващи артикули": an out_of_stock / waiting_for_stock tag starts (or a removed one ends) following it.
      await syncStockWait(tx, accountId, orderId);
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
  // A product a person chose by hand for a line (OrderLineProductChoice) survives every re-import.
  const chosen = new Map(
    (
      await tx.orderLine.findMany({
        where: { orderId, productChoice: { isNot: null } },
        select: { shopifyLineGid: true, productChoice: { select: { productId: true } } },
      })
    ).map((l) => [l.shopifyLineGid, l.productChoice!.productId]),
  );
  for (const l of keep) {
    const link = l.variant ? linkByGid.get(l.variant.id) : undefined;
    const data = {
      variantLinkId: link?.id ?? null,
      productId: chosen.get(l.id) ?? link?.productId ?? null,
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
  // When the last run finished, whatever it found (the page shows it as "last sync").
  const fresh = await accountDb(accountId).store.findUniqueOrThrow({
    where: { id: store.id },
    select: { syncCursors: true },
  });
  const key = mode.kind === "reconcile" ? "ordersSyncedAt" : "ordersBackfilledAt";
  await accountDb(accountId).store.update({
    where: { id: store.id },
    data: { syncCursors: { ...((fresh.syncCursors ?? {}) as object), [key]: new Date().toISOString() } },
  });
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
