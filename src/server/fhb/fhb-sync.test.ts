import { describe, expect, it, vi } from "vitest";
import examples from "@/integrations/fhb-v3/__fixtures__/openapi-examples.json";
import readExamples from "@/integrations/fhb-v3/__fixtures__/read-examples.json";
import type { FetchLike } from "@/integrations/fhb-v3/client";
import type { Actor } from "@/server/accounts";
import { accountDb, systemDb } from "@/server/db/client";
import { createFhbConnection } from "./connection";
import { runFhbSync, WINDOWS, type FhbSyncRequest } from "./sync";

// Synthetic data only; FHB answers are the vendor documentation examples or built in their shape.
const ex = { ...examples, ...readExamples } as unknown as Record<string, Record<string, unknown>>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Route = (url: URL) => Response;
function fakeFhb(routes: Record<string, Route>) {
  const calls: URL[] = [];
  const fetchImpl = vi.fn<FetchLike>(async (u, init = {}) => {
    const url = new URL(u);
    if (url.pathname === "/v3/login") return json({ token: "t", expiration: "2099-01-01T00:00:00+0000" });
    if ((init.method ?? "GET") !== "GET") throw new Error(`the read side must never write: ${init.method}`);
    calls.push(url);
    const h = routes[url.pathname.replace("/v3", "")];
    if (!h) throw new Error(`unexpected ${url.pathname}`);
    return h(url);
  });
  const clientOptions = { fetchImpl, sleep: async () => {}, random: () => 0 };
  return { calls, clientOptions };
}

let seq = 0;
async function setup() {
  const n = ++seq;
  const sys = systemDb();
  const account = await sys.account.create({ data: { name: `FHB sync ${n}` } });
  const company = await sys.company.create({ data: { accountId: account.id, name: "Demo Co" } });
  const owner: Actor = { userId: "u-owner", accountId: account.id, role: "OWNER" };
  const connection = await createFhbConnection(owner, {
    companyId: company.id,
    name: "FHB test",
    appId: "test-app",
    secret: "test-secret",
    skuPrefix: "R",
  });
  const product = await sys.product.create({
    data: { accountId: account.id, sku: "SKU-1", name: "Sample Perfume 50ml" },
  });
  return { account, owner, connection, product };
}

const product = (id: string, over: Record<string, unknown> = {}) => ({
  ...(ex["GET /product/all 200 response"]!.products as Record<string, unknown>[])[0],
  id,
  ean: "0000000000017",
  stock_quantity: 10,
  free_quantity: 7,
  ...over,
});

const run = (s: Awaited<ReturnType<typeof setup>>, req: FhbSyncRequest, routes: Record<string, Route>) => {
  const fhb = fakeFhb(routes);
  return {
    fhb,
    result: runFhbSync(s.account.id, s.connection.id, req, { clientOptions: fhb.clientOptions }),
  };
};

describe("FHB read side: products and stock", () => {
  it("pages products by 250, mirrors stock and links to the master by SKU with the prefix stripped (never EAN)", async () => {
    const s = await setup();
    // A master whose EAN equals an FHB product's EAN must NOT be linked through it.
    const other = await systemDb().product.create({
      data: { accountId: s.account.id, sku: "OTHER", name: "Other" },
    });
    await systemDb().productEan.create({
      data: { accountId: s.account.id, productId: other.id, ean: "0000000000099" },
    });
    const page1 = Array.from({ length: 250 }, (_, i) => product(`RX-${i}`));
    page1[0] = product("RSKU-1");
    page1[1] = product("RNOPE", { ean: "0000000000099" });
    const { fhb, result } = run(
      s,
      { resource: "products" },
      {
        "/product/all": (url) => {
          const page = Number(url.searchParams.get("page"));
          return json({
            page,
            total: 251,
            products: page === 1 ? page1 : page === 2 ? [product("RLAST", { free_quantity: 0 })] : [],
          });
        },
      },
    );
    expect(await result).toMatchObject({ count: 251 });
    expect(fhb.calls.map((u) => u.searchParams.get("page"))).toEqual(["1", "2"]);

    const db = accountDb(s.account.id);
    const linked = await db.vendorProduct.findUniqueOrThrow({
      where: { connectionId_vendorId: { connectionId: s.connection.id, vendorId: "RSKU-1" } },
      include: { stockLevel: true },
    });
    expect(linked.productId).toBe(s.product.id);
    expect(linked.vendorEan).toBe("0000000000017");
    expect(linked.stockLevel).toMatchObject({ physical: 10, free: 7, sellable: 7, source: "POLL" });
    const byEan = await db.vendorProduct.findUniqueOrThrow({
      where: { connectionId_vendorId: { connectionId: s.connection.id, vendorId: "RNOPE" } },
    });
    expect(byEan.productId).toBeNull();
    expect(await db.vendorProduct.count({ where: { connectionId: s.connection.id } })).toBe(251);

    const state = await db.fhbSyncState.findUniqueOrThrow({
      where: { connectionId_resource: { connectionId: s.connection.id, resource: "products" } },
    });
    expect(state).toMatchObject({ lastCount: 251, lastError: null });
    expect(state.lastOkAt).not.toBeNull();

    // stock/all only updates the physical quantity of mirrored products.
    const stock = run(
      s,
      { resource: "stock" },
      {
        "/stock/all": () =>
          json([
            { id: "RSKU-1", ean: null, name: "x", quantity: 4 },
            { id: "UNKNOWN", ean: null, name: "y", quantity: 9 },
          ]),
      },
    );
    expect(await stock.result).toMatchObject({ count: 1 });
    const level = await db.stockLevel.findUniqueOrThrow({ where: { vendorProductId: linked.id } });
    expect(level).toMatchObject({ physical: 4, free: 7, sellable: 4 });
  });

  it("parses the documented examples of every read endpoint", async () => {
    const s = await setup();
    const routes: Record<string, Route> = {
      "/product/all": () => json(ex["GET /product/all 200 response"]),
      "/stock/all": () => json(ex["GET /stock/all 200 response"]),
      "/stock/movements": () => json(ex["GET /stock/movements 200 response"]),
      "/order/history": () => json(ex["GET /order/history 200 response"]),
      "/rma/list": () => json(ex["GET /rma/list 200 response"]),
      "/return/list": () => json(ex["GET /return/list 200 response"]),
      "/cod/list": () => json(ex["GET /cod/list 200 response"]),
      "/parcel-service": () => json(ex["GET /parcel-service 200 example"]),
      "/delivery-point/gls": () => json(ex["GET /delivery-point/{deliveryService} 200 example"]),
    };
    for (const resource of [
      "products",
      "stock",
      "movements",
      "orders",
      "rma",
      "returns",
      "cod",
      "carriers",
    ] as const) {
      const r = run(s, { resource }, routes);
      expect(await r.result, resource).toMatchObject({ skipped: false });
    }
    const pp = run(s, { resource: "pickupPoints", service: "gls", country: "cz" }, routes);
    expect(await pp.result).toMatchObject({ count: 1 });
    expect(pp.fhb.calls[0]!.searchParams.get("country")).toBe("CZ");

    const db = accountDb(s.account.id);
    expect(await db.stockMovement.count({ where: { connectionId: s.connection.id } })).toBe(1);
    const mv = await db.stockMovement.findFirstOrThrow({ where: { connectionId: s.connection.id } });
    expect(mv).toMatchObject({ externalId: "123", kind: "out", quantity: -1 });
    const order = await db.fhbOrderMirror.findUniqueOrThrow({
      where: { connectionId_externalId: { connectionId: s.connection.id, externalId: "AB12345" } },
    });
    expect(order).toMatchObject({ rawStatus: "imported", status: "ACCEPTED", inRma: false });
    const rma = await db.fhbOrderMirror.findUniqueOrThrow({
      where: { connectionId_externalId: { connectionId: s.connection.id, externalId: "69e73ce4deec1" } },
    });
    expect(rma).toMatchObject({
      inRma: true,
      status: "RETURN_RECEIVED",
      returnType: "return",
      country: "SK",
    });
    expect(rma.returnedAt?.toISOString()).toBe("2026-04-22T08:10:44.000Z");
    expect(
      await db.fhbReturnMirror.findFirstOrThrow({ where: { connectionId: s.connection.id } }),
    ).toMatchObject({ uid: "AB00001", vendorId: "1024", barcodes: ["CZ123456789", "CZ987654321"] });
    const cod = await db.fhbCodMirror.findFirstOrThrow({ where: { connectionId: s.connection.id } });
    expect(cod).toMatchObject({ externalId: "AB12345", status: "waiting" });
    expect(Number(cod.cod)).toBe(42.5);
    expect(await db.fhbCarrier.count({ where: { connectionId: s.connection.id } })).toBe(2);
    const point = await db.fhbPickupPoint.findFirstOrThrow({ where: { connectionId: s.connection.id } });
    expect(point).toMatchObject({ service: "gls", queryCountry: "CZ", vendorId: "3100000", country: "CZ" });
  });
});

describe("FHB read side: orders, RMA, COD", () => {
  const base = () => ({ ...(ex["GET /order 200 response"] as Record<string, unknown>) });

  it("mirrors orders, moves the CRM shipment it knows, and alerts an unknown status once without throwing", async () => {
    const s = await setup();
    const sys = systemDb();
    const order = await sys.order.create({
      data: {
        accountId: s.account.id,
        source: "MANUAL",
        number: "1",
        currency: "EUR",
        subtotal: "1",
        total: "1",
        paymentMethod: "COD",
        placedAt: new Date(),
      },
    });
    const f = await sys.fulfillment.create({
      data: {
        accountId: s.account.id,
        orderId: order.id,
        connectionId: s.connection.id,
        externalId: "TST-1",
        status: "ACCEPTED",
        rawStatus: "pending",
      },
    });
    const routes = {
      "/order/history": (url: URL) => {
        expect(url.searchParams.get("from")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        return json({
          page: 1,
          total: 3,
          orders: [
            { ...base(), id: "TST-1", status: "sent", tracking_numbers: ["T1"] },
            { ...base(), id: "ZOE-9", status: "teleported" },
            { ...base(), id: "ZOE-10", status: "teleported" },
          ],
        });
      },
    };
    expect(await run(s, { resource: "orders" }, routes).result).toMatchObject({ count: 3 });
    expect(await run(s, { resource: "orders" }, routes).result).toMatchObject({ count: 3 });

    const db = accountDb(s.account.id);
    expect(await db.fulfillment.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({
      status: "SHIPPED",
      rawStatus: "sent",
      trackingNumbers: ["T1"],
    });
    // One event for the one change, despite two syncs.
    expect(await db.fulfillmentEvent.count({ where: { fulfillmentId: f.id } })).toBe(1);
    const unknown = await db.fhbOrderMirror.findUniqueOrThrow({
      where: { connectionId_externalId: { connectionId: s.connection.id, externalId: "ZOE-9" } },
    });
    expect(unknown).toMatchObject({ status: "UNKNOWN", rawStatus: "teleported" });
    expect(await db.alert.count({ where: { kind: "fhb_unknown_status" } })).toBe(1);
  });

  it("production shape: orders, RMA and COD listed with id: null are mirrored by uid (observed 2026-11-02)", async () => {
    const s = await setup();
    const routes = {
      "/order/history": () =>
        json({
          page: "1",
          total: "2",
          orders: [
            { ...base(), id: null, uid: "u-100", status: "sent" },
            { ...base(), id: "TST-7", uid: "u-101", status: "sent" },
          ],
        }),
      "/rma/list": () =>
        json({
          page: 1,
          total: 1,
          items: [{ ...base(), id: null, uid: "u-100", returned_at: "2026-10-30T10:00:00+0100" }],
        }),
      "/cod/list": () =>
        json({ page: 1, total: 1, items: [{ id: null, uid: "u-100", cod: 15, status: "received" }] }),
    };
    expect(await run(s, { resource: "orders" }, routes).result).toMatchObject({ count: 2 });
    expect(await run(s, { resource: "rma" }, routes).result).toMatchObject({ count: 1 });
    expect(await run(s, { resource: "cod" }, routes).result).toMatchObject({ count: 1 });
    const db = accountDb(s.account.id);
    const byUid = await db.fhbOrderMirror.findUniqueOrThrow({
      where: { connectionId_externalId: { connectionId: s.connection.id, externalId: "uid:u-100" } },
    });
    expect(byUid).toMatchObject({ uid: "u-100", inRma: true });
    expect(await db.fhbOrderMirror.count({ where: { connectionId: s.connection.id } })).toBe(2);
    expect(
      await db.fhbCodMirror.count({ where: { connectionId: s.connection.id, externalId: "uid:u-100" } }),
    ).toBe(1);
  });

  it("COD: stores the raw status, updates the shipment's codStatus, alerts unknown values", async () => {
    const s = await setup();
    const routes = {
      "/cod/list": () =>
        json({
          page: 1,
          total: 2,
          items: [
            { id: "A-1", cod: 10, status: "paid", created_at: "2026-04-18T14:00:00+0200" },
            { id: "A-2", cod: 12.345, status: "frozen" },
          ],
        }),
    };
    expect(await run(s, { resource: "cod" }, routes).result).toMatchObject({ count: 2 });
    const db = accountDb(s.account.id);
    const odd = await db.fhbCodMirror.findUniqueOrThrow({
      where: { connectionId_externalId: { connectionId: s.connection.id, externalId: "A-2" } },
    });
    expect(odd.status).toBe("frozen");
    expect(Number(odd.cod)).toBe(12.35);
    expect(await db.alert.count({ where: { kind: "fhb_unknown_cod_status" } })).toBe(1);
  });

  it("records a failed run on the sync state and rethrows; skips fresh carriers unless forced", async () => {
    const s = await setup();
    await expect(
      run(s, { resource: "returns" }, { "/return/list": () => json({ message: "x" }, 500) }).result,
    ).rejects.toMatchObject({ code: "server_error" });
    const db = accountDb(s.account.id);
    const state = await db.fhbSyncState.findUniqueOrThrow({
      where: { connectionId_resource: { connectionId: s.connection.id, resource: "returns" } },
    });
    expect(state.lastError).toMatch(/server_error/);
    expect(state.lastOkAt).toBeNull();

    const routes = { "/parcel-service": () => json([{ code: "gls", name: "GLS" }]) };
    expect(await run(s, { resource: "carriers" }, routes).result).toMatchObject({ skipped: false });
    expect(await run(s, { resource: "carriers" }, routes).result).toMatchObject({ skipped: true });
    expect(await run(s, { resource: "carriers", force: true }, routes).result).toMatchObject({
      skipped: false,
    });
    expect(WINDOWS.carriersMaxAgeMs).toBeGreaterThan(0);
  });

  it("movements continue from the newest date seen, with an overlap, and never duplicate", async () => {
    const s = await setup();
    const froms: string[] = [];
    const routes = {
      "/stock/movements": (url: URL) => {
        froms.push(url.searchParams.get("from")!);
        return json({
          page: 1,
          total: 1,
          movements: [
            {
              id: 7,
              product: "RSKU-1",
              type: "in",
              change: 5,
              quantity: 5,
              date: "2026-10-01T10:00:00+0000",
            },
          ],
        });
      },
    };
    await run(s, { resource: "movements" }, routes).result;
    await run(s, { resource: "movements" }, routes).result;
    expect(froms[1]).toBe("2026-10-01T09:00:00.000Z");
    expect(
      await accountDb(s.account.id).stockMovement.count({ where: { connectionId: s.connection.id } }),
    ).toBe(1);
  });
});

describe("FHB mirror tables are scoped by account", () => {
  it("another account sees none of the rows", async () => {
    const a = await setup();
    const b = await setup();
    await run(a, { resource: "carriers" }, { "/parcel-service": () => json([{ code: "gls", name: "GLS" }]) })
      .result;
    await run(
      a,
      { resource: "orders" },
      { "/order/history": () => json(ex["GET /order/history 200 response"]) },
    ).result;
    const dbB = accountDb(b.account.id);
    expect(await dbB.fhbCarrier.count()).toBe(0);
    expect(await dbB.fhbOrderMirror.count()).toBe(0);
    expect(await dbB.fhbSyncState.count()).toBe(0);
    expect(await accountDb(a.account.id).fhbCarrier.count()).toBe(1);
  });
});
