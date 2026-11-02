import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ShopifyClient } from "@/integrations/shopify/client";
import type { ShopifyOrder } from "@/integrations/shopify/orders";
import type { ShopifyVariant } from "@/integrations/shopify/products";
import { TokenProvider } from "@/integrations/shopify/token";
import { verifyWebhookHmac, webhookTarget } from "@/integrations/shopify/webhooks";
import { bootstrapOwner } from "@/server/auth/users";
import { accountDb, systemDb } from "@/server/db/client";
import { createStore, type ScopedActor } from "@/server/stores";
import { importShopifyOrder, isCod, syncStoreOrders } from "./orders";
import { createProductFromVariant, linkVariant, stripSkuPrefix, upsertVariant } from "./products";
import { testStoreConnection } from "./connection";
import { processShopifyWebhook, receiveShopifyWebhook, registerStoreWebhooks } from "./webhooks";

// Synthetic data only (CLAUDE.md: no real business data in the repo).
const SECRET = "test-client-secret-0001";
const DOMAIN = "demo-test.myshopify.com";

const money = (amount: string) => ({ shopMoney: { amount, currencyCode: "EUR" } });
function order(over: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    id: "gid://shopify/Order/1001",
    name: "#1001",
    createdAt: "2026-11-01T10:00:00Z",
    processedAt: "2026-11-01T10:00:00Z",
    updatedAt: "2026-11-01T10:00:00Z",
    cancelledAt: null,
    email: "buyer@example.com",
    phone: null,
    note: null,
    tags: [],
    test: false,
    currencyCode: "EUR",
    displayFinancialStatus: "PENDING",
    displayFulfillmentStatus: "UNFULFILLED",
    paymentGatewayNames: ["Cash on Delivery (COD)"],
    subtotalPriceSet: money("40.00"),
    totalPriceSet: money("45.00"),
    totalOutstandingSet: money("45.00"),
    customer: null,
    shippingAddress: {
      name: "  Test   Buyer ",
      address1: "1 Example Street",
      city: "Sofia",
      zip: "1000",
      country: "Bulgaria",
      countryCodeV2: "bg",
      phone: "+359000000000",
    },
    billingAddress: null,
    risk: { recommendation: "ACCEPT", assessments: [] },
    lineItems: {
      nodes: [
        {
          id: "gid://shopify/LineItem/1",
          name: "Sample Perfume 50ml",
          sku: "XX-SAMPLE-1",
          quantity: 2,
          currentQuantity: 2,
          variant: { id: "gid://shopify/ProductVariant/11" },
          product: { id: "gid://shopify/Product/10" },
          discountedUnitPriceAfterAllDiscountsSet: money("20.00"),
        },
      ],
    },
    ...over,
  };
}
const variant = (over: Partial<ShopifyVariant> = {}): ShopifyVariant => ({
  id: "gid://shopify/ProductVariant/11",
  sku: "XX-SAMPLE-1",
  title: "50ml",
  displayName: "Sample Perfume - 50ml",
  updatedAt: "2026-11-01T10:00:00Z",
  barcodes: { nodes: [{ value: "0000000000001" }] },
  product: { id: "gid://shopify/Product/10", title: "Sample Perfume", vendor: "Demo", status: "ACTIVE" },
  ...over,
});

/** Fake Shopify: token endpoint + GraphQL dispatched by operation name. */
function fakeShopify(routes: Record<string, (vars: Record<string, unknown>) => unknown>) {
  const ops: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/admin/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 86399 }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const op = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "?";
    ops.push(op);
    const handler = routes[op];
    if (!handler) throw new Error(`unexpected operation ${op}`);
    return new Response(JSON.stringify({ data: handler(body.variables) }), { status: 200 });
  });
  const opts = { fetchImpl, tokens: new TokenProvider(fetchImpl), sleep: async () => {} };
  return {
    fetchImpl,
    ops,
    opts,
    client: new ShopifyClient(DOMAIN, { clientId: "client-id-0001", clientSecret: SECRET }, opts),
  };
}

describe("pure helpers", () => {
  it("COD detection is case-insensitive and exact per gateway", () => {
    expect(isCod(["cash on delivery (cod)"], ["Cash on Delivery (COD)"])).toBe(true);
    expect(isCod(["shopify_payments"], ["Cash on Delivery (COD)"])).toBe(false);
  });
  it("strips the store SKU prefix only when it is a real prefix", () => {
    expect(stripSkuPrefix("XX-ABC", "XX-")).toBe("ABC");
    expect(stripSkuPrefix("xx-ABC", "XX-")).toBe("ABC");
    expect(stripSkuPrefix("XX-", "XX-")).toBe("XX-");
    expect(stripSkuPrefix("ABC", null)).toBe("ABC");
    expect(stripSkuPrefix("  ", "XX-")).toBeNull();
  });
  it("verifies the webhook HMAC over the raw body in constant time", () => {
    const body = '{"id":1}';
    const sig = createHmac("sha256", SECRET).update(body).digest("base64");
    expect(verifyWebhookHmac(body, sig, SECRET)).toBe(true);
    expect(verifyWebhookHmac(body + " ", sig, SECRET)).toBe(false);
    expect(verifyWebhookHmac(body, sig, "other")).toBe(false);
    expect(verifyWebhookHmac(body, null, SECRET)).toBe(false);
    expect(verifyWebhookHmac(body, "short", SECRET)).toBe(false);
  });
  it("turns webhook bodies into pointers to re-read", () => {
    expect(webhookTarget("orders/updated", { admin_graphql_api_id: "gid://shopify/Order/5" })).toEqual({
      kind: "order",
      gid: "gid://shopify/Order/5",
    });
    expect(webhookTarget("orders/edited", { order_edit: { order_id: 7 } })).toEqual({
      kind: "order",
      gid: "gid://shopify/Order/7",
    });
    expect(webhookTarget("refunds/create", { order_id: 8 })).toEqual({
      kind: "order",
      gid: "gid://shopify/Order/8",
    });
    expect(webhookTarget("products/update", { id: 9 })).toEqual({
      kind: "product",
      gid: "gid://shopify/Product/9",
    });
    expect(webhookTarget("app/uninstalled", {})).toEqual({ kind: "uninstalled" });
    expect(webhookTarget("orders/create", { admin_graphql_api_id: "https://evil" })).toEqual({
      kind: "ignore",
    });
    expect(webhookTarget("customers/create", {})).toEqual({ kind: "ignore" });
  });
});

describe("Shopify import (DB)", () => {
  let owner: ScopedActor;
  let storeId: string;
  let accountId: string;
  const store = async () => systemDb().store.findUniqueOrThrow({ where: { id: storeId } });

  beforeAll(async () => {
    const r = await bootstrapOwner({
      email: `shop-${Date.now()}@example.com`,
      name: "O",
      accountName: "Shopify test group",
      password: "correct horse battery staple",
    });
    accountId = r.account.id;
    owner = { userId: r.user.id, accountId, role: "OWNER", companyScope: null };
    const company = await systemDb().company.findFirstOrThrow({ where: { accountId } });
    const s = await createStore(owner, {
      companyId: company.id,
      name: "Demo store",
      domain: `https://${DOMAIN}/admin`,
      code: "dm",
      currency: "EUR",
      countries: ["bg"],
      clientId: "client-id-0001",
      clientSecret: SECRET,
    });
    storeId = s.id;
    expect(s.domain).toBe(DOMAIN);
    expect(s.code).toBe("DM");
    await accountDb(accountId).store.update({ where: { id: storeId }, data: { skuPrefix: "XX-" } });
  });

  it("connection test checks the shop domain and records the result", async () => {
    const ok = fakeShopify({
      Shop: () => ({ shop: { name: "Demo", myshopifyDomain: DOMAIN, currencyCode: "EUR" } }),
    });
    expect((await testStoreConnection(accountId, storeId, ok.opts)).ok).toBe(true);
    expect((await store()).shopName).toBe("Demo");
    const other = fakeShopify({
      Shop: () => ({ shop: { name: "X", myshopifyDomain: "other.myshopify.com", currencyCode: "EUR" } }),
    });
    expect(await testStoreConnection(accountId, storeId, other.opts)).toMatchObject({
      ok: false,
      error: "domain_mismatch",
    });
    await testStoreConnection(accountId, storeId, ok.opts);
  });

  it("creates an order once; re-imports and older versions change nothing", async () => {
    const s = await store();
    const first = await importShopifyOrder(accountId, s, order());
    expect(first.outcome).toBe("created");
    expect((await importShopifyOrder(accountId, s, order())).outcome).toBe("stale");
    expect(
      (await importShopifyOrder(accountId, s, order({ updatedAt: "2026-11-01T09:00:00Z" }))).outcome,
    ).toBe("stale");
    const o = await accountDb(accountId).order.findUniqueOrThrow({
      where: { id: first.orderId },
      include: { lines: true },
    });
    expect(o).toMatchObject({
      status: "IMPORTED",
      paymentMethod: "COD",
      countryCode: "BG",
      customerName: "Test Buyer",
      number: "#1001",
    });
    expect(Number(o.codAmount)).toBe(45);
    expect(o.lines).toHaveLength(1);
    // The unseen variant got a stub link so it can be matched later.
    expect(o.lines[0]!.variantLinkId).toBeTruthy();
    expect(o.lines[0]!.productId).toBeNull();
  });

  it("applies Shopify edits before approval: quantities, removed lines, cancellation", async () => {
    const s = await store();
    const edited = order({
      updatedAt: "2026-11-01T11:00:00Z",
      lineItems: {
        nodes: [
          { ...order().lineItems.nodes[0]!, currentQuantity: 0 },
          {
            id: "gid://shopify/LineItem/2",
            name: "Other 30ml",
            sku: "XX-OTHER",
            quantity: 1,
            currentQuantity: 1,
            variant: { id: "gid://shopify/ProductVariant/21" },
            product: { id: "gid://shopify/Product/20" },
            discountedUnitPriceAfterAllDiscountsSet: money("10.00"),
          },
        ],
      },
    });
    const r = await importShopifyOrder(accountId, s, edited);
    expect(r.outcome).toBe("updated");
    const lines = await accountDb(accountId).orderLine.findMany({ where: { orderId: r.orderId } });
    expect(lines.map((l) => [l.sku, l.quantity])).toEqual([["XX-OTHER", 1]]);
    await importShopifyOrder(accountId, s, {
      ...edited,
      updatedAt: "2026-11-01T12:00:00Z",
      cancelledAt: "2026-11-01T12:00:00Z",
    });
    expect((await accountDb(accountId).order.findUniqueOrThrow({ where: { id: r.orderId } })).status).toBe(
      "CANCELLED",
    );
  });

  it("refreshes an untouched address from Shopify but keeps an operator's correction", async () => {
    const s = await store();
    const o = order({ id: "gid://shopify/Order/5005", name: "#5005" });
    const { orderId } = await importShopifyOrder(accountId, s, o);
    const moved = { ...o.shippingAddress!, address1: "5 New Street" };
    await importShopifyOrder(accountId, s, {
      ...o,
      updatedAt: "2026-11-01T11:00:00Z",
      shippingAddress: moved,
    });
    const db = accountDb(accountId);
    expect(
      ((await db.order.findUniqueOrThrow({ where: { id: orderId } })).shippingAddress as { address1: string })
        .address1,
    ).toBe("5 New Street");
    await db.order.update({
      where: { id: orderId },
      data: { shippingAddress: { address1: "Corrected by operator" } },
    });
    await importShopifyOrder(accountId, s, {
      ...o,
      updatedAt: "2026-11-01T12:00:00Z",
      shippingAddress: { ...moved, address1: "6 Other Street" },
    });
    expect(
      ((await db.order.findUniqueOrThrow({ where: { id: orderId } })).shippingAddress as { address1: string })
        .address1,
    ).toBe("Corrected by operator");
  });

  it("after approval Shopify changes become operator tasks, not silent edits", async () => {
    const s = await store();
    const o = order({ id: "gid://shopify/Order/2002", name: "#2002" });
    const { orderId } = await importShopifyOrder(accountId, s, o);
    await accountDb(accountId).order.update({ where: { id: orderId }, data: { status: "APPROVED" } });
    await importShopifyOrder(accountId, s, {
      ...o,
      updatedAt: "2026-11-01T11:00:00Z",
      cancelledAt: "2026-11-01T11:00:00Z",
    });
    const after = await accountDb(accountId).order.findUniqueOrThrow({
      where: { id: orderId },
      include: { lines: true },
    });
    expect(after.status).toBe("APPROVED");
    const kinds = (await accountDb(accountId).alert.findMany({ where: { entityId: orderId } }))
      .map((a) => a.kind)
      .sort();
    expect(kinds).toEqual(["shopify_cancelled_after_approval", "shopify_changed_after_approval"]);
  });

  it("matches variants by SKU without the store prefix and attaches earlier order lines", async () => {
    const product = await accountDb(accountId).product.create({
      data: { accountId, sku: "SAMPLE-1", name: "Sample" },
    });
    const r = await upsertVariant(accountId, await store(), variant());
    expect(r.matched).toBe(true);
    const line = await accountDb(accountId).orderLine.findFirstOrThrow({
      where: { variantLinkId: r.linkId },
    });
    expect(line.productId).toBe(product.id);
    // A manual link is never overwritten by the automation.
    await accountDb(accountId).product.create({ data: { accountId, sku: "OTHER", name: "Other" } });
    await accountDb(accountId).storeVariantLink.update({
      where: { id: r.linkId },
      data: { productId: product.id, matchMethod: "manual" },
    });
    await upsertVariant(accountId, await store(), variant({ sku: "XX-OTHER" }));
    expect(
      (await accountDb(accountId).storeVariantLink.findUniqueOrThrow({ where: { id: r.linkId } })).productId,
    ).toBe(product.id);
  });

  it("matching queue: link by master SKU or create the master product from the variant", async () => {
    const a = await upsertVariant(
      accountId,
      await store(),
      variant({ id: "gid://shopify/ProductVariant/31", sku: "XX-NEW-1" }),
    );
    expect(a.matched).toBe(false);
    const created = await createProductFromVariant(owner, a.linkId);
    expect(created.sku).toBe("NEW-1");
    await expect(createProductFromVariant(owner, a.linkId)).rejects.toMatchObject({ code: "product_exists" });
    const b = await upsertVariant(
      accountId,
      await store(),
      variant({ id: "gid://shopify/ProductVariant/32", sku: "ZZ" }),
    );
    await expect(linkVariant(owner, b.linkId, "nope")).rejects.toMatchObject({ code: "product_not_found" });
    await linkVariant(owner, b.linkId, "new-1");
    expect(
      (await accountDb(accountId).storeVariantLink.findUniqueOrThrow({ where: { id: b.linkId } })).productId,
    ).toBe(created.id);
    await expect(linkVariant({ ...owner, role: "VIEWER" }, b.linkId, "NEW-1")).rejects.toThrow();
  });

  it("reconcile pages through orders and advances the cursor", async () => {
    const pages = [
      {
        nodes: [order({ id: "gid://shopify/Order/3001", name: "#3001", updatedAt: "2026-11-02T08:00:00Z" })],
        pageInfo: { hasNextPage: true, endCursor: "c1" },
      },
      {
        nodes: [order({ id: "gid://shopify/Order/3002", name: "#3002", updatedAt: "2026-11-02T09:00:00Z" })],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ];
    const queries: unknown[] = [];
    const fake = fakeShopify({
      OrdersPage: (vars) => {
        queries.push(vars);
        return { orders: pages.shift() };
      },
    });
    const counts = await syncStoreOrders(accountId, await store(), fake.client, { kind: "reconcile" });
    expect(counts.created).toBe(2);
    expect((queries[1] as { after: string }).after).toBe("c1");
    expect(((await store()).syncCursors as { ordersUpdatedAt: string }).ordersUpdatedAt).toBe(
      "2026-11-02T09:00:00.000Z",
    );
  });

  it("webhooks: only a valid signature is stored, once per webhook id; processing re-reads the order", async () => {
    const body = JSON.stringify({
      admin_graphql_api_id: "gid://shopify/Order/4001",
      note: "body is never trusted",
    });
    const headers = (sig: string, id = "wh-1") =>
      new Headers({
        "x-shopify-shop-domain": DOMAIN,
        "x-shopify-topic": "orders/create",
        "x-shopify-webhook-id": id,
        "x-shopify-hmac-sha256": sig,
      });
    const sig = createHmac("sha256", SECRET).update(body).digest("base64");
    expect((await receiveShopifyWebhook(body, headers("AAAA"))).status).toBe(401);
    expect(
      (
        await receiveShopifyWebhook(
          body,
          new Headers({ ...Object.fromEntries(headers(sig)), "x-shopify-shop-domain": "evil.com" }),
        )
      ).status,
    ).toBe(401);
    const first = await receiveShopifyWebhook(body, headers(sig));
    expect(first).toMatchObject({ status: 200, duplicate: false, accountId });
    expect(await receiveShopifyWebhook(body, headers(sig))).toMatchObject({ status: 200, duplicate: true });

    const fake = fakeShopify({
      OrderById: () => ({ order: order({ id: "gid://shopify/Order/4001", name: "#4001" }) }),
    });
    const eventId = (first as { eventId: string }).eventId;
    expect(await processShopifyWebhook(accountId, eventId, fake.opts)).toBe("PROCESSED");
    expect(await processShopifyWebhook(accountId, eventId, fake.opts)).toBe("PROCESSED");
    expect(fake.ops).toEqual(["OrderById"]);
    const o = await accountDb(accountId).order.findFirstOrThrow({
      where: { shopifyOrderGid: "gid://shopify/Order/4001" },
    });
    expect(o.note).toBeNull();
  });

  it("app/uninstalled marks the connection as broken", async () => {
    const body = "{}";
    const sig = createHmac("sha256", SECRET).update(body).digest("base64");
    const r = await receiveShopifyWebhook(
      body,
      new Headers({
        "x-shopify-shop-domain": DOMAIN,
        "x-shopify-topic": "app/uninstalled",
        "x-shopify-webhook-id": "wh-u",
        "x-shopify-hmac-sha256": sig,
      }),
    );
    await processShopifyWebhook(accountId, (r as { eventId: string }).eventId);
    expect((await store()).connectionStatus).toMatchObject({ ok: false, error: "app_uninstalled" });
  });

  it("webhook registration creates only the missing subscriptions", async () => {
    const uri = "https://crm.example.com/api/webhooks/shopify";
    const created: string[] = [];
    const fake = fakeShopify({
      WebhookSubscriptions: () => ({
        webhookSubscriptions: {
          nodes: [{ id: "gid://shopify/WebhookSubscription/1", topic: "ORDERS_CREATE", uri }],
        },
      }),
      WebhookCreate: (vars) => {
        created.push(vars.topic as string);
        return {
          webhookSubscriptionCreate: {
            webhookSubscription: {
              id: `gid://shopify/WebhookSubscription/${created.length + 1}`,
              topic: vars.topic,
              uri,
            },
            userErrors: [],
          },
        };
      },
    });
    const status = await registerStoreWebhooks(accountId, storeId, fake.opts, uri);
    expect(created).not.toContain("ORDERS_CREATE");
    expect(created).toHaveLength(6);
    expect(status).toMatchObject({ ok: true });
    expect(status.topics).toHaveLength(7);
  });
});
