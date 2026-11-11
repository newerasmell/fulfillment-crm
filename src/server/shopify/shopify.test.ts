import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ShopifyClient } from "@/integrations/shopify/client";
import type { ShopifyOrder } from "@/integrations/shopify/orders";
import type { ShopifyVariant } from "@/integrations/shopify/products";
import { TokenProvider } from "@/integrations/shopify/token";
import { WEBHOOK_TOPICS, verifyWebhookHmac, webhookTarget } from "@/integrations/shopify/webhooks";
import { bootstrapOwner } from "@/server/auth/users";
import { accountDb, systemDb } from "@/server/db/client";
import { createStore, type ScopedActor } from "@/server/stores";
import { backfillWindows, importShopifyOrder, isCod, refreshShopifyOrder, syncStoreOrders } from "./orders";
import {
  createProductFromVariant,
  linkVariant,
  stripSkuPrefix,
  upsertVariant,
  cleanVariantTitle,
} from "./products";
import { testStoreConnection } from "./connection";
import { missingScopes, REQUIRED_SCOPES } from "@/integrations/shopify/scopes";
import {
  processShopifyWebhook,
  receiveShopifyWebhook,
  registerStoreWebhooks,
  validCallbackUrl,
  webhookCallbackUrl,
} from "./webhooks";

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
    // A new product is read like a changed one.
    expect(webhookTarget("products/create", { admin_graphql_api_id: "gid://shopify/Product/10" })).toEqual({
      kind: "product",
      gid: "gid://shopify/Product/10",
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

  it("connection test reads the granted rights and names the missing ones (never fails the connection)", async () => {
    const granted = fakeShopify({
      Shop: () => ({ shop: { name: "Demo", myshopifyDomain: DOMAIN, currencyCode: "EUR" } }),
      AppScopes: () => ({
        currentAppInstallation: {
          accessScopes: ["write_orders", "write_products", "read_inventory"].map((handle) => ({ handle })),
        },
      }),
    });
    const r = await testStoreConnection(accountId, storeId, granted.opts);
    expect(r.ok).toBe(true);
    // write_X covers read_X: read_orders and read_products are not missing.
    expect(r.missingScopes).toEqual(
      REQUIRED_SCOPES.filter(
        (x) =>
          !["read_orders", "write_orders", "read_products", "write_products", "read_inventory"].includes(x),
      ),
    );
    expect(missingScopes([...REQUIRED_SCOPES])).toEqual([]);
    expect(((await store()).connectionStatus as { missingScopes: string[] }).missingScopes).toContain(
      "write_inventory",
    );
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

  it("after approval only Shopify's status fields follow; real changes become operator tasks", async () => {
    const s = await store();
    const db = accountDb(accountId);
    const o = order({ id: "gid://shopify/Order/2002", name: "#2002" });
    const { orderId } = await importShopifyOrder(accountId, s, o);
    await db.order.update({ where: { id: orderId }, data: { status: "APPROVED" } });
    const tasks = async () =>
      (await db.alert.findMany({ where: { entityId: orderId } })).map((a) => a.kind).sort();

    // Status-only change (e.g. paid): no task, status fields follow.
    await importShopifyOrder(accountId, s, {
      ...o,
      updatedAt: "2026-11-01T10:30:00Z",
      displayFinancialStatus: "PAID",
    });
    expect(await tasks()).toEqual([]);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).shopifyFinancialStatus).toBe(
      "PAID",
    );

    // A refund lowers what is owed and the phone changes: COD and recipient stay as approved, a task opens.
    await importShopifyOrder(accountId, s, {
      ...o,
      updatedAt: "2026-11-01T11:00:00Z",
      totalOutstandingSet: money("5.00"),
      phone: "+359111111111",
    });
    const after = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(Number(after.codAmount)).toBe(45);
    expect(after.phone).not.toBe("+359111111111");
    expect(await tasks()).toEqual(["shopify_changed_after_approval"]);

    await importShopifyOrder(accountId, s, {
      ...o,
      updatedAt: "2026-11-01T12:00:00Z",
      totalOutstandingSet: money("5.00"),
      phone: "+359111111111",
      cancelledAt: "2026-11-01T12:00:00Z",
    });
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("APPROVED");
    expect(await tasks()).toEqual(["shopify_cancelled_after_approval", "shopify_changed_after_approval"]);
  });

  it("an order the warehouse reported BLOCKED keeps its COD, recipient and lines", async () => {
    const s = await store();
    const db = accountDb(accountId);
    const o = order({ id: "gid://shopify/Order/2102", name: "#2102" });
    const { orderId } = await importShopifyOrder(accountId, s, o);
    await db.order.update({ where: { id: orderId }, data: { status: "BLOCKED" } });
    await importShopifyOrder(accountId, s, {
      ...o,
      updatedAt: "2026-11-01T11:00:00Z",
      totalOutstandingSet: money("1.00"),
      lineItems: { nodes: [] },
    });
    const after = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } });
    expect(Number(after.codAmount)).toBe(45);
    expect(after.lines).toHaveLength(1);
    expect((await db.alert.findMany({ where: { entityId: orderId } })).map((a) => a.kind)).toEqual([
      "shopify_changed_after_approval",
    ]);
  });

  it("one failing order does not stop the sync: it becomes a task and the cursor still advances", async () => {
    const good = order({ id: "gid://shopify/Order/9301", name: "#9301", updatedAt: "2026-10-30T08:00:00Z" });
    const bad = order({
      id: "gid://shopify/Order/9302",
      name: "#9302",
      updatedAt: "2026-10-30T09:00:00Z",
      lineItems: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "x" } },
    });
    const fake = fakeShopify({
      OrdersPage: () => ({
        orders: { nodes: [bad, good], pageInfo: { hasNextPage: false, endCursor: null } },
      }),
      OrderLines: () => ({ order: null }),
    });
    const counts = await syncStoreOrders(accountId, await store(), fake.client, { kind: "reconcile" });
    expect(counts).toMatchObject({ created: 1, failed: 1 });
    expect(((await store()).syncCursors as { ordersUpdatedAt: string }).ordersUpdatedAt).toBe(
      "2026-10-30T09:00:00.000Z",
    );
    const alert = await accountDb(accountId).alert.findFirstOrThrow({ where: { entityId: bad.id } });
    expect(alert.kind).toBe("shopify_import_failed");
  });

  it("re-reads the order when it changes while its lines are paged", async () => {
    const line = (n: number) => ({
      ...order().lineItems.nodes[0]!,
      id: `gid://shopify/LineItem/95${n}`,
      sku: `XX-C${n}`,
    });
    const v1 = order({
      id: "gid://shopify/Order/9500",
      name: "#9500",
      updatedAt: "2026-11-03T10:00:00Z",
      lineItems: { nodes: [line(1)], pageInfo: { hasNextPage: true, endCursor: "p" } },
    });
    const v2 = {
      ...v1,
      updatedAt: "2026-11-03T10:05:00Z",
      lineItems: { nodes: [line(1)], pageInfo: { hasNextPage: true, endCursor: "p" } },
    };
    let calls = 0;
    const fake = fakeShopify({
      OrderById: () => ({ order: calls === 0 ? v1 : v2 }),
      OrderLines: () => {
        calls++;
        return {
          order: {
            updatedAt: v2.updatedAt,
            lineItems: { nodes: [line(calls + 1)], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        };
      },
    });
    const r = await refreshShopifyOrder(accountId, await store(), fake.client, v1.id);
    const o = await accountDb(accountId).order.findUniqueOrThrow({
      where: { id: r!.orderId },
      include: { lines: true },
    });
    expect(o.shopifyUpdatedAt?.toISOString()).toBe("2026-11-03T10:05:00.000Z");
    expect(o.lines.map((l) => l.sku).sort()).toEqual(["XX-C1", "XX-C3"]);
  });

  it("backfill is split into week windows covering exactly N days", () => {
    const now = new Date("2026-11-02T00:00:00Z");
    const w = backfillWindows(10, now);
    expect(w).toEqual([
      { from: "2026-10-26T00:00:00.000Z", to: "2026-11-02T00:00:00.000Z" },
      { from: "2026-10-23T00:00:00.000Z", to: "2026-10-26T00:00:00.000Z" },
    ]);
  });

  it("orders Shopify already fulfilled are recorded outside the review queue and raise no tasks later", async () => {
    const s = await store();
    const db = accountDb(accountId);
    const o = order({ id: "gid://shopify/Order/9600", name: "#9600", displayFulfillmentStatus: "FULFILLED" });
    const { orderId } = await importShopifyOrder(accountId, s, o);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
      "FULFILLED_EXTERNALLY",
    );
    await importShopifyOrder(accountId, s, {
      ...o,
      updatedAt: "2026-11-01T12:00:00Z",
      totalOutstandingSet: money("0.00"),
    });
    expect(await db.alert.count({ where: { entityId: orderId } })).toBe(0);
    // A pre-approval order fulfilled by hand in Shopify leaves the queue too.
    const p = order({ id: "gid://shopify/Order/9601", name: "#9601" });
    const r = await importShopifyOrder(accountId, s, p);
    await importShopifyOrder(accountId, s, {
      ...p,
      updatedAt: "2026-11-01T12:00:00Z",
      displayFulfillmentStatus: "FULFILLED",
    });
    expect((await db.order.findUniqueOrThrow({ where: { id: r.orderId } })).status).toBe(
      "FULFILLED_EXTERNALLY",
    );
  });

  it("webhook URLs must be public https hosts on our path", () => {
    const prod = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
    expect(validCallbackUrl("https://crm.example.com/api/webhooks/shopify", prod)).toBe(
      "https://crm.example.com/api/webhooks/shopify",
    );
    expect(validCallbackUrl("https://fulfillment-crm-web/api/webhooks/shopify", prod)).toBeNull(); // Render internal name
    expect(validCallbackUrl("http://crm.example.com/api/webhooks/shopify", prod)).toBeNull();
    expect(validCallbackUrl("https://crm.example.com/other", prod)).toBeNull();
    expect(validCallbackUrl(undefined, prod)).toBeNull();
    expect(webhookCallbackUrl({ ...prod, RENDER_EXTERNAL_URL: "https://crm-web.onrender.com" })).toBe(
      "https://crm-web.onrender.com/api/webhooks/shopify",
    );
    expect(webhookCallbackUrl(prod)).toBeNull();
    expect(cleanVariantTitle("Sample EDP 50 ml - Default Title")).toBe("Sample EDP 50 ml");
  });

  it("COD only when money is owed; Shopify test orders are held", async () => {
    const s = await store();
    const db = accountDb(accountId);
    const paid = await importShopifyOrder(
      accountId,
      s,
      order({
        id: "gid://shopify/Order/6001",
        name: "#6001",
        paymentGatewayNames: ["shopify_payments", "Cash on Delivery (COD)"],
        totalOutstandingSet: money("0.00"),
      }),
    );
    const p = await db.order.findUniqueOrThrow({ where: { id: paid.orderId } });
    expect(p.paymentMethod).toBe("PREPAID");
    expect(p.codAmount).toBeNull();
    expect((await db.alert.findMany({ where: { entityId: paid.orderId } })).map((a) => a.kind)).toEqual([
      "cod_nothing_outstanding",
    ]);
    const partly = await importShopifyOrder(
      accountId,
      s,
      order({ id: "gid://shopify/Order/6002", name: "#6002", totalOutstandingSet: money("30.00") }),
    );
    expect(Number((await db.order.findUniqueOrThrow({ where: { id: partly.orderId } })).codAmount)).toBe(30);
    const test = await importShopifyOrder(
      accountId,
      s,
      order({ id: "gid://shopify/Order/6003", name: "#6003", test: true }),
    );
    expect((await db.order.findUniqueOrThrow({ where: { id: test.orderId } })).status).toBe("ON_HOLD");
  });

  it("concurrent imports of one order (webhook + reconcile) create it once and keep the newest version", async () => {
    const s = await store();
    const o = order({ id: "gid://shopify/Order/7001", name: "#7001" });
    const results = await Promise.all([
      importShopifyOrder(accountId, s, { ...o, updatedAt: "2026-11-01T10:00:00Z", note: "old" }),
      importShopifyOrder(accountId, s, { ...o, updatedAt: "2026-11-01T11:00:00Z", note: "new" }),
      importShopifyOrder(accountId, s, { ...o, updatedAt: "2026-11-01T10:30:00Z", note: "middle" }),
    ]);
    expect(results.filter((r) => r.outcome === "created")).toHaveLength(1);
    const rows = await accountDb(accountId).order.findMany({ where: { shopifyOrderGid: o.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.note).toBe("new");
  });

  it("fetches the remaining line items of a long order before importing it", async () => {
    const line = (n: number) => ({
      ...order().lineItems.nodes[0]!,
      id: `gid://shopify/LineItem/9${n}`,
      sku: `XX-L${n}`,
    });
    const first = order({
      id: "gid://shopify/Order/8001",
      name: "#8001",
      lineItems: { nodes: [line(1)], pageInfo: { hasNextPage: true, endCursor: "l1" } },
    });
    const fake = fakeShopify({
      OrderById: () => ({ order: first }),
      OrderLines: (vars) => {
        expect(vars.after).toBe("l1");
        return {
          order: {
            updatedAt: first.updatedAt,
            lineItems: { nodes: [line(2), line(3)], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        };
      },
    });
    const r = await refreshShopifyOrder(accountId, await store(), fake.client, first.id);
    const lines = await accountDb(accountId).orderLine.findMany({ where: { orderId: r!.orderId } });
    expect(lines.map((l) => l.sku).sort()).toEqual(["XX-L1", "XX-L2", "XX-L3"]);
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

  it("re-linking moves lines of open orders; other companies' variants are out of reach; ambiguous SKUs stay unmatched", async () => {
    const db = accountDb(accountId);
    const s = await store();
    const pa = await db.product.create({ data: { accountId, sku: "RL-A", name: "A" } });
    const pb = await db.product.create({ data: { accountId, sku: "RL-B", name: "B" } });
    const o = order({
      id: "gid://shopify/Order/9100",
      name: "#9100",
      lineItems: {
        nodes: [
          {
            ...order().lineItems.nodes[0]!,
            id: "gid://shopify/LineItem/9100",
            sku: "XX-RL-A",
            variant: { id: "gid://shopify/ProductVariant/9100" },
          },
        ],
      },
    });
    const { orderId } = await importShopifyOrder(accountId, s, o);
    const line = async () => db.orderLine.findFirstOrThrow({ where: { orderId } });
    expect((await line()).productId).toBe(pa.id); // auto-matched on import
    await linkVariant(owner, (await line()).variantLinkId!, "RL-B");
    expect((await line()).productId).toBe(pb.id);

    // A member restricted to another company cannot touch this store's variants.
    const other = await systemDb().company.create({ data: { accountId, name: "Other company" } });
    const restricted = { ...owner, role: "OPERATOR" as const, companyScope: [other.id] };
    await expect(linkVariant(restricted, (await line()).variantLinkId!, "RL-A")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(createProductFromVariant(restricted, (await line()).variantLinkId!)).rejects.toMatchObject({
      code: "not_found",
    });

    await db.product.create({ data: { accountId, sku: "dup-1", name: "lower" } });
    await db.product.create({ data: { accountId, sku: "DUP-1", name: "upper" } });
    expect(
      (
        await upsertVariant(
          accountId,
          s,
          variant({ id: "gid://shopify/ProductVariant/9200", sku: "XX-Dup-1" }),
        )
      ).matched,
    ).toBe(false);
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
    expect((queries[0] as { first: number; query: string }).first).toBeLessThanOrEqual(10);
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
    const stored = await accountDb(accountId).webhookEvent.findUniqueOrThrow({
      where: { id: (first as { eventId: string }).eventId },
    });
    expect(JSON.stringify(stored.payload)).not.toContain("never trusted"); // only the pointer is kept
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
    const status = await registerStoreWebhooks(accountId, storeId, uri, fake.opts);
    expect(created).not.toContain("ORDERS_CREATE");
    expect(created).toHaveLength(WEBHOOK_TOPICS.length - 1);
    expect(status).toMatchObject({ ok: true });
    expect(status.topics).toHaveLength(WEBHOOK_TOPICS.length);
  });
});
