import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bootstrapOwner } from "@/server/auth/users";
import { accountDb, systemDb } from "@/server/db/client";
import { saveCredential } from "@/server/security/credentials";
import { createStore } from "@/server/stores";
import {
  liveCheckTargets,
  registerLiveCheck,
  runLiveCheck,
  unregisterLiveCheck,
  type LiveCheckTarget,
} from "./live-check";
import { ALERT_KINDS } from "./safety";
import { registerShopifyLiveCheck } from "./shopify-live-check";

// P9-02 against a fake Shopify (mocked fetch) and a fake vendor check; nothing reaches a real API.

const DOMAIN = "watch-test.myshopify.com";

const money = { shopMoney: { amount: "10.00", currencyCode: "EUR" } };
const goodOrder = {
  id: "gid://shopify/Order/1",
  name: "#1",
  createdAt: "2026-11-01T10:00:00Z",
  processedAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-01T10:00:00Z",
  cancelledAt: null,
  email: null,
  phone: null,
  note: null,
  tags: [],
  test: false,
  currencyCode: "EUR",
  displayFinancialStatus: "PENDING",
  displayFulfillmentStatus: "UNFULFILLED",
  paymentGatewayNames: [],
  subtotalPriceSet: money,
  totalPriceSet: money,
  totalOutstandingSet: money,
  customer: null,
  shippingAddress: null,
  billingAddress: null,
  risk: null,
  lineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
};
const goodVariant = {
  id: "gid://shopify/ProductVariant/1",
  sku: "SYN-1",
  title: "Default",
  displayName: "Synthetic - Default",
  updatedAt: "2026-11-01T10:00:00Z",
  barcodes: { nodes: [] },
  product: { id: "gid://shopify/Product/1", title: "Synthetic", vendor: "Demo", status: "ACTIVE" },
};
const versions = (pinnedSupported = true) => [
  { handle: "2026-07", displayName: "2026-07", supported: true },
  { handle: "2026-10", displayName: "2026-10 (Latest)", supported: pinnedSupported },
  { handle: "2027-01", displayName: "2027-01 (Release candidate)", supported: false },
];

type Routes = Record<
  string,
  () => { data?: unknown; errors?: { message: string; extensions?: { code: string } }[] } | Response
>;

function fakeShopify(routes: Routes) {
  const ops: string[] = [];
  const bodies: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/admin/oauth/access_token"))
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 86399 }), { status: 200 });
    const body = JSON.parse(String(init?.body)) as { query: string };
    bodies.push(body.query);
    const op = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "?";
    ops.push(op);
    const r = routes[op]?.();
    if (!r) throw new Error(`unexpected operation ${op}`);
    return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200 });
  });
  return { fetchImpl, ops, bodies, ctx: { fetchImpl, sleep: async () => {} } };
}

const healthy: Routes = {
  Shop: () => ({ data: { shop: { name: "Demo", myshopifyDomain: DOMAIN, currencyCode: "EUR" } } }),
  OrdersPage: () => ({
    data: { orders: { nodes: [goodOrder], pageInfo: { hasNextPage: false, endCursor: null } } },
  }),
  VariantsPage: () => ({
    data: { productVariants: { nodes: [goodVariant], pageInfo: { hasNextPage: false, endCursor: null } } },
  }),
  ApiVersions: () => ({ data: { publicApiVersions: versions() } }),
};

describe("live check (DB)", () => {
  let accountId: string;
  let storeId: string;
  let connId: string;
  let target: LiveCheckTarget;
  const store = () => systemDb().store.findUniqueOrThrow({ where: { id: storeId } });
  const alerts = (kind: string) => accountDb(accountId).alert.findMany({ where: { kind } });
  const resolveAll = () =>
    accountDb(accountId).alert.updateMany({
      where: {},
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });

  beforeAll(async () => {
    registerShopifyLiveCheck();
    const r = await bootstrapOwner({
      email: `live-${Date.now()}@example.com`,
      name: "O",
      accountName: "Live check group",
      password: "correct horse battery staple",
    });
    accountId = r.account.id;
    const company = await systemDb().company.findFirstOrThrow({ where: { accountId } });
    const s = await createStore(
      { userId: r.user.id, accountId, role: "OWNER", companyScope: null },
      {
        companyId: company.id,
        name: "Watch store",
        domain: DOMAIN,
        code: "WS",
        currency: "EUR",
        countries: ["BG"],
        clientId: "client-id-live",
        clientSecret: "client-secret-live-not-real",
      },
    );
    storeId = s.id;
    await accountDb(accountId).store.update({
      where: { id: storeId },
      data: {
        connectionStatus: { ok: true, at: "2026-11-02T00:00:00Z" },
        writeBackMode: "LIVE",
        inventoryPushMode: "DISABLED",
      },
    });
    const cred = await saveCredential(accountDb(accountId), accountId, {
      label: "eu",
      secret: '{"t":"synthetic"}',
    });
    connId = (
      await accountDb(accountId).fulfillmentConnection.create({
        data: {
          accountId,
          type: "EUSHIPMENTS",
          name: "EU canary",
          liveMode: "CANARY",
          credentialId: cred.id,
        },
      })
    ).id;
    target = { accountId, kind: "store", id: storeId, name: "Watch store", type: "SHOPIFY" };
  });

  afterAll(() => unregisterLiveCheck("EUSHIPMENTS"));

  it("lists stores with credentials and a good connection, and connections with credentials", async () => {
    const targets = (await liveCheckTargets()).filter((t) => t.accountId === accountId);
    expect(targets.map((t) => `${t.kind}:${t.type}`).sort()).toEqual([
      "connection:EUSHIPMENTS",
      "store:SHOPIFY",
    ]);
  });

  it("healthy responses: read-only queries only, nothing changes, versions recorded", async () => {
    const f = fakeShopify(healthy);
    const out = await runLiveCheck(target, f.ctx);
    expect(out.status).toBe("ok");
    expect(f.ops).toEqual(["Shop", "OrdersPage", "VariantsPage", "ApiVersions"]);
    expect(f.bodies.some((b) => /\bmutation\b/.test(b))).toBe(false);
    expect((await store()).writeBackMode).toBe("LIVE");
    expect(await alerts(ALERT_KINDS.liveCheck)).toHaveLength(0);
    const v = await systemDb().apiSpecVersion.findFirst({ where: { vendor: "SHOPIFY" } });
    expect((v?.normalised as { versions: unknown[] }).versions).toHaveLength(3);
  });

  it("a new field is a WARNING only", async () => {
    const f = fakeShopify({
      ...healthy,
      Shop: () => ({
        data: { shop: { name: "Demo", myshopifyDomain: DOMAIN, currencyCode: "EUR", brandNewField: 1 } },
      }),
    });
    const out = await runLiveCheck(target, f.ctx);
    expect(out).toMatchObject({ status: "issues", breaking: false, demoted: false });
    const [a] = await alerts(ALERT_KINDS.liveCheck);
    expect(a?.severity).toBe("WARNING");
    expect(a?.body).toContain("shop.brandNewField");
    expect((await store()).writeBackMode).toBe("LIVE");
    await resolveAll();
  });

  it("a breaking mismatch drops the store to DRY_RUN with an audit entry and a CRITICAL alert (no PII in it)", async () => {
    const { totalPriceSet: _gone, ...broken } = goodOrder;
    const f = fakeShopify({
      ...healthy,
      OrdersPage: () => ({
        data: {
          orders: {
            nodes: [{ ...broken, email: "person@example.com" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    });
    const out = await runLiveCheck(target, f.ctx);
    expect(out).toMatchObject({ status: "issues", breaking: true, demoted: true });
    const s = await store();
    expect(s.writeBackMode).toBe("DRY_RUN");
    expect(s.inventoryPushMode).toBe("DISABLED"); // never raised
    const audit = await accountDb(accountId).auditLog.findFirst({
      where: { action: "store.mode.autoLower", entityId: storeId },
    });
    expect(audit?.before).toMatchObject({ writeBackMode: "LIVE" });
    expect(audit?.after).toMatchObject({ writeBackMode: "DRY_RUN" });
    const open = await alerts(ALERT_KINDS.liveCheck).then((r) => r.filter((x) => x.status === "OPEN"));
    expect(open).toHaveLength(1);
    expect(open[0]!.severity).toBe("CRITICAL");
    expect(open[0]!.body).toContain("orders.nodes[].totalPriceSet");
    expect(open[0]!.body).not.toContain("person@example.com");

    // Second run: the alert is not duplicated and the mode stays (no flapping, no raise).
    await runLiveCheck(target, f.ctx);
    expect(
      await alerts(ALERT_KINDS.liveCheck).then((r) => r.filter((x) => x.status === "OPEN")),
    ).toHaveLength(1);
    expect((await store()).writeBackMode).toBe("DRY_RUN");
    await resolveAll();
    await accountDb(accountId).store.update({ where: { id: storeId }, data: { writeBackMode: "LIVE" } });
  });

  it("a query Shopify rejects (field removed) or a retired API version is breaking", async () => {
    const rejected = fakeShopify({
      ...healthy,
      VariantsPage: () => ({
        errors: [{ message: "Field 'barcodes' doesn't exist on type 'ProductVariant'" }],
      }),
    });
    expect(await runLiveCheck(target, rejected.ctx)).toMatchObject({ status: "issues", breaking: true });
    expect((await store()).writeBackMode).toBe("DRY_RUN");
    await resolveAll();
    await accountDb(accountId).store.update({ where: { id: storeId }, data: { writeBackMode: "LIVE" } });

    const retired = fakeShopify({
      ...healthy,
      ApiVersions: () => ({ data: { publicApiVersions: versions(false) } }),
    });
    const out = await runLiveCheck(target, retired.ctx);
    expect(out).toMatchObject({ status: "issues", breaking: true, demoted: true });
    await resolveAll();
    await accountDb(accountId).store.update({ where: { id: storeId }, data: { writeBackMode: "LIVE" } });
  });

  it("an open WARNING for the store is escalated by a later CRITICAL (the demotion is never silent)", async () => {
    const extra = fakeShopify({
      ...healthy,
      Shop: () => ({
        data: { shop: { name: "Demo", myshopifyDomain: DOMAIN, currencyCode: "EUR", brandNewField: 1 } },
      }),
    });
    await runLiveCheck(target, extra.ctx);
    const rejected = fakeShopify({
      ...healthy,
      VariantsPage: () => ({
        errors: [
          {
            message: "Field 'barcodes' doesn't exist on type 'ProductVariant'",
            extensions: { code: "undefinedField" },
          },
        ],
      }),
    });
    expect(await runLiveCheck(target, rejected.ctx)).toMatchObject({ breaking: true, demoted: true });
    const open = await alerts(ALERT_KINDS.liveCheck).then((r) => r.filter((x) => x.status === "OPEN"));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ severity: "CRITICAL" });
    expect(open[0]!.title).toContain("dropped to DRY_RUN");
    await resolveAll();
    await accountDb(accountId).store.update({ where: { id: storeId }, data: { writeBackMode: "LIVE" } });
  });

  it("GraphQL errors that are not schema changes (access denied, internal) do not demote", async () => {
    for (const err of [
      { message: "Access denied for orders field.", extensions: { code: "ACCESS_DENIED" } },
      {
        message: "Internal error. Looks like something went wrong on our end.",
        extensions: { code: "INTERNAL_SERVER_ERROR" },
      },
      {
        message: "Query cost is 2000, which exceeds the single query max cost limit (1000).",
        extensions: { code: "MAX_COST_EXCEEDED" },
      },
    ]) {
      const f = fakeShopify({ ...healthy, OrdersPage: () => ({ errors: [err] }) });
      expect(await runLiveCheck(target, f.ctx)).toEqual({ status: "failed", error: "graphql_error" });
      expect((await store()).writeBackMode).toBe("LIVE");
    }
    expect(
      await alerts(ALERT_KINDS.liveCheck).then((r) => r.filter((x) => x.status !== "RESOLVED")),
    ).toHaveLength(0);
    const failed = await alerts(ALERT_KINDS.liveCheckFailed).then((r) =>
      r.filter((x) => x.status === "OPEN"),
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]!.severity).toBe("WARNING");
    await resolveAll();
  });

  it("a single target is re-read by id, account and kind with the same filters", async () => {
    expect(await liveCheckTargets({ accountId, kind: "store", id: storeId })).toEqual([target]);
    expect(await liveCheckTargets({ accountId, kind: "connection", id: storeId })).toEqual([]);
    expect(await liveCheckTargets({ accountId: "other-account", kind: "store", id: storeId })).toEqual([]);
    const [c] = await liveCheckTargets({ accountId, kind: "connection", id: connId });
    expect(c).toMatchObject({ id: connId, type: "EUSHIPMENTS" });
  });

  it("a probe that cannot run (auth) alerts but changes no mode", async () => {
    const f = fakeShopify({ ...healthy, Shop: () => new Response("unauthorised", { status: 403 }) });
    const out = await runLiveCheck(target, f.ctx);
    expect(out).toEqual({ status: "failed", error: "auth_failed" });
    expect((await store()).writeBackMode).toBe("LIVE");
    expect(
      await alerts(ALERT_KINDS.liveCheckFailed).then((r) => r.filter((x) => x.status === "OPEN")),
    ).toHaveLength(1);
    await resolveAll();
  });

  it("connections without a registered adapter are skipped; a plugged-in check can drop a CANARY connection", async () => {
    const conn: LiveCheckTarget = {
      accountId,
      kind: "connection",
      id: connId,
      name: "EU canary",
      type: "EUSHIPMENTS",
    };
    expect(await runLiveCheck(conn)).toEqual({ status: "skipped" });

    registerLiveCheck({
      type: "EUSHIPMENTS",
      run: async () => ({
        probes: ["GET /get-status"],
        issues: [
          { breaking: true, probe: "GET /get-status", code: "schema_mismatch", path: "status", message: "x" },
        ],
      }),
    });
    expect(await runLiveCheck(conn)).toMatchObject({ status: "issues", breaking: true, demoted: true });
    const c = await systemDb().fulfillmentConnection.findUniqueOrThrow({ where: { id: connId } });
    expect(c.liveMode).toBe("DRY_RUN");
    const audit = await accountDb(accountId).auditLog.findFirst({
      where: { action: "connection.mode_change", entityId: connId },
    });
    expect(audit?.before).toEqual({ liveMode: "CANARY" });

    // Already DRY_RUN or READ_ONLY: nothing to lower.
    await accountDb(accountId).fulfillmentConnection.update({
      where: { id: connId },
      data: { liveMode: "READ_ONLY" },
    });
    await resolveAll();
    expect(await runLiveCheck(conn)).toMatchObject({ demoted: false });
    expect(
      (await systemDb().fulfillmentConnection.findUniqueOrThrow({ where: { id: connId } })).liveMode,
    ).toBe("READ_ONLY");
  });
});
