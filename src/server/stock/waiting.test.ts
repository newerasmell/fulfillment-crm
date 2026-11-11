import { beforeAll, describe, expect, it } from "vitest";
import type { ShopifyClient } from "@/integrations/shopify/client";
import { ShopifyError } from "@/integrations/shopify/errors";
import { SYNTHETIC_ORDERS } from "@/integrations/shopify/__fixtures__/orders";
import type { ShopifyOrder } from "@/integrations/shopify/orders";
import { euTestGroup } from "@/server/eushipments/test-fixtures";
import { hasStoreTag } from "@/server/shopify/order-tag-match";
import { importShopifyOrder } from "@/server/shopify/orders";
import { applyTagChange, tagDelta } from "@/integrations/shopify/order-tags";
import { ForbiddenError } from "@/server/auth/rbac";
import { bootstrapOwner } from "@/server/auth/users";
import { accountDb, systemDb, withAccountTransaction } from "@/server/db/client";
import type { StoreClientFactory } from "@/server/fulfill/writeback";
import { processTagWrite, sweepTagWrites } from "@/server/shopify/tag-write";
import type { ScopedActor } from "@/server/stores";
import {
  allocateStockWaits,
  decideStockWait,
  discoverStockWaits,
  setOutOfStockAutoTag,
  evaluateStockWaits,
  outOfStockAutoTagStores,
  stockWaitOverview,
  stockWaitStage,
  stockWaitState,
  syncStockWait,
} from "./waiting";

// Synthetic data only; Shopify is mocked (no network).

describe("missing-stock flow (pure)", () => {
  it("stage from tags: case-insensitive, waiting_for_stock wins", () => {
    expect(stockWaitStage(["vip", "Out_Of_Stock"])).toBe("out_of_stock");
    expect(stockWaitStage(["out_of_stock", "WAITING_FOR_STOCK"])).toBe("waiting_for_stock");
    expect(stockWaitStage(["Confirmed"])).toBeNull();
    // Typed by a person in Shopify (owner report 2026-11-11): spaces / hyphens / case do not matter.
    expect(stockWaitStage(["Waiting for stock"])).toBe("waiting_for_stock");
    expect(stockWaitStage(["out-of-stock"])).toBe("out_of_stock");
    expect(stockWaitStage(["out of stockings"])).toBeNull();
    // One comparison everywhere: the store's confirmation tag gate agrees with the tag writer.
    expect(hasStoreTag(["Ready to ship"], "ready_to_ship")).toBe(true);
    expect(tagDelta(["Ready to ship"], ["ready_to_ship"], [])).toEqual({ remove: [], add: [] });
  });

  it("units go to the oldest order first, all lines from ONE warehouse", () => {
    const pool = new Map([
      ["W1:A", 1],
      ["W1:B", 1],
      ["W2:A", 1],
    ]);
    const lines = (id: string) => [
      { lineId: `${id}-a`, productId: "A", quantity: 1 },
      { lineId: `${id}-b`, productId: "B", quantity: 1 },
    ];
    const r = allocateStockWaits(
      [
        { orderId: "new", placedAt: new Date(2000), lines: lines("new"), connectionIds: ["W1", "W2"] },
        { orderId: "old", placedAt: new Date(1000), lines: lines("old"), connectionIds: ["W1", "W2"] },
      ],
      pool,
    );
    // The older order takes W1's A and B: complete in one warehouse.
    expect(r[0]).toEqual({ orderId: "old", connectionId: "W1", full: true, covered: ["old-a", "old-b"] });
    // The newer one only finds A at W2 (W1 is empty now): partly covered, never both in different warehouses.
    expect(r[1]).toEqual({ orderId: "new", connectionId: "W2", full: false, covered: ["new-a"] });
    // Two lines of one product share the warehouse's units; a line without a product is never covered.
    const twice = allocateStockWaits(
      [
        {
          orderId: "x",
          placedAt: new Date(0),
          lines: [
            { lineId: "x1", productId: "A", quantity: 1 },
            { lineId: "x2", productId: "A", quantity: 1 },
            { lineId: "x3", productId: null, quantity: 1 },
          ],
          connectionIds: ["W1"],
        },
      ],
      new Map([["W1:A", 1]]),
    );
    expect(twice[0]).toMatchObject({ full: false, covered: ["x1"] });
  });

  it("state: out_of_stock stays; waiting → partial only for lines that were missing → ready", () => {
    expect(stockWaitState("out_of_stock", { full: false, covered: [] }, [])).toBe("OUT_OF_STOCK");
    // Everything came back before anyone switched it to waiting: ready to confirm, not stuck under "Липсват".
    expect(stockWaitState("out_of_stock", { full: true, covered: ["a"] }, [])).toBe("READY");
    expect(stockWaitState("waiting_for_stock", { full: false, covered: ["b"] }, ["a"])).toBe("WAITING");
    expect(stockWaitState("waiting_for_stock", { full: false, covered: ["a"] }, ["a", "c"])).toBe("PARTIAL");
    expect(stockWaitState("waiting_for_stock", { full: true, covered: ["a", "c"] }, ["a", "c"])).toBe(
      "READY",
    );
  });

  it("tag delta and our copy after a send compare case-insensitively", () => {
    expect(tagDelta(["Out_Of_Stock", "vip"], ["waiting_for_stock"], ["out_of_stock"])).toEqual({
      remove: ["Out_Of_Stock"],
      add: ["waiting_for_stock"],
    });
    expect(tagDelta(["confirmed"], ["Confirmed"], ["waiting_for_stock"])).toEqual({ remove: [], add: [] });
    expect(applyTagChange(["vip", "waiting_for_stock"], ["Confirmed"], ["WAITING_FOR_STOCK"])).toEqual([
      "vip",
      "Confirmed",
    ]);
  });
});

describe("missing-stock flow (database, mocked Shopify)", () => {
  let accountId: string;
  let owner: ScopedActor;
  let storeId: string;
  let fhbId: string;
  let euId: string;
  let companyId: string;
  const db = () => accountDb(accountId);
  let n = 0;

  /** Shopify of the test store: its order tags live here; tagsAdd / tagsRemove change them. */
  const shopTags = new Map<string, string[]>();
  let failWith: ShopifyError | null = null;
  const calls: { op: string; vars: Record<string, unknown> }[] = [];
  const client = {
    async query(doc: string, vars: Record<string, unknown>, schema: { parse: (x: unknown) => unknown }) {
      const op = /(?:query|mutation)\s+(\w+)/.exec(doc)![1]!;
      calls.push({ op, vars });
      if (failWith && op !== "OrderTagsRead") throw failWith;
      const id = vars.id as string;
      const tags = shopTags.get(id) ?? [];
      if (op === "OrderTagsRead") return schema.parse({ order: { id, tags } });
      const given = vars.tags as string[];
      if (op === "OrderTagsRemove") {
        shopTags.set(
          id,
          tags.filter((t) => !given.includes(t)),
        );
        return schema.parse({ tagsRemove: { userErrors: [] } });
      }
      if (op === "OrderTagsAdd") {
        shopTags.set(id, [...tags, ...given.filter((g) => !tags.includes(g))]);
        return schema.parse({ tagsAdd: { userErrors: [] } });
      }
      throw new Error(`unexpected ${op}`);
    },
  } as unknown as ShopifyClient;
  const clients: StoreClientFactory = async () => ({ client, store: { notifyCustomer: false } });

  async function product(sku: string) {
    return db().product.create({ data: { accountId, sku, name: `Синтетичен ${sku}` } });
  }
  async function stock(connectionId: string, productId: string, free: number) {
    const vp = await db().vendorProduct.findFirst({ where: { connectionId, productId } });
    if (vp) {
      await systemDb().stockLevel.update({
        where: { vendorProductId: vp.id },
        data: { physical: free, free, sellable: free, snapshotAt: new Date() },
      });
      return;
    }
    await db().vendorProduct.create({
      data: {
        accountId,
        connectionId,
        productId,
        vendorId: `V-${connectionId.slice(-4)}-${productId.slice(-6)}`,
        raw: { type: "single" },
        stockLevel: {
          create: { physical: free, free, sellable: free, snapshotAt: new Date(), source: "PUSH" },
        },
      },
    });
  }
  /** A Shopify order of the test store with these tags (in Shopify and our copy), followed from now on. */
  async function order(tags: string[], lines: { productId: string | null; quantity: number }[], ageMin = 0) {
    const i = ++n;
    const gid = `gid://shopify/Order/77${i}`;
    shopTags.set(gid, [...tags]);
    const o = await db().order.create({
      data: {
        accountId,
        companyId,
        storeId,
        source: "SHOPIFY",
        shopifyOrderGid: gid,
        number: `#W-${i}`,
        status: "AWAITING_TAG",
        currency: "EUR",
        subtotal: 1,
        total: 1,
        paymentMethod: "COD",
        placedAt: new Date(Date.now() - ageMin * 60_000),
        tags,
        raw: { tags },
        lines: {
          create: lines.map((l, k) => ({
            productId: l.productId,
            title: `Line ${k}`,
            quantity: l.quantity,
            unitPrice: 1,
          })),
        },
      },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    await withAccountTransaction(accountId, (tx) => syncStockWait(tx, accountId, o.id));
    return o;
  }
  const row = (orderId: string) =>
    db().orderStockWait.findUnique({ where: { accountId_orderId: { accountId, orderId } } });
  const sendAll = async () => {
    const s = await sweepTagWrites();
    const out: string[] = [];
    for (const id of s.ready) {
      const w = await systemDb().shopifyTagWrite.findUnique({ where: { id } });
      if (w?.accountId === accountId) out.push(String(await processTagWrite(id, clients)));
    }
    return out;
  };
  const openTasks = (orderId: string, kind: string) =>
    db().alert.count({ where: { entityId: orderId, kind, status: { not: "RESOLVED" } } });

  beforeAll(async () => {
    const r = await bootstrapOwner({
      email: `wait-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
      name: "O",
      accountName: "Missing stock test",
      password: "correct horse battery staple",
    });
    accountId = r.account.id;
    owner = { userId: r.user.id, accountId, role: "OWNER", companyScope: null };
    const company = await systemDb().company.findFirstOrThrow({ where: { accountId } });
    companyId = company.id;
    const line = await db().productLine.create({ data: { accountId, name: "Textiles" } });
    await db().company.update({ where: { id: companyId }, data: { lineId: line.id } });
    fhbId = (
      await db().fulfillmentConnection.create({
        data: { accountId, companyId, type: "FHB_V3", name: "FHB syn", liveMode: "LIVE" },
      })
    ).id;
    euId = (
      await db().fulfillmentConnection.create({
        data: {
          accountId,
          companyId,
          type: "EUSHIPMENTS",
          name: "EU syn",
          liveMode: "LIVE",
          vendorIds: { companyId: 1 },
        },
      })
    ).id;
    storeId = (
      await db().store.create({
        data: {
          accountId,
          companyId,
          domain: `wait-${Date.now()}.myshopify.com`,
          code: "WT",
          name: "Store",
          currency: "EUR",
          writeBackMode: "LIVE",
          connectionStatus: { ok: true, scopes: ["read_orders", "write_orders"] },
        },
      })
    ).id;
    await db().storeOrderTag.create({ data: { accountId, storeId, tag: "Confirmed" } });
  });

  it("out_of_stock: expected only when the missing item is in an open inbound request; then → waiting_for_stock", async () => {
    const shirt = await product("W-SHIRT-M");
    const cap = await product("W-CAP");
    await stock(fhbId, shirt.id, 0);
    await stock(fhbId, cap.id, 5);
    const o = await order(
      ["Out_Of_Stock"],
      [
        { productId: shirt.id, quantity: 1 },
        { productId: cap.id, quantity: 1 },
      ],
    );
    expect((await row(o.id))!).toMatchObject({ stage: "out_of_stock", state: "OUT_OF_STOCK" });
    await evaluateStockWaits(accountId);
    expect((await row(o.id))!.expected).toBe(false);
    // Not expected: the action is refused (on the server, not only on the page).
    await expect(decideStockWait(owner, { action: "waiting", orderIds: [o.id] })).rejects.toMatchObject({
      code: "stock_wait_nothing_to_do",
    });
    // An open (not fully received) inbound request brings the shirt → expected.
    await db().inboundShipment.create({
      data: {
        accountId,
        connectionId: fhbId,
        externalRef: `IN-${Date.now()}`,
        status: "created",
        expectedAt: new Date(Date.now() + 86_400_000),
        lines: { create: [{ productId: shirt.id, expectedQty: 3, receivedQty: 0 }] },
      },
    });
    await evaluateStockWaits(accountId);
    const r = (await row(o.id))!;
    expect(r.expected).toBe(true);
    const detail = r.detail as { lines: { available: boolean; expected: unknown[] }[] };
    expect(detail.lines.map((l) => [l.available, l.expected.length])).toEqual([
      [false, 1],
      [true, 0],
    ]);
    const page = await stockWaitOverview(owner, "out");
    expect(page.count.out).toBeGreaterThanOrEqual(1);
    // The sidebar's product line: another line's companies see none of these.
    const otherLine = await stockWaitOverview({ ...owner, lineCompanyIds: ["no-such-company"] }, "out");
    expect(otherLine.count.out).toBe(0);
    expect(otherLine.rows).toHaveLength(0);
    expect((await stockWaitOverview({ ...owner, activeCompanyId: "no-such-company" }, "out")).count.out).toBe(
      0,
    );
    expect(await outOfStockAutoTagStores({ ...owner, lineCompanyIds: ["no-such-company"] })).toEqual([]);
    expect((await stockWaitOverview({ ...owner, lineCompanyIds: [companyId] }, "out")).count.out).toBe(
      page.count.out,
    );
    expect(page.rows.find((x) => x.orderId === o.id)?.canWriteTags).toBe(true);

    await expect(
      decideStockWait({ ...owner, role: "VIEWER" }, { action: "waiting", orderIds: [o.id] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // "Потвърди" is only for READY orders.
    await expect(decideStockWait(owner, { action: "confirm", orderIds: [o.id] })).rejects.toMatchObject({
      code: "stock_wait_nothing_to_do",
    });
    expect(await decideStockWait(owner, { action: "waiting", orderIds: [o.id] })).toEqual({
      queued: 1,
      skipped: 0,
    });
    // A second click while the change is on its way does nothing.
    await expect(decideStockWait(owner, { action: "waiting", orderIds: [o.id] })).rejects.toMatchObject({
      code: "stock_wait_nothing_to_do",
    });
    calls.length = 0;
    expect(await sendAll()).toEqual(["SENT"]);
    expect(calls.map((c) => [c.op, c.vars.tags])).toEqual([
      ["OrderTagsRead", undefined],
      ["OrderTagsAdd", ["waiting_for_stock"]],
      ["OrderTagsRemove", ["Out_Of_Stock"]],
    ]);
    expect(shopTags.get(o.shopifyOrderGid!)).toEqual(["waiting_for_stock"]);
    // Our copy follows; the order now waits, and only the shirt counts as missing.
    expect((await db().order.findUniqueOrThrow({ where: { id: o.id } })).tags).toEqual(["waiting_for_stock"]);
    await evaluateStockWaits(accountId);
    expect((await row(o.id))!).toMatchObject({
      stage: "waiting_for_stock",
      state: "WAITING",
      missingLineIds: [o.lines[0]!.id],
    });

    // The shirt is back: READY in FHB, a task; "Потвърди" sets Confirmed and the order leaves the flow.
    await stock(fhbId, shirt.id, 1);
    await evaluateStockWaits(accountId);
    expect((await row(o.id))!).toMatchObject({ state: "READY", readyConnectionId: fhbId });
    expect(await openTasks(o.id, "order_stock_ready")).toBe(1);
    await evaluateStockWaits(accountId); // notified once
    expect(await db().alert.count({ where: { entityId: o.id, kind: "order_stock_ready" } })).toBe(1);
    expect(await decideStockWait(owner, { action: "confirm", orderIds: [o.id] })).toMatchObject({
      queued: 1,
    });
    expect(await sendAll()).toEqual(["SENT"]);
    expect(shopTags.get(o.shopifyOrderGid!)).toEqual(["Confirmed"]);
    expect(await row(o.id)).toBeNull();
    expect(await openTasks(o.id, "order_stock_ready")).toBe(0);
  });

  it("oldest waiting order gets the units first; partial lines are reported, then ready", async () => {
    const a = await product("W-A");
    const b = await product("W-B");
    await stock(fhbId, a.id, 0);
    await stock(fhbId, b.id, 0);
    const old = await order(["waiting_for_stock"], [{ productId: a.id, quantity: 1 }], 60);
    const young = await order(["waiting_for_stock"], [{ productId: a.id, quantity: 1 }], 1);
    const both = await order(
      ["waiting_for_stock"],
      [
        { productId: a.id, quantity: 1 },
        { productId: b.id, quantity: 1 },
      ],
      0,
    );
    await evaluateStockWaits(accountId);
    for (const o of [old, young, both]) expect((await row(o.id))!.state).toBe("WAITING");

    await stock(fhbId, a.id, 1);
    await evaluateStockWaits(accountId);
    expect((await row(old.id))!.state).toBe("READY");
    expect((await row(young.id))!.state).toBe("WAITING");
    expect((await row(both.id))!.state).toBe("WAITING");

    // B arrives (one unit) and A has 2 more: young READY; "both" gets A at the same warehouse plus B → READY too.
    await stock(fhbId, a.id, 2);
    await stock(fhbId, b.id, 0);
    await evaluateStockWaits(accountId);
    expect((await row(young.id))!.state).toBe("READY");
    expect((await row(both.id))!.state).toBe("WAITING");
    await stock(fhbId, a.id, 3);
    await evaluateStockWaits(accountId);
    // A is back for "both", B is not: partly available, with a task.
    expect((await row(both.id))!.state).toBe("PARTIAL");
    expect(await openTasks(both.id, "order_stock_partial")).toBe(1);
    const page = await stockWaitOverview(owner, "partial");
    expect(page.rows.map((r) => r.orderId)).toContain(both.id);
    await stock(fhbId, b.id, 1);
    await evaluateStockWaits(accountId);
    expect((await row(both.id))!.state).toBe("READY");
    expect(await openTasks(both.id, "order_stock_partial")).toBe(0);
    expect(await openTasks(both.id, "order_stock_ready")).toBe(1);
    // In another warehouse only: not READY (a parcel leaves one warehouse).
    const c = await product("W-C");
    await stock(fhbId, c.id, 0);
    await stock(euId, c.id, 1);
    const split = await order(
      ["waiting_for_stock"],
      [
        { productId: a.id, quantity: 1 },
        { productId: c.id, quantity: 1 },
      ],
    );
    await stock(fhbId, a.id, 4);
    await evaluateStockWaits(accountId);
    const r = (await row(split.id))!;
    expect(r.state).not.toBe("READY");
    expect((r.detail as { lines: { available: boolean }[] }).lines.filter((l) => l.available)).toHaveLength(
      1,
    );
  });

  it("the tag removed in Shopify or the order cancelled: no longer followed; DRY_RUN / READ_ONLY / missing scope", async () => {
    const p = await product("W-D");
    await stock(fhbId, p.id, 0);
    const o = await order(["out_of_stock"], [{ productId: p.id, quantity: 1 }]);
    await db().order.update({ where: { id: o.id }, data: { status: "CANCELLED" } });
    await evaluateStockWaits(accountId);
    expect(await row(o.id)).toBeNull();

    const o2 = await order(["out_of_stock"], [{ productId: p.id, quantity: 1 }]);
    await db().inboundShipment.create({
      data: {
        accountId,
        connectionId: fhbId,
        externalRef: `IN2-${Date.now()}`,
        status: "created",
        lines: { create: [{ productId: p.id, expectedQty: 1 }] },
      },
    });
    await evaluateStockWaits(accountId);
    await db().store.update({ where: { id: storeId }, data: { writeBackMode: "DRY_RUN" } });
    await decideStockWait(owner, { action: "waiting", orderIds: [o2.id] });
    calls.length = 0;
    expect(await sendAll()).toEqual(["DRY_RUN_RECORDED"]);
    expect(calls).toHaveLength(0);
    const w = await db().shopifyTagWrite.findFirstOrThrow({ where: { orderId: o2.id } });
    expect(w.request).toMatchObject({ add: { variables: { tags: ["waiting_for_stock"] } } });
    expect((await row(o2.id))!.stage).toBe("out_of_stock");

    await db().store.update({ where: { id: storeId }, data: { writeBackMode: "READ_ONLY" } });
    await decideStockWait(owner, { action: "waiting", orderIds: [o2.id] });
    expect(await sendAll()).toEqual(["REFUSED"]);

    // The app lacks write_orders: Shopify refuses (ACCESS_DENIED) → FAILED with a task, never five retries.
    await db().store.update({ where: { id: storeId }, data: { writeBackMode: "LIVE" } });
    await decideStockWait(owner, { action: "waiting", orderIds: [o2.id] });
    failWith = new ShopifyError("graphql_error", "Access denied for tagsRemove", 200, ["ACCESS_DENIED"]);
    try {
      expect(await sendAll()).toEqual(["FAILED"]);
    } finally {
      failWith = null;
    }
    expect(await openTasks(o2.id, "shopify_tags_failed")).toBe(1);
    // A timeout is tried again later (the next attempt reads first).
    await decideStockWait(owner, { action: "waiting", orderIds: [o2.id] });
    failWith = new ShopifyError("http_error", "timeout", 504);
    try {
      expect(await sendAll()).toEqual(["PENDING"]);
    } finally {
      failWith = null;
    }

    // A person removes the tag in Shopify: the import's sync ends following it.
    await db().order.update({ where: { id: o2.id }, data: { tags: [], raw: { tags: [] } } });
    await withAccountTransaction(accountId, (tx) => syncStockWait(tx, accountId, o2.id));
    expect(await row(o2.id)).toBeNull();
  });

  it("out_of_stock with everything back → To confirm; store without a gate: only the flow tag is removed", async () => {
    const p = await product("W-E");
    await stock(fhbId, p.id, 2);
    const o = await order(["out_of_stock"], [{ productId: p.id, quantity: 1 }]);
    await evaluateStockWaits(accountId);
    expect((await row(o.id))!.state).toBe("READY");
    expect(await openTasks(o.id, "order_stock_ready")).toBe(1);
    // A unit taken for one run and given back does not notify again.
    await stock(fhbId, p.id, 0);
    await evaluateStockWaits(accountId);
    expect((await row(o.id))!.state).toBe("OUT_OF_STOCK");
    await stock(fhbId, p.id, 2);
    await evaluateStockWaits(accountId);
    expect(await db().alert.count({ where: { entityId: o.id, kind: "order_stock_ready" } })).toBe(1);

    await db().storeOrderTag.deleteMany({ where: { storeId } });
    try {
      await decideStockWait(owner, { action: "confirm", orderIds: [o.id] });
      const w = await db().shopifyTagWrite.findFirstOrThrow({ where: { orderId: o.id } });
      expect([w.add, w.remove]).toEqual([[], ["out_of_stock"]]);
      expect(await sendAll()).toEqual(["SENT"]);
      expect(shopTags.get(o.shopifyOrderGid!)).toEqual([]);
      expect(await row(o.id)).toBeNull();
    } finally {
      await db().storeOrderTag.create({ data: { accountId, storeId, tag: "Confirmed" } });
    }
  });

  it("sender: adds before it removes (a refused remove keeps both tags), one send for two workers, pause", async () => {
    const p = await product("W-F");
    await stock(fhbId, p.id, 3);
    const o = await order(["waiting_for_stock"], [{ productId: p.id, quantity: 1 }]);
    await evaluateStockWaits(accountId);
    await decideStockWait(owner, { action: "confirm", orderIds: [o.id] });
    const id = (await db().shopifyTagWrite.findFirstOrThrow({ where: { orderId: o.id } })).id;
    // Two workers on the same row: exactly one set of mutations.
    calls.length = 0;
    const both = await Promise.all([processTagWrite(id, clients), processTagWrite(id, clients)]);
    expect(both.filter((x) => x === "SENT")).toHaveLength(1);
    expect(calls.filter((c) => c.op === "OrderTagsAdd")).toHaveLength(1);

    const o2 = await order(["waiting_for_stock"], [{ productId: p.id, quantity: 1 }]);
    await evaluateStockWaits(accountId);
    await decideStockWait(owner, { action: "confirm", orderIds: [o2.id] });
    const realQuery = client.query.bind(client);
    (client as unknown as { query: typeof realQuery }).query = async (doc, vars, schema) => {
      if (/mutation OrderTagsRemove/.test(doc))
        return schema.parse({ tagsRemove: { userErrors: [{ field: ["tags"], message: "nope" }] } });
      return realQuery(doc, vars, schema);
    };
    try {
      expect(await sendAll()).toEqual(["FAILED"]);
    } finally {
      (client as unknown as { query: typeof realQuery }).query = realQuery;
    }
    // Confirmed reached Shopify, waiting_for_stock stayed: still followed, our copy shows both.
    expect(shopTags.get(o2.shopifyOrderGid!)).toEqual(["waiting_for_stock", "Confirmed"]);
    expect((await db().order.findUniqueOrThrow({ where: { id: o2.id } })).tags).toEqual([
      "waiting_for_stock",
      "Confirmed",
    ]);
    expect(await row(o2.id)).not.toBeNull();
    expect(await openTasks(o2.id, "shopify_tags_failed")).toBe(1);
    // Retried later and sent: the task is settled.
    await decideStockWait(owner, { action: "confirm", orderIds: [o2.id] });
    expect(await sendAll()).toEqual(["SENT"]);
    expect(await openTasks(o2.id, "shopify_tags_failed")).toBe(0);

    // Account kill switch: parked as PAUSED, sent once it is lifted.
    const o3 = await order(["waiting_for_stock"], [{ productId: p.id, quantity: 1 }]);
    await evaluateStockWaits(accountId);
    await decideStockWait(owner, { action: "confirm", orderIds: [o3.id] });
    await systemDb().account.update({ where: { id: accountId }, data: { outboxPaused: true } });
    try {
      expect(await sendAll()).toEqual(["PAUSED"]);
    } finally {
      await systemDb().account.update({ where: { id: accountId }, data: { outboxPaused: false } });
    }
    expect(await sendAll()).toEqual(["SENT"]);
  });

  it("another account never sees or changes these rows", async () => {
    const other = await bootstrapOwner({
      email: `wait-other-${Date.now()}@example.com`,
      name: "O",
      accountName: "Other",
      password: "correct horse battery staple",
    });
    const otherActor: ScopedActor = {
      userId: other.user.id,
      accountId: other.account.id,
      role: "OWNER",
      companyScope: null,
    };
    const mine = await db().orderStockWait.findFirstOrThrow({ select: { orderId: true } });
    expect((await stockWaitOverview(otherActor, "out")).count).toEqual({
      out: 0,
      waiting: 0,
      partial: 0,
      ready: 0,
    });
    expect(await accountDb(other.account.id).orderStockWait.count()).toBe(0);
    expect(await accountDb(other.account.id).shopifyTagWrite.count()).toBe(0);
    await expect(
      decideStockWait(otherActor, { action: "confirm", orderIds: [mine.orderId] }),
    ).rejects.toMatchObject({ code: "stock_wait_nothing_to_do" });
  });

  it("an order tagged before this existed (any spelling) is found; confirming a held one releases it", async () => {
    const p = await product("W-G");
    await stock(fhbId, p.id, 1);
    const gid = `gid://shopify/Order/7799${++n}`;
    shopTags.set(gid, ["Waiting for stock"]);
    const o = await db().order.create({
      data: {
        accountId,
        companyId,
        storeId,
        source: "SHOPIFY",
        shopifyOrderGid: gid,
        number: `#W-old-${n}`,
        status: "ON_HOLD",
        currency: "EUR",
        subtotal: 1,
        total: 1,
        paymentMethod: "COD",
        placedAt: new Date(Date.now() - 86_400_000),
        tags: ["Waiting for stock"],
        raw: { tags: ["Waiting for stock"] },
        lines: { create: [{ productId: p.id, title: "x", quantity: 1, unitPrice: 1 }] },
      },
    });
    expect(await row(o.id)).toBeNull();
    expect(await discoverStockWaits()).toBeGreaterThanOrEqual(1);
    expect((await row(o.id))!.stage).toBe("waiting_for_stock");
    await evaluateStockWaits(accountId);
    expect((await row(o.id))!.state).toBe("READY");
    await decideStockWait(owner, { action: "confirm", orderIds: [o.id] });
    // Still held until Shopify has the confirmation tag (the review gate needs it)…
    expect((await db().order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("ON_HOLD");
    expect(await sendAll()).toEqual(["SENT"]);
    // …then released into review in the name of the person who confirmed.
    expect((await db().order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("IMPORTED");
    const ev = await db().orderEvent.findFirst({
      where: { orderId: o.id, toStatus: "IMPORTED" },
      orderBy: { createdAt: "desc" },
    });
    expect(ev?.userId).toBe(owner.userId);
    // The person's spelling is what gets removed.
    expect(shopTags.get(gid)).toEqual(["Confirmed"]);
    expect(await row(o.id)).toBeNull();
  });

  it("automatic out_of_stock: new orders no warehouse can fill, once, only after it is switched on", async () => {
    const empty = await product("W-H0");
    const full = await product("W-H1");
    await stock(fhbId, empty.id, 0);
    await stock(fhbId, full.id, 5);
    const plain = (productId: string) =>
      db().order.create({
        data: {
          accountId,
          companyId,
          storeId,
          source: "SHOPIFY",
          shopifyOrderGid: `gid://shopify/Order/7788${++n}`,
          number: `#W-auto-${n}`,
          status: "AWAITING_TAG",
          currency: "EUR",
          subtotal: 1,
          total: 1,
          paymentMethod: "COD",
          placedAt: new Date(),
          tags: [],
          raw: { tags: [] },
          lines: { create: [{ productId, title: "x", quantity: 1, unitPrice: 1 }] },
        },
      });
    const before = await plain(empty.id);
    await expect(
      setOutOfStockAutoTag({ ...owner, role: "OPERATOR" }, { storeId, enabled: true }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await setOutOfStockAutoTag(owner, { storeId, enabled: true });
    try {
      const missing = await plain(empty.id);
      const fine = await plain(full.id);
      const r = await evaluateStockWaits(accountId);
      expect(r.tagged).toBe(1);
      const writes = await db().shopifyTagWrite.findMany({
        where: { orderId: { in: [before.id, missing.id, fine.id] } },
      });
      // Only the new order that cannot be filled; the one from before the switch is left alone.
      expect(writes.map((w) => [w.orderId, w.add])).toEqual([[missing.id, ["out_of_stock"]]]);
      expect((await evaluateStockWaits(accountId)).tagged).toBe(0); // once
      expect(await sendAll()).toContain("SENT");
      expect((await row(missing.id))!.stage).toBe("out_of_stock");
    } finally {
      await setOutOfStockAutoTag(owner, { storeId, enabled: false });
    }
  });

  it("automatic out_of_stock never tags an order its own units cover, nor on old numbers, empty or non-LIVE", async () => {
    const one = await product("W-I1");
    const stale = await product("W-I2");
    await stock(fhbId, one.id, 1);
    await stock(fhbId, stale.id, 0);
    // An older order waits for the same product: the new order keeps the unit it reserved (no double promise).
    const waiting = await order(["waiting_for_stock"], [{ productId: one.id, quantity: 1 }], 120);
    await setOutOfStockAutoTag(owner, { storeId, enabled: true });
    const mk = (lines: { productId: string; quantity: number }[]) =>
      db().order.create({
        data: {
          accountId,
          companyId,
          storeId,
          source: "SHOPIFY",
          shopifyOrderGid: `gid://shopify/Order/7766${++n}`,
          number: `#W-auto2-${n}`,
          status: "AWAITING_TAG",
          currency: "EUR",
          subtotal: 1,
          total: 1,
          paymentMethod: "COD",
          placedAt: new Date(),
          tags: [],
          raw: { tags: [] },
          lines: { create: lines.map((l) => ({ ...l, title: "x", unitPrice: 1 })) },
        },
      });
    try {
      const self = await mk([{ productId: one.id, quantity: 1 }]);
      const old = await mk([{ productId: stale.id, quantity: 1 }]);
      const none = await mk([]);
      // The warehouse numbers of `stale` are days old: a stopped sync must not tag.
      const vp = await db().vendorProduct.findFirstOrThrow({ where: { productId: stale.id } });
      await systemDb().stockLevel.update({
        where: { vendorProductId: vp.id },
        data: { snapshotAt: new Date(Date.now() - 30 * 86_400_000) },
      });
      expect((await evaluateStockWaits(accountId)).tagged).toBe(0);
      expect((await row(waiting.id))!.state).toBe("WAITING");
      // Fresh 0 at FHB, but euShipments' numbers are old (it may hold the units): not tagged either.
      const two = await product("W-I3");
      await stock(fhbId, two.id, 0);
      await stock(euId, two.id, 0);
      const euVp = await db().vendorProduct.findFirstOrThrow({
        where: { productId: two.id, connectionId: euId },
      });
      await systemDb().stockLevel.update({
        where: { vendorProductId: euVp.id },
        data: { snapshotAt: new Date(Date.now() - 30 * 86_400_000) },
      });
      const split = await mk([{ productId: two.id, quantity: 1 }]);
      expect((await evaluateStockWaits(accountId)).tagged).toBe(0);
      expect(await db().shopifyTagWrite.count({ where: { orderId: split.id } })).toBe(0);
      expect(
        await db().shopifyTagWrite.count({ where: { orderId: { in: [self.id, old.id, none.id] } } }),
      ).toBe(0);
      // Not written to Shopify (READ_ONLY): not looked at at all, so its one tag is never used up.
      await systemDb().stockLevel.update({
        where: { vendorProductId: vp.id },
        data: { snapshotAt: new Date() },
      });
      await db().store.update({ where: { id: storeId }, data: { writeBackMode: "READ_ONLY" } });
      expect((await evaluateStockWaits(accountId)).tagged).toBe(0);
      await db().store.update({ where: { id: storeId }, data: { writeBackMode: "LIVE" } });
      expect((await evaluateStockWaits(accountId)).tagged).toBe(1);
      expect((await db().shopifyTagWrite.findFirstOrThrow({ where: { orderId: old.id } })).add).toEqual([
        "out_of_stock",
      ]);
      await sendAll();
    } finally {
      await setOutOfStockAutoTag(owner, { storeId, enabled: false });
    }
  });

  it("automatic out_of_stock: new orders share the last unit oldest first; free 0 counts; one write per order", async () => {
    const last = await product("W-K1");
    const nofree = await product("W-K2");
    await stock(fhbId, last.id, 1);
    await stock(fhbId, nofree.id, 0);
    // The warehouse holds 3 of nofree, none free (e.g. all promised to accepted orders).
    const vp = await db().vendorProduct.findFirstOrThrow({ where: { productId: nofree.id } });
    await systemDb().stockLevel.update({ where: { vendorProductId: vp.id }, data: { physical: 3, free: 0 } });
    await setOutOfStockAutoTag(owner, { storeId, enabled: true });
    const mk = (productId: string, ageMin: number) =>
      db().order.create({
        data: {
          accountId,
          companyId,
          storeId,
          source: "SHOPIFY",
          shopifyOrderGid: `gid://shopify/Order/7755${++n}`,
          number: `#W-auto3-${n}`,
          status: "AWAITING_TAG",
          currency: "EUR",
          subtotal: 1,
          total: 1,
          paymentMethod: "COD",
          // After the switch-on (older ones are not "new"); ageMin only orders them.
          placedAt: new Date(Date.now() + 60_000 - ageMin * 1000),
          tags: [],
          raw: { tags: [] },
          lines: { create: [{ productId, title: "x", quantity: 1, unitPrice: 1 }] },
        },
      });
    try {
      const older = await mk(last.id, 10);
      const newer = await mk(last.id, 5);
      const free0 = await mk(nofree.id, 1);
      // Two runs at the same moment: one write per order.
      const runs = await Promise.all([evaluateStockWaits(accountId), evaluateStockWaits(accountId)]);
      expect(runs.reduce((n2, r) => n2 + r.tagged, 0)).toBe(2);
      const writes = await db().shopifyTagWrite.findMany({
        where: { orderId: { in: [older.id, newer.id, free0.id] } },
        select: { orderId: true },
      });
      expect(writes.map((w) => w.orderId).sort()).toEqual([newer.id, free0.id].sort());
      await sendAll();
    } finally {
      await setOutOfStockAutoTag(owner, { storeId, enabled: false });
    }
  });

  it("a release the pipeline refuses (Shopify test order) becomes a task", async () => {
    const p = await product("W-L");
    await stock(fhbId, p.id, 2);
    const gid = `gid://shopify/Order/7744${++n}`;
    shopTags.set(gid, ["Waiting for stock"]);
    const o = await db().order.create({
      data: {
        accountId,
        companyId,
        storeId,
        source: "SHOPIFY",
        shopifyOrderGid: gid,
        number: `#W-test-${n}`,
        status: "ON_HOLD",
        currency: "EUR",
        subtotal: 1,
        total: 1,
        paymentMethod: "COD",
        placedAt: new Date(Date.now() - 3_600_000),
        tags: ["Waiting for stock", "shopify-test"],
        raw: { tags: ["Waiting for stock"] },
        lines: { create: [{ productId: p.id, title: "x", quantity: 1, unitPrice: 1 }] },
      },
    });
    await withAccountTransaction(accountId, (tx) => syncStockWait(tx, accountId, o.id));
    await evaluateStockWaits(accountId);
    await decideStockWait(owner, { action: "confirm", orderIds: [o.id] });
    expect(await sendAll()).toEqual(["SENT"]);
    const after = await db().order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.status).toBe("ON_HOLD");
    // Our marker of a Shopify test order survives the tag change.
    expect(after.tags).toContain("shopify-test");
    expect(await openTasks(o.id, "stock_wait_release_refused")).toBe(1);
  });

  it("confirm releases only a hold older than the click; other accounts' stores are not found", async () => {
    const p = await product("W-J");
    await stock(fhbId, p.id, 2);
    const o = await order(["waiting_for_stock"], [{ productId: p.id, quantity: 1 }], 30);
    await evaluateStockWaits(accountId);
    expect((await row(o.id))!.state).toBe("READY");
    await decideStockWait(owner, { action: "confirm", orderIds: [o.id] });
    // Put on hold AFTER the click (for another reason): the confirmation does not release it.
    await db().order.update({ where: { id: o.id }, data: { status: "ON_HOLD" } });
    await db().orderEvent.create({
      data: {
        accountId,
        orderId: o.id,
        fromStatus: "AWAITING_TAG",
        toStatus: "ON_HOLD",
        cause: "hold",
        actorType: "user",
        userId: owner.userId,
        source: "test",
      },
    });
    expect(await sendAll()).toEqual(["SENT"]);
    expect((await db().order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("ON_HOLD");

    const other = await bootstrapOwner({
      email: `wait-o2-${Date.now()}@example.com`,
      name: "O",
      accountName: "Other 2",
      password: "correct horse battery staple",
    });
    await expect(
      setOutOfStockAutoTag(
        { userId: other.user.id, accountId: other.account.id, role: "OWNER", companyScope: null },
        { storeId, enabled: true },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("missing-stock flow: the Shopify import notices the tag", () => {
  it("out_of_stock added in Shopify starts following; removed ends it", async () => {
    const g = await euTestGroup("stock-wait-import");
    const base = SYNTHETIC_ORDERS[1]!;
    const o: ShopifyOrder = { ...base, id: "gid://shopify/Order/8811", name: "#SW-1", tags: ["vip"] };
    const store = await g.db.store.findUniqueOrThrow({ where: { id: g.store.id } });
    const { orderId } = await importShopifyOrder(g.accountId, store, o);
    const row = () =>
      g.db.orderStockWait.findUnique({ where: { accountId_orderId: { accountId: g.accountId, orderId } } });
    expect(await row()).toBeNull();
    const later = (min: number, tags: string[]) => ({
      ...o,
      tags,
      updatedAt: new Date(Date.parse(o.updatedAt) + min * 60_000).toISOString(),
    });
    await importShopifyOrder(g.accountId, store, later(1, ["vip", "OUT_OF_STOCK"]));
    expect(await row()).toMatchObject({ stage: "out_of_stock", state: "OUT_OF_STOCK" });
    await importShopifyOrder(g.accountId, store, later(2, ["vip"]));
    expect(await row()).toBeNull();
  });
});
