import { beforeAll, describe, expect, it, vi } from "vitest";
import { ShopifyClient, type ShopifyClientOptions } from "@/integrations/shopify/client";
import { estimateQueryCost } from "@/integrations/shopify/query-cost";
import {
  FULFILLMENT_CREATE_MUTATION,
  planFulfillment,
  WRITE_BACK_READ_QUERY,
  type WriteBackRead,
} from "@/integrations/shopify/fulfillments";
import { TokenProvider } from "@/integrations/shopify/token";
import { systemDb } from "@/server/db/client";
import { euTestGroup, euTestOrder } from "@/server/eushipments/test-fixtures";
import {
  processWriteBack,
  sweepWriteBacks,
  WRITE_BACK_STALE_MS,
  WRITE_BACK_WINDOW_DAYS,
  type StoreClientFactory,
} from "./writeback";

// Mocked Shopify only (no network): token endpoint + GraphQL by operation name. Synthetic ids.

const ORDER_GID = "gid://shopify/Order/9000001";
const LINE_GID = "gid://shopify/LineItem/9100001";
const FO_GID = "gid://shopify/FulfillmentOrder/9200001";
const FOLI_GID = "gid://shopify/FulfillmentOrderLineItem/9300001";

type Handler = (vars: Record<string, unknown>) => unknown;

function fakeShopify(routes: Record<string, Handler | Handler[]>) {
  const ops: { op: string; vars: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/admin/oauth/access_token"))
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 86399 }), { status: 200 });
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const op = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "?";
    ops.push({ op, vars: body.variables });
    const r = routes[op];
    const h = Array.isArray(r) ? (r.length > 1 ? r.shift()! : r[0]!) : r;
    if (!h) throw new Error(`unexpected operation ${op}`);
    const out = h(body.variables);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify({ data: out }), { status: 200 });
  });
  const tokens = new TokenProvider(fetchImpl);
  const clients: StoreClientFactory = async (_a, _s, opts: ShopifyClientOptions) => ({
    client: new ShopifyClient(
      "writeback-test.myshopify.com",
      { clientId: "client-id-0001", clientSecret: "not-a-real-secret-0001" },
      { fetchImpl, tokens, sleep: async () => {}, ...opts },
    ),
    store: { notifyCustomer: true },
  });
  const count = (op: string) => ops.filter((o) => o.op === op).length;
  return { ops, clients, count };
}

const readWith = (fulfillments: NonNullable<WriteBackRead["order"]>["fulfillments"]) => ({
  order: {
    id: ORDER_GID,
    fulfillments,
    fulfillmentOrders: {
      nodes: [
        {
          id: FO_GID,
          status: "OPEN",
          supportedActions: [{ action: "CREATE_FULFILLMENT" }],
          assignedLocation: { location: { id: "gid://shopify/Location/1" } },
          lineItems: { nodes: [{ id: FOLI_GID, remainingQuantity: 2, lineItem: { id: LINE_GID } }] },
        },
      ],
    },
  },
});
const ours = (n: string) => [
  {
    id: "gid://shopify/Fulfillment/1",
    status: "SUCCESS",
    trackingInfo: [{ number: n, company: "X", url: null }],
  },
];

describe("planFulfillment (pure)", () => {
  it("takes the shipped lines from the open fulfillment orders, never more than remains", () => {
    const p = planFulfillment(
      readWith([]) as WriteBackRead,
      [{ shopifyLineGid: LINE_GID, quantity: 5 }],
      { number: "TRK1", company: "GLS", url: "https://track.example/TRK1" },
      false,
    );
    expect(p).toEqual({
      ok: true,
      lines: [{ lineItemId: LINE_GID, quantity: 2 }],
      input: {
        lineItemsByFulfillmentOrder: [
          { fulfillmentOrderId: FO_GID, fulfillmentOrderLineItems: [{ id: FOLI_GID, quantity: 2 }] },
        ],
        notifyCustomer: false,
        trackingInfo: { number: "TRK1", company: "GLS", url: "https://track.example/TRK1" },
      },
    });
    expect(planFulfillment({ order: null }, [], { number: "x", company: null, url: null }, true)).toEqual({
      ok: false,
      reason: "order_not_found",
    });
  });
  it("the read query stays well under Shopify's cost limit", () => {
    expect(estimateQueryCost(WRITE_BACK_READ_QUERY)).toBeLessThan(1000);
  });
});

describe("Shopify write-back (DB, mocked Shopify)", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  let n = 7000;
  const db = () => systemDb();

  /** A shipped shipment with a tracking number, of a Shopify order in the test store. */
  async function shipped(tracking = `TRK-${++n}`) {
    const { order } = await euTestOrder(g, { number: `#${n}` });
    await db().order.update({
      where: { id: order.id },
      data: { status: "SHIPPED", shopifyOrderGid: `${ORDER_GID}${n}` },
    });
    const line = await db().orderLine.findFirstOrThrow({ where: { orderId: order.id } });
    await db().orderLine.update({ where: { id: line.id }, data: { shopifyLineGid: LINE_GID } });
    const f = await db().fulfillment.create({
      data: {
        accountId: g.accountId,
        orderId: order.id,
        connectionId: g.connection.id,
        externalId: `TST-${n}`,
        status: "SHIPPED",
        carrier: "GLS",
        trackingNumbers: [tracking],
        trackingUrls: [`https://track.example/${tracking}`],
        shippedAt: new Date(),
        lines: { create: [{ orderLineId: line.id, quantity: 2 }] },
      },
    });
    return { order, f, tracking };
  }
  const setMode = (writeBackMode: "READ_ONLY" | "DRY_RUN" | "LIVE") =>
    db().store.update({ where: { id: g.store.id }, data: { writeBackMode } });
  const rowFor = (fulfillmentId: string) =>
    db().shopifyWriteBack.findFirst({ where: { fulfillmentId, kind: "FULFIL" } });

  beforeAll(async () => {
    g = await euTestGroup("writeback");
  });

  it("READ_ONLY store: no row, nothing read or sent", async () => {
    await setMode("READ_ONLY");
    const { f } = await shipped();
    await sweepWriteBacks();
    expect(await rowFor(f.id)).toBeNull();
  });

  it("DRY_RUN records the exact mutation and variables; nothing is sent", async () => {
    await setMode("DRY_RUN");
    const { f, tracking } = await shipped();
    const s = await sweepWriteBacks();
    const row = (await rowFor(f.id))!;
    expect(s.ready).toContain(row.id);
    const shop = fakeShopify({ FulfillmentWriteBackRead: () => readWith([]) });
    expect(await processWriteBack(row.id, shop.clients)).toBe("DRY_RUN_RECORDED");
    expect(shop.count("FulfillmentWriteBack")).toBe(0);
    const after = (await rowFor(f.id))!;
    expect(after.request).toEqual({
      mutation: FULFILLMENT_CREATE_MUTATION,
      variables: {
        fulfillment: {
          lineItemsByFulfillmentOrder: [
            { fulfillmentOrderId: FO_GID, fulfillmentOrderLineItems: [{ id: FOLI_GID, quantity: 2 }] },
          ],
          notifyCustomer: true,
          trackingInfo: { number: tracking, company: "GLS", url: `https://track.example/${tracking}` },
        },
      },
    });
    // The store goes LIVE: the dry-run record is re-armed and sent once.
    await setMode("LIVE");
    expect((await sweepWriteBacks()).rearmed).toBeGreaterThanOrEqual(1);
    const live = fakeShopify({
      FulfillmentWriteBackRead: () => readWith([]),
      FulfillmentWriteBack: () => ({
        fulfillmentCreate: {
          fulfillment: { id: "gid://shopify/Fulfillment/77", status: "SUCCESS" },
          userErrors: [],
        },
      }),
    });
    expect(await processWriteBack(row.id, live.clients)).toBe("SENT");
    expect((await rowFor(f.id))!.shopifyFulfillmentGid).toBe("gid://shopify/Fulfillment/77");
    // Never twice: a SENT row is not processed again, and the sweep creates no second row.
    expect(await processWriteBack(row.id, live.clients)).toBe("skipped");
    await sweepWriteBacks();
    expect(await db().shopifyWriteBack.count({ where: { fulfillmentId: f.id, kind: "FULFIL" } })).toBe(1);
    expect(live.count("FulfillmentWriteBack")).toBe(1);
    const ev = await db().fulfillmentEvent.findFirst({
      where: { fulfillmentId: f.id, source: "shopify.writeback" },
    });
    expect(ev?.rawStatus).toBe("dry_run");
  });

  it("LIVE: an existing fulfillment with our tracking number is found by the read-back; nothing is sent", async () => {
    await setMode("LIVE");
    const { f, tracking } = await shipped();
    await sweepWriteBacks();
    const row = (await rowFor(f.id))!;
    const shop = fakeShopify({ FulfillmentWriteBackRead: () => readWith(ours(tracking)) });
    expect(await processWriteBack(row.id, shop.clients)).toBe("SENT");
    expect(shop.count("FulfillmentWriteBack")).toBe(0);
  });

  it("LIVE: a lost answer is resolved by reading back — created → SENT, not created → retried later, once", async () => {
    await setMode("LIVE");
    const a = await shipped();
    await sweepWriteBacks();
    const rowA = (await rowFor(a.f.id))!;
    const lost = () => new Response("bad gateway", { status: 502 });
    const shopA = fakeShopify({
      FulfillmentWriteBackRead: [() => readWith([]), () => readWith(ours(a.tracking))],
      FulfillmentWriteBack: lost,
    });
    expect(await processWriteBack(rowA.id, shopA.clients)).toBe("SENT");
    expect(shopA.count("FulfillmentWriteBack")).toBe(1); // the client never retried the mutation

    const b = await shipped();
    await sweepWriteBacks();
    const rowB = (await rowFor(b.f.id))!;
    const shopB = fakeShopify({ FulfillmentWriteBackRead: () => readWith([]), FulfillmentWriteBack: lost });
    expect(await processWriteBack(rowB.id, shopB.clients)).toBe("PENDING");
    const after = (await rowFor(b.f.id))!;
    expect(after.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await processWriteBack(rowB.id, shopB.clients)).toBe("skipped"); // not due yet
  });

  it("LIVE: read-back failing after an unknown outcome → UNCERTAIN + CRITICAL task, never retried", async () => {
    await setMode("LIVE");
    const { f, order } = await shipped();
    await sweepWriteBacks();
    const row = (await rowFor(f.id))!;
    const shop = fakeShopify({
      FulfillmentWriteBackRead: [() => readWith([]), () => new Response("down", { status: 503 })],
      FulfillmentWriteBack: () => new Response("down", { status: 503 }),
    });
    expect(await processWriteBack(row.id, shop.clients)).toBe("UNCERTAIN");
    const task = await db().alert.findFirst({
      where: { entityId: order.id, kind: "shopify_writeback_uncertain" },
    });
    expect(task).toMatchObject({ severity: "CRITICAL", isTask: true });
    expect(await processWriteBack(row.id, shop.clients)).toBe("skipped");
  });

  it("LIVE: userErrors are a definite refusal → FAILED + operator task", async () => {
    await setMode("LIVE");
    const { f, order } = await shipped();
    await sweepWriteBacks();
    const row = (await rowFor(f.id))!;
    const shop = fakeShopify({
      FulfillmentWriteBackRead: () => readWith([]),
      FulfillmentWriteBack: () => ({
        fulfillmentCreate: {
          fulfillment: null,
          userErrors: [{ field: ["fulfillment"], message: "Invalid" }],
        },
      }),
    });
    expect(await processWriteBack(row.id, shop.clients)).toBe("FAILED");
    expect(await db().alert.count({ where: { entityId: order.id, kind: "shopify_writeback_failed" } })).toBe(
      1,
    );
  });

  it("the store lowered to READ_ONLY after the row was created: refused at send time; kill switch pauses", async () => {
    await setMode("LIVE");
    const a = await shipped();
    const b = await shipped();
    await sweepWriteBacks();
    await setMode("READ_ONLY");
    const shop = fakeShopify({});
    expect(await processWriteBack((await rowFor(a.f.id))!.id, shop.clients)).toBe("REFUSED");
    await setMode("LIVE");
    await db().account.update({ where: { id: g.accountId }, data: { outboxPaused: true } });
    try {
      expect(await processWriteBack((await rowFor(b.f.id))!.id, shop.clients)).toBe("PAUSED");
    } finally {
      await db().account.update({ where: { id: g.accountId }, data: { outboxPaused: false } });
    }
    expect(shop.ops).toEqual([]);
  });

  it("sweep: a stale LIVE send becomes UNCERTAIN + CRITICAL task + timeline entry; a stale DRY_RUN goes back to PENDING", async () => {
    await setMode("LIVE");
    const a = await shipped();
    const b = await shipped();
    await sweepWriteBacks();
    const old = new Date(Date.now() - WRITE_BACK_STALE_MS - 60_000);
    await db().shopifyWriteBack.update({
      where: { id: (await rowFor(a.f.id))!.id },
      data: { status: "SENDING", evaluatedMode: "LIVE", lockedAt: old },
    });
    await db().shopifyWriteBack.update({
      where: { id: (await rowFor(b.f.id))!.id },
      data: { status: "SENDING", evaluatedMode: "DRY_RUN", lockedAt: old },
    });
    await sweepWriteBacks();
    expect((await rowFor(a.f.id))!.status).toBe("UNCERTAIN");
    expect((await rowFor(b.f.id))!.status).toBe("PENDING");
    expect(
      await db().alert.findFirst({ where: { entityId: a.order.id, kind: "shopify_writeback_uncertain" } }),
    ).toMatchObject({ severity: "CRITICAL" });
    expect(
      await db().alert.count({ where: { entityId: b.order.id, kind: "shopify_writeback_uncertain" } }),
    ).toBe(0);
    expect(
      await db().fulfillmentEvent.findFirst({
        where: { fulfillmentId: a.f.id, source: "shopify.writeback" },
      }),
    ).toMatchObject({ rawStatus: "uncertain" });
  });

  it("DRY_RUN_RECORDED is re-armed only for a LIVE store and only inside the window", async () => {
    await setMode("DRY_RUN");
    const recent = await shipped();
    const old = await shipped();
    await sweepWriteBacks();
    for (const x of [recent, old])
      await db().shopifyWriteBack.update({
        where: { id: (await rowFor(x.f.id))!.id },
        data: { status: "DRY_RUN_RECORDED" },
      });
    await db().shopifyWriteBack.update({
      where: { id: (await rowFor(old.f.id))!.id },
      data: { createdAt: new Date(Date.now() - (WRITE_BACK_WINDOW_DAYS + 1) * 86_400_000) },
    });
    await sweepWriteBacks(); // still DRY_RUN: nothing re-armed
    expect((await rowFor(recent.f.id))!.status).toBe("DRY_RUN_RECORDED");
    await setMode("LIVE");
    await sweepWriteBacks();
    expect((await rowFor(recent.f.id))!.status).toBe("PENDING");
    expect((await rowFor(old.f.id))!.status).toBe("DRY_RUN_RECORDED");
  });

  it("two processWriteBack calls at once on the same row: exactly one fulfillmentCreate", async () => {
    await setMode("LIVE");
    const { f, tracking } = await shipped();
    await sweepWriteBacks();
    const row = (await rowFor(f.id))!;
    const shop = fakeShopify({
      FulfillmentWriteBackRead: () => readWith([]),
      FulfillmentWriteBack: () => ({
        fulfillmentCreate: {
          fulfillment: { id: "gid://shopify/Fulfillment/77", status: "SUCCESS" },
          userErrors: [],
        },
      }),
    });
    const rs = await Promise.all([
      processWriteBack(row.id, shop.clients),
      processWriteBack(row.id, shop.clients),
    ]);
    expect(rs.sort()).toEqual(["SENT", "skipped"]);
    expect(shop.count("FulfillmentWriteBack")).toBe(1);
    expect((await rowFor(f.id))!.trackingNumber).toBe(tracking);
  });

  it("graphql_error with only 'rejected before execution' codes → FAILED + task + timeline entry", async () => {
    await setMode("LIVE");
    const { f, order } = await shipped();
    await sweepWriteBacks();
    const row = (await rowFor(f.id))!;
    const shop = fakeShopify({
      FulfillmentWriteBackRead: () => readWith([]),
      FulfillmentWriteBack: () =>
        new Response(
          JSON.stringify({ errors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }] }),
          { status: 200 },
        ),
    });
    expect(await processWriteBack(row.id, shop.clients)).toBe("FAILED");
    expect(shop.count("FulfillmentWriteBackRead")).toBe(1); // no read-back needed: nothing ran
    expect(await db().alert.count({ where: { entityId: order.id, kind: "shopify_writeback_failed" } })).toBe(
      1,
    );
    expect(
      await db().fulfillmentEvent.findFirst({ where: { fulfillmentId: f.id, source: "shopify.writeback" } }),
    ).toMatchObject({ rawStatus: "failed" });
  });

  it("graphql_error INTERNAL_SERVER_ERROR (or no code) is an unknown outcome: read back, then SENT / UNCERTAIN", async () => {
    await setMode("LIVE");
    const internal = () =>
      new Response(
        JSON.stringify({
          errors: [{ message: "Internal error", extensions: { code: "INTERNAL_SERVER_ERROR" } }],
        }),
        { status: 200 },
      );
    const a = await shipped();
    await sweepWriteBacks();
    const shopA = fakeShopify({
      FulfillmentWriteBackRead: [() => readWith([]), () => readWith(ours(a.tracking))],
      FulfillmentWriteBack: internal,
    });
    expect(await processWriteBack((await rowFor(a.f.id))!.id, shopA.clients)).toBe("SENT");
    expect(shopA.count("FulfillmentWriteBack")).toBe(1);

    const b = await shipped();
    await sweepWriteBacks();
    const noCode = () => new Response(JSON.stringify({ errors: [{ message: "Timeout" }] }), { status: 200 });
    const shopB = fakeShopify({
      FulfillmentWriteBackRead: [() => readWith([]), () => new Response("down", { status: 503 })],
      FulfillmentWriteBack: noCode,
    });
    expect(await processWriteBack((await rowFor(b.f.id))!.id, shopB.clients)).toBe("UNCERTAIN");
    expect(
      await db().alert.findFirst({ where: { entityId: b.order.id, kind: "shopify_writeback_uncertain" } }),
    ).toMatchObject({ severity: "CRITICAL" });
    expect(
      await db().alert.count({ where: { entityId: b.order.id, kind: "shopify_writeback_failed" } }),
    ).toBe(0);
  });

  it("multiple_locations and nothing_to_fulfil → FAILED + operator task, nothing sent", async () => {
    await setMode("LIVE");
    const a = await shipped();
    const b = await shipped();
    await sweepWriteBacks();
    const two = readWith([]);
    const fo = two.order.fulfillmentOrders.nodes[0]!;
    two.order.fulfillmentOrders.nodes = [
      { ...fo, lineItems: { nodes: [{ ...fo.lineItems.nodes[0]!, remainingQuantity: 1 }] } },
      {
        ...fo,
        id: `${FO_GID}2`,
        assignedLocation: { location: { id: "gid://shopify/Location/2" } },
        lineItems: { nodes: [{ ...fo.lineItems.nodes[0]!, id: `${FOLI_GID}2`, remainingQuantity: 1 }] },
      },
    ];
    const shopA = fakeShopify({ FulfillmentWriteBackRead: () => two });
    expect(await processWriteBack((await rowFor(a.f.id))!.id, shopA.clients)).toBe("FAILED");
    expect((await rowFor(a.f.id))!.lastError).toBe("multiple_locations");
    const none = readWith([]);
    none.order.fulfillmentOrders.nodes[0]!.status = "CLOSED";
    const shopB = fakeShopify({ FulfillmentWriteBackRead: () => none });
    expect(await processWriteBack((await rowFor(b.f.id))!.id, shopB.clients)).toBe("FAILED");
    expect((await rowFor(b.f.id))!.lastError).toBe("nothing_to_fulfil");
    for (const x of [a, b])
      expect(
        await db().alert.count({ where: { entityId: x.order.id, kind: "shopify_writeback_failed" } }),
      ).toBe(1);
    expect(shopA.count("FulfillmentWriteBack") + shopB.count("FulfillmentWriteBack")).toBe(0);
  });

  it("a Shopify fulfillment with our tracking number in ERROR / FAILURE is an operator task, never SENT", async () => {
    await setMode("LIVE");
    const { f, tracking, order } = await shipped();
    await sweepWriteBacks();
    const failed = ours(tracking).map((x) => ({ ...x, status: "FAILURE" }));
    const shop = fakeShopify({ FulfillmentWriteBackRead: () => readWith(failed) });
    expect(await processWriteBack((await rowFor(f.id))!.id, shop.clients)).toBe("FAILED");
    expect((await rowFor(f.id))!.lastError).toBe("shopify_fulfillment_failure");
    expect(shop.count("FulfillmentWriteBack")).toBe(0);
    expect(await db().alert.count({ where: { entityId: order.id, kind: "shopify_writeback_failed" } })).toBe(
      1,
    );
  });

  it("REFUSED (store READ_ONLY at send time) is on the order timeline", async () => {
    await setMode("LIVE");
    const { f } = await shipped();
    await sweepWriteBacks();
    await setMode("READ_ONLY");
    expect(await processWriteBack((await rowFor(f.id))!.id, fakeShopify({}).clients)).toBe("REFUSED");
    expect(
      await db().fulfillmentEvent.findFirst({ where: { fulfillmentId: f.id, source: "shopify.writeback" } }),
    ).toMatchObject({ rawStatus: "refused" });
    await setMode("LIVE");
  });
});
