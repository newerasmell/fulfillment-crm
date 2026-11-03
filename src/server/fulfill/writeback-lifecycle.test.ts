import { beforeAll, describe, expect, it, vi } from "vitest";
import { ShopifyClient, type ShopifyClientOptions } from "@/integrations/shopify/client";
import {
  FULFILLMENT_EVENT_CREATE_MUTATION,
  FULFILLMENT_TRACKING_UPDATE_MUTATION,
  shopifyTrackingCompany,
  WRITE_BACK_STATE_QUERY,
  type WriteBackRead,
} from "@/integrations/shopify/fulfillments";
import { estimateQueryCost } from "@/integrations/shopify/query-cost";
import { TokenProvider } from "@/integrations/shopify/token";
import type { CrmOrderStatus } from "@/generated/prisma/client";
import { systemDb } from "@/server/db/client";
import { euTestGroup, euTestOrder } from "@/server/eushipments/test-fixtures";
import {
  dependentRowsDue,
  orderWriteBacks,
  processWriteBack,
  sweepWriteBacks,
  type StoreClientFactory,
} from "./writeback";

// The Shopify lifecycle per shipment (owner request 2026-11-03): FULFIL → TRACKING → EVENT. Mocked Shopify only
// (no network), synthetic ids.

const ORDER_GID = "gid://shopify/Order/9500001";
const LINE_GID = "gid://shopify/LineItem/9510001";
const FO_GID = "gid://shopify/FulfillmentOrder/9520001";
const FOLI_GID = "gid://shopify/FulfillmentOrderLineItem/9530001";
const FUL_GID = "gid://shopify/Fulfillment/9540001";

type Handler = (vars: Record<string, unknown>) => unknown;

function fakeShopify(routes: Record<string, Handler | Handler[]>, notifyCustomer = true) {
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
      "lifecycle-test.myshopify.com",
      { clientId: "client-id-0002", clientSecret: "not-a-real-secret-0002" },
      { fetchImpl, tokens, sleep: async () => {}, ...opts },
    ),
    store: { notifyCustomer },
  });
  const count = (op: string) => ops.filter((o) => o.op === op).length;
  const varsOf = (op: string) => ops.filter((o) => o.op === op).map((o) => o.vars);
  return { ops, clients, count, varsOf };
}

type Ful = NonNullable<WriteBackRead["order"]>["fulfillments"][number];
const orderRead = (fulfillments: Ful[] = [], remaining = 2) => ({
  order: {
    id: ORDER_GID,
    fulfillments,
    fulfillmentOrders: {
      nodes: [
        {
          id: FO_GID,
          status: remaining > 0 ? "OPEN" : "CLOSED",
          supportedActions: [{ action: "CREATE_FULFILLMENT" }],
          assignedLocation: { location: { id: "gid://shopify/Location/1" } },
          lineItems: { nodes: [{ id: FOLI_GID, remainingQuantity: remaining, lineItem: { id: LINE_GID } }] },
        },
      ],
    },
  },
});
const state = (
  over: {
    id?: string;
    status?: string;
    tracking?: string[];
    events?: string[];
    lines?: { id: string; q: number }[];
  } = {},
) => ({
  fulfillment: {
    id: over.id ?? FUL_GID,
    status: over.status ?? "SUCCESS",
    trackingInfo: (over.tracking ?? []).map((n) => ({ number: n, company: null, url: null })),
    fulfillmentLineItems: {
      nodes: (over.lines ?? [{ id: LINE_GID, q: 2 }]).map((l) => ({ quantity: l.q, lineItem: { id: l.id } })),
    },
    events: {
      nodes: (over.events ?? []).map((s, i) => ({ id: `gid://shopify/FulfillmentEvent/${i}`, status: s })),
    },
  },
});
const created = (id = FUL_GID) => ({
  fulfillmentCreate: { fulfillment: { id, status: "SUCCESS" }, userErrors: [] },
});
const trackingOk = () => ({
  fulfillmentTrackingInfoUpdate: { fulfillment: { id: FUL_GID, status: "SUCCESS" }, userErrors: [] },
});
const eventOk = (vars: Record<string, unknown>) => ({
  fulfillmentEventCreate: {
    fulfillmentEvent: {
      id: "gid://shopify/FulfillmentEvent/77",
      status: (vars.fulfillmentEvent as { status: string }).status,
    },
    userErrors: [],
  },
});
const lost = () => new Response("bad gateway", { status: 502 });

describe("lifecycle rules (pure)", () => {
  const fulfil = (trackingNumber: string | null) => ({ kind: "FULFIL" as const, value: "", trackingNumber });
  it("no FULFIL row yet: nothing follows", () => {
    expect(dependentRowsDue("SHIPPED", ["T1"], [])).toEqual([]);
  });
  it("tracking: a new number after a fulfilment without tracking, a changed number, never one already written", () => {
    expect(dependentRowsDue("ACCEPTED", ["T1"], [fulfil(null)])).toEqual([{ kind: "TRACKING", value: "T1" }]);
    expect(dependentRowsDue("ACCEPTED", ["T1"], [fulfil("T1")])).toEqual([]);
    expect(dependentRowsDue("ACCEPTED", ["T2"], [fulfil("T1")])).toEqual([{ kind: "TRACKING", value: "T2" }]);
    expect(
      dependentRowsDue(
        "ACCEPTED",
        ["T2"],
        [fulfil("T1"), { kind: "TRACKING", value: "T2", trackingNumber: "T2" }],
      ),
    ).toEqual([]);
  });
  it("events: one per status, in order, nothing after a final one", () => {
    const ev = (value: string) => ({ kind: "EVENT" as const, value, trackingNumber: null });
    expect(dependentRowsDue("SHIPPED", ["T1"], [fulfil("T1")])).toEqual([
      { kind: "EVENT", value: "IN_TRANSIT" },
    ]);
    expect(dependentRowsDue("SHIPPED", ["T1"], [fulfil("T1"), ev("IN_TRANSIT")])).toEqual([]);
    expect(dependentRowsDue("DELIVERED", ["T1"], [fulfil("T1"), ev("IN_TRANSIT")])).toEqual([
      { kind: "EVENT", value: "DELIVERED" },
    ]);
    expect(dependentRowsDue("COD_PAID", ["T1"], [fulfil("T1"), ev("DELIVERED")])).toEqual([]);
    // No "in transit" after "delivered", no "failure" after "delivered" (a later customer return).
    expect(dependentRowsDue("SHIPPED", ["T1"], [fulfil("T1"), ev("DELIVERED")])).toEqual([]);
    expect(dependentRowsDue("RETURNING", ["T1"], [fulfil("T1"), ev("DELIVERED")])).toEqual([]);
    expect(dependentRowsDue("EXCEPTION", ["T1"], [fulfil("T1"), ev("IN_TRANSIT")])).toEqual([
      { kind: "EVENT", value: "FAILURE" },
    ]);
    expect(dependentRowsDue("ACCEPTED", [], [fulfil(null)])).toEqual([]);
  });
  it("tracking company: Shopify's documented spelling when known, else our name", () => {
    expect(shopifyTrackingCompany("speedy")).toBe("Speedy");
    expect(shopifyTrackingCompany(" gls ")).toBe("GLS");
    expect(shopifyTrackingCompany("Local Courier")).toBe("Local Courier");
    expect(shopifyTrackingCompany(null)).toBeNull();
  });
  it("the fulfillment read-back query stays well under Shopify's cost limit", () => {
    expect(estimateQueryCost(WRITE_BACK_STATE_QUERY)).toBeLessThan(1000);
  });
});

describe("Shopify write-back lifecycle (DB, mocked Shopify)", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  let n = 8000;
  const db = () => systemDb();

  async function shipment(status: CrmOrderStatus, tracking: string[] = []) {
    const { order } = await euTestOrder(g, { number: `#${++n}` });
    await db().order.update({
      where: { id: order.id },
      data: { status, shopifyOrderGid: `${ORDER_GID}${n}` },
    });
    const line = await db().orderLine.findFirstOrThrow({ where: { orderId: order.id } });
    await db().orderLine.update({ where: { id: line.id }, data: { shopifyLineGid: LINE_GID } });
    const f = await db().fulfillment.create({
      data: {
        accountId: g.accountId,
        orderId: order.id,
        connectionId: g.connection.id,
        externalId: `LC-${n}`,
        status,
        carrier: "speedy",
        trackingNumbers: tracking,
        trackingUrls: tracking.map((t) => `https://track.example/${t}`),
        shippedAt: status === "SHIPPED" ? new Date() : null,
        lines: { create: [{ orderLineId: line.id, quantity: 2 }] },
      },
    });
    return { order, f };
  }
  const setStore = (data: {
    writeBackMode?: "READ_ONLY" | "DRY_RUN" | "LIVE";
    fulfilTrigger?: "ON_TRACKING" | "ON_ACCEPT";
  }) => db().store.update({ where: { id: g.store.id }, data });
  const rows = (fulfillmentId: string) =>
    db().shopifyWriteBack.findMany({
      where: { fulfillmentId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  const row = async (fulfillmentId: string, kind: "FULFIL" | "TRACKING" | "EVENT", value?: string) =>
    (await db().shopifyWriteBack.findFirst({
      where: { fulfillmentId, kind, ...(value !== undefined ? { value } : {}) },
    }))!;
  const move = (id: string, status: CrmOrderStatus, tracking?: string[]) =>
    db().fulfillment.update({
      where: { id },
      data: {
        status,
        ...(tracking
          ? { trackingNumbers: tracking, trackingUrls: tracking.map((t) => `https://track.example/${t}`) }
          : {}),
        ...(status === "DELIVERED" ? { deliveredAt: new Date() } : {}),
      },
    });

  beforeAll(async () => {
    g = await euTestGroup("wb-lifecycle");
  });

  it("ON_TRACKING (default): an accepted shipment without tracking writes nothing", async () => {
    await setStore({ writeBackMode: "LIVE", fulfilTrigger: "ON_TRACKING" });
    const { f } = await shipment("ACCEPTED");
    await sweepWriteBacks();
    expect(await rows(f.id)).toEqual([]);
  });

  it("ON_ACCEPT, LIVE: fulfil without tracking (no e-mail) → tracking update → in transit → delivered, each once", async () => {
    await setStore({ writeBackMode: "LIVE", fulfilTrigger: "ON_ACCEPT" });
    const { f, order } = await shipment("ACCEPTED");
    await sweepWriteBacks();
    expect((await rows(f.id)).map((r) => [r.kind, r.value, r.trackingNumber])).toEqual([
      ["FULFIL", "", null],
    ]);

    const shop = fakeShopify({
      FulfillmentWriteBackRead: () => orderRead(),
      FulfillmentWriteBack: () => created(),
      FulfillmentWriteBackState: () => state(),
      FulfillmentTrackingWriteBack: trackingOk,
      FulfillmentEventWriteBack: eventOk,
    });
    const fulfilRow = await row(f.id, "FULFIL");
    expect(await processWriteBack(fulfilRow.id, shop.clients)).toBe("SENT");
    expect(shop.varsOf("FulfillmentWriteBack")[0]).toEqual({
      fulfillment: {
        lineItemsByFulfillmentOrder: [
          { fulfillmentOrderId: FO_GID, fulfillmentOrderLineItems: [{ id: FOLI_GID, quantity: 2 }] },
        ],
        notifyCustomer: false,
      },
    });
    expect((await row(f.id, "FULFIL")).shopifyFulfillmentGid).toBe(FUL_GID);

    // The warehouse ships it with a tracking number: TRACKING + IN_TRANSIT rows, both sent to our fulfillment.
    await move(f.id, "SHIPPED", ["TRK-A"]);
    await sweepWriteBacks();
    await sweepWriteBacks(); // a second sweep adds nothing
    expect((await rows(f.id)).map((r) => [r.kind, r.value])).toEqual([
      ["FULFIL", ""],
      ["TRACKING", "TRK-A"],
      ["EVENT", "IN_TRANSIT"],
    ]);
    expect(await processWriteBack((await row(f.id, "TRACKING")).id, shop.clients)).toBe("SENT");
    expect(shop.varsOf("FulfillmentTrackingWriteBack")).toEqual([
      {
        fulfillmentId: FUL_GID,
        trackingInfoInput: { number: "TRK-A", company: "Speedy", url: "https://track.example/TRK-A" },
        notifyCustomer: true,
      },
    ]);
    expect(await processWriteBack((await row(f.id, "EVENT", "IN_TRANSIT")).id, shop.clients)).toBe("SENT");
    const ev = shop.varsOf("FulfillmentEventWriteBack")[0]!.fulfillmentEvent as Record<string, unknown>;
    expect(ev).toMatchObject({ fulfillmentId: FUL_GID, status: "IN_TRANSIT" });

    await move(f.id, "DELIVERED");
    await sweepWriteBacks();
    expect(await processWriteBack((await row(f.id, "EVENT", "DELIVERED")).id, shop.clients)).toBe("SENT");
    // Back to SHIPPED (a late vendor status) or a return afterwards: nothing more.
    await move(f.id, "RETURNING");
    await sweepWriteBacks();
    expect((await rows(f.id)).map((r) => r.value)).toEqual(["", "TRK-A", "IN_TRANSIT", "DELIVERED"]);
    expect(shop.count("FulfillmentWriteBack")).toBe(1);
    expect(shop.count("FulfillmentEventWriteBack")).toBe(2);
    // The order page lists every write with its kind and result.
    const list = await orderWriteBacks(g.accountId, order.id);
    expect(list.map((w) => [w.kind, w.status])).toEqual([
      ["FULFIL", "SENT"],
      ["TRACKING", "SENT"],
      ["EVENT", "SENT"],
      ["EVENT", "SENT"],
    ]);
  });

  it("ON_ACCEPT with tracking already there: fulfilled with tracking and the store's notify setting", async () => {
    await setStore({ writeBackMode: "LIVE", fulfilTrigger: "ON_ACCEPT" });
    const { f } = await shipment("ACCEPTED", ["TRK-B"]);
    await sweepWriteBacks();
    const shop = fakeShopify({
      FulfillmentWriteBackRead: () => orderRead(),
      FulfillmentWriteBack: () => created(),
    });
    expect(await processWriteBack((await row(f.id, "FULFIL")).id, shop.clients)).toBe("SENT");
    expect(shop.varsOf("FulfillmentWriteBack")[0]).toMatchObject({
      fulfillment: { notifyCustomer: true, trackingInfo: { number: "TRK-B", company: "Speedy" } },
    });
    // No TRACKING row for the number the fulfilment already carried.
    await sweepWriteBacks();
    expect((await rows(f.id)).filter((r) => r.kind === "TRACKING")).toEqual([]);
  });

  it("fulfil without tracking, lost answer: the read-back finds ours by its lines (SENT), never a second create", async () => {
    await setStore({ writeBackMode: "LIVE", fulfilTrigger: "ON_ACCEPT" });
    const other: Ful = { id: "gid://shopify/Fulfillment/1", status: "SUCCESS", trackingInfo: [] };
    const ours: Ful = { id: FUL_GID, status: "SUCCESS", trackingInfo: [] };

    // a: created, the answer lost → found right away.
    const a = await shipment("ACCEPTED");
    await sweepWriteBacks();
    const shopA = fakeShopify({
      FulfillmentWriteBackRead: [() => orderRead([other]), () => orderRead([other, ours], 0)],
      FulfillmentWriteBack: lost,
      FulfillmentWriteBackState: (v) => (v.id === FUL_GID ? state() : state({ id: other.id, lines: [] })),
    });
    expect(await processWriteBack((await row(a.f.id, "FULFIL")).id, shopA.clients)).toBe("SENT");
    expect(shopA.count("FulfillmentWriteBack")).toBe(1);
    expect((await row(a.f.id, "FULFIL")).shopifyFulfillmentGid).toBe(FUL_GID);

    // b: lost answer, not visible yet → retried later; the retry's read-back sees it → SENT, no second create.
    const b = await shipment("ACCEPTED");
    await sweepWriteBacks();
    const shopB = fakeShopify({
      FulfillmentWriteBackRead: [
        () => orderRead([other]),
        () => orderRead([other]),
        () => orderRead([other, ours], 0),
      ],
      FulfillmentWriteBack: lost,
      FulfillmentWriteBackState: (v) => (v.id === FUL_GID ? state() : state({ id: other.id, lines: [] })),
    });
    const rb = await row(b.f.id, "FULFIL");
    expect(await processWriteBack(rb.id, shopB.clients)).toBe("PENDING");
    expect((await row(b.f.id, "FULFIL")).request).toMatchObject({
      readBack: { knownFulfillmentIds: [other.id], lines: [{ lineItemId: LINE_GID, quantity: 2 }] },
    });
    const later = new Date(Date.now() + 2 * 60 * 60_000);
    expect(await processWriteBack(rb.id, shopB.clients, later)).toBe("SENT");
    expect(shopB.count("FulfillmentWriteBack")).toBe(1);
  });

  it("tracking changes later: one update per value; DRY_RUN records the exact payload", async () => {
    await setStore({ writeBackMode: "LIVE", fulfilTrigger: "ON_TRACKING" });
    const { f } = await shipment("SHIPPED", ["TRK-1"]);
    await sweepWriteBacks();
    const shop = fakeShopify({
      FulfillmentWriteBackRead: () => orderRead(),
      FulfillmentWriteBack: () => created(),
    });
    expect(await processWriteBack((await row(f.id, "FULFIL")).id, shop.clients)).toBe("SENT");
    await move(f.id, "SHIPPED", ["TRK-2"]);
    await setStore({ writeBackMode: "DRY_RUN" });
    await sweepWriteBacks();
    await sweepWriteBacks();
    expect((await rows(f.id)).filter((r) => r.kind === "TRACKING").map((r) => r.value)).toEqual(["TRK-2"]);
    const dry = fakeShopify({}, false);
    const tr = await row(f.id, "TRACKING");
    expect(await processWriteBack(tr.id, dry.clients)).toBe("DRY_RUN_RECORDED");
    expect(dry.ops).toEqual([]);
    expect((await row(f.id, "TRACKING")).request).toEqual({
      mutation: FULFILLMENT_TRACKING_UPDATE_MUTATION,
      variables: {
        fulfillmentId: FUL_GID,
        trackingInfoInput: { number: "TRK-2", company: "Speedy", url: "https://track.example/TRK-2" },
        notifyCustomer: false,
      },
    });
    // LIVE again: re-armed, the read-back shows the number is already there (set by hand) → SENT, nothing sent.
    await setStore({ writeBackMode: "LIVE" });
    await sweepWriteBacks();
    const live = fakeShopify({ FulfillmentWriteBackState: () => state({ tracking: ["TRK-2"] }) });
    expect(await processWriteBack(tr.id, live.clients)).toBe("SENT");
    expect(live.count("FulfillmentTrackingWriteBack")).toBe(0);
  });

  it("LIVE: TRACKING / EVENT wait for their fulfilment, and are refused when it never reaches Shopify", async () => {
    await setStore({ writeBackMode: "LIVE", fulfilTrigger: "ON_ACCEPT" });
    const { f } = await shipment("ACCEPTED");
    await sweepWriteBacks();
    await move(f.id, "SHIPPED", ["TRK-W"]);
    await sweepWriteBacks();
    const shop = fakeShopify({});
    const ev = await row(f.id, "EVENT", "IN_TRANSIT");
    expect(await processWriteBack(ev.id, shop.clients)).toBe("PENDING");
    expect((await row(f.id, "EVENT")).lastError).toBe("waiting_for_earlier_write");
    expect((await row(f.id, "EVENT")).attempts).toBe(0);
    expect(shop.ops).toEqual([]);
    await db().shopifyWriteBack.update({
      where: { id: (await row(f.id, "FULFIL")).id },
      data: { status: "FAILED", lastError: "nothing_to_fulfil" },
    });
    const later = new Date(Date.now() + 10 * 60_000);
    expect(await processWriteBack(ev.id, shop.clients, later)).toBe("REFUSED");
    expect((await row(f.id, "EVENT")).lastError).toBe("fulfillment_not_in_shopify");
    expect(shop.ops).toEqual([]);
  });

  it("events: already in Shopify → SENT without sending; a later final status there → never an earlier one", async () => {
    await setStore({ writeBackMode: "LIVE", fulfilTrigger: "ON_TRACKING" });
    const a = await shipment("SHIPPED", ["TRK-E1"]);
    const b = await shipment("SHIPPED", ["TRK-E2"]);
    await sweepWriteBacks();
    const create = fakeShopify({
      FulfillmentWriteBackRead: () => orderRead(),
      FulfillmentWriteBack: () => created(),
    });
    for (const x of [a, b])
      expect(await processWriteBack((await row(x.f.id, "FULFIL")).id, create.clients)).toBe("SENT");
    const shopA = fakeShopify({ FulfillmentWriteBackState: () => state({ events: ["IN_TRANSIT"] }) });
    expect(await processWriteBack((await row(a.f.id, "EVENT")).id, shopA.clients)).toBe("SENT");
    expect(shopA.count("FulfillmentEventWriteBack")).toBe(0);
    const shopB = fakeShopify({ FulfillmentWriteBackState: () => state({ events: ["DELIVERED"] }) });
    expect(await processWriteBack((await row(b.f.id, "EVENT")).id, shopB.clients)).toBe("REFUSED");
    expect((await row(b.f.id, "EVENT")).lastError).toBe("superseded_by_delivered");
    expect(shopB.count("FulfillmentEventWriteBack")).toBe(0);
  });

  it("event, lost answer: read-back shows it → SENT; read-back fails → UNCERTAIN + CRITICAL task, never retried", async () => {
    await setStore({ writeBackMode: "LIVE", fulfilTrigger: "ON_TRACKING" });
    const a = await shipment("SHIPPED", ["TRK-U1"]);
    const b = await shipment("SHIPPED", ["TRK-U2"]);
    await sweepWriteBacks();
    const create = fakeShopify({
      FulfillmentWriteBackRead: () => orderRead(),
      FulfillmentWriteBack: () => created(),
    });
    for (const x of [a, b])
      expect(await processWriteBack((await row(x.f.id, "FULFIL")).id, create.clients)).toBe("SENT");
    const shopA = fakeShopify({
      FulfillmentWriteBackState: [() => state(), () => state({ events: ["IN_TRANSIT"] })],
      FulfillmentEventWriteBack: lost,
    });
    expect(await processWriteBack((await row(a.f.id, "EVENT")).id, shopA.clients)).toBe("SENT");
    expect(shopA.count("FulfillmentEventWriteBack")).toBe(1);
    const shopB = fakeShopify({
      FulfillmentWriteBackState: [() => state(), () => new Response("down", { status: 503 })],
      FulfillmentEventWriteBack: lost,
    });
    const rb = await row(b.f.id, "EVENT");
    expect(await processWriteBack(rb.id, shopB.clients)).toBe("UNCERTAIN");
    expect(
      await db().alert.findFirst({ where: { entityId: b.order.id, kind: "shopify_writeback_uncertain" } }),
    ).toMatchObject({ severity: "CRITICAL", isTask: true });
    expect(await processWriteBack(rb.id, shopB.clients, new Date(Date.now() + 86_400_000))).toBe("skipped");
    expect(shopB.count("FulfillmentEventWriteBack")).toBe(1);
  });

  it("each kind × mode: READ_ONLY refuses without a call; DRY_RUN records the event payload (no fulfillment yet)", async () => {
    await setStore({ writeBackMode: "DRY_RUN", fulfilTrigger: "ON_TRACKING" });
    const { f } = await shipment("SHIPPED", ["TRK-M"]);
    await sweepWriteBacks();
    const dry = fakeShopify({ FulfillmentWriteBackRead: () => orderRead() });
    expect(await processWriteBack((await row(f.id, "FULFIL")).id, dry.clients)).toBe("DRY_RUN_RECORDED");
    expect(await processWriteBack((await row(f.id, "EVENT")).id, dry.clients)).toBe("DRY_RUN_RECORDED");
    expect(dry.ops.map((o) => o.op)).toEqual(["FulfillmentWriteBackRead"]);
    expect((await row(f.id, "EVENT")).request).toMatchObject({
      mutation: FULFILLMENT_EVENT_CREATE_MUTATION,
      variables: {
        fulfillmentEvent: { status: "IN_TRANSIT", fulfillmentId: expect.stringContaining("FULFIL") },
      },
    });
    // A new tracking number while READ_ONLY: no rows at all; a row created before is refused at send time.
    await move(f.id, "SHIPPED", ["TRK-M2"]);
    await sweepWriteBacks();
    await setStore({ writeBackMode: "READ_ONLY" });
    const none = fakeShopify({});
    expect(await processWriteBack((await row(f.id, "TRACKING")).id, none.clients)).toBe("REFUSED");
    expect((await row(f.id, "TRACKING")).lastError).toBe("store_read_only");
    await move(f.id, "DELIVERED");
    await sweepWriteBacks();
    expect(await db().shopifyWriteBack.count({ where: { fulfillmentId: f.id, value: "DELIVERED" } })).toBe(0);
    expect(none.ops).toEqual([]);
    await setStore({ writeBackMode: "LIVE" });
  });

  it("a cancelled or re-routed shipment never writes", async () => {
    await setStore({ writeBackMode: "LIVE", fulfilTrigger: "ON_ACCEPT" });
    const cancelled = await shipment("CANCELLED", ["TRK-C"]);
    const rerouted = await shipment("ACCEPTED");
    await db().orderReroute.create({
      data: {
        accountId: g.accountId,
        orderId: rerouted.order.id,
        fromFulfillmentId: rerouted.f.id,
        fromConnectionId: g.connection.id,
        toConnectionId: g.connection.id,
        reasonCode: "test",
      },
    });
    const later = await shipment("SHIPPED", ["TRK-L"]);
    await sweepWriteBacks();
    expect(await rows(cancelled.f.id)).toEqual([]);
    expect(await rows(rerouted.f.id)).toEqual([]);
    // Cancelled after its rows were created: refused at send time, nothing read or sent.
    await move(later.f.id, "CANCELLED");
    const shop = fakeShopify({});
    for (const r of await rows(later.f.id)) {
      expect(await processWriteBack(r.id, shop.clients)).toBe("REFUSED");
      expect((await db().shopifyWriteBack.findUniqueOrThrow({ where: { id: r.id } })).lastError).toBe(
        "shipment_cancelled",
      );
    }
    expect(shop.ops).toEqual([]);
  });

  it("two processWriteBack calls at once on a TRACKING row: exactly one update", async () => {
    await setStore({ writeBackMode: "LIVE", fulfilTrigger: "ON_TRACKING" });
    const { f } = await shipment("SHIPPED", ["TRK-P1"]);
    await sweepWriteBacks();
    const create = fakeShopify({
      FulfillmentWriteBackRead: () => orderRead(),
      FulfillmentWriteBack: () => created(),
    });
    expect(await processWriteBack((await row(f.id, "FULFIL")).id, create.clients)).toBe("SENT");
    await move(f.id, "SHIPPED", ["TRK-P2"]);
    await sweepWriteBacks();
    const shop = fakeShopify({
      FulfillmentWriteBackState: () => state(),
      FulfillmentTrackingWriteBack: trackingOk,
    });
    const tr = await row(f.id, "TRACKING");
    const rs = await Promise.all([
      processWriteBack(tr.id, shop.clients),
      processWriteBack(tr.id, shop.clients),
    ]);
    expect(rs.sort()).toEqual(["SENT", "skipped"]);
    expect(shop.count("FulfillmentTrackingWriteBack")).toBe(1);
  });

  it("tenant scope: another account sees none of these writes", async () => {
    const other = await euTestGroup("wb-lifecycle-other");
    const { order } = await shipment("SHIPPED", ["TRK-S"]);
    await sweepWriteBacks();
    expect((await orderWriteBacks(g.accountId, order.id)).length).toBeGreaterThan(0);
    expect(await orderWriteBacks(other.accountId, order.id)).toEqual([]);
  });
});
