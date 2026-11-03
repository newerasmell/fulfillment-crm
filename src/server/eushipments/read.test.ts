import { beforeAll, describe, expect, it, vi } from "vitest";
import products from "@/integrations/eushipments/__fixtures__/get-products.json";
import RD from "@/integrations/eushipments/__fixtures__/read.json";
import { accountDb } from "@/server/db/client";
import {
  bookingStage,
  masterSkuFor,
  pollEuBookings,
  pollEuCod,
  pollEuOrders,
  rowsForCompany,
  syncEuCities,
  syncEuProducts,
  syncEuReference,
  syncEuStock,
  testEuConnection,
} from "./read";
import { euTestGroup, euTestOrder } from "./test-fixtures";

// Mocked euShipments only (synthetic fixtures shaped like the reference examples). Tests never call the vendor.
type Route = (url: URL, body: Record<string, unknown> | undefined) => Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function vendor(routes: Record<string, Route>) {
  const calls: { path: string; method: string; body: Record<string, unknown> | undefined }[] = [];
  const fetchImpl = vi.fn(async (u: string, init?: RequestInit) => {
    const url = new URL(u);
    const path = url.pathname.replace("/api/v1", "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const method = String(init?.method ?? "GET");
    calls.push({ path, method, body });
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    if (!key) throw new Error(`unexpected call ${path}`);
    return routes[key]!(url, body);
  });
  return {
    calls,
    deps: { clientOptions: { fetchImpl, sleep: async () => {} } },
    writes: () => calls.filter((c) => /create|delete|attach/.test(c.path)),
  };
}

describe("pure helpers", () => {
  it("strips the connection's SKU prefix (case-insensitive) to find the master SKU", () => {
    expect(masterSkuFor("SK-ABC-1", { prefix: "SK-" })).toBe("ABC-1");
    expect(masterSkuFor("sk-ABC-1", { prefix: "SK-" })).toBe("ABC-1");
    expect(masterSkuFor("ABC-1", {})).toBe("ABC-1");
    expect(masterSkuFor("SK-", { prefix: "SK-" })).toBe("SK-");
  });

  it("booking lifecycle", () => {
    expect(bookingStage({ created: "x" })).toBe("CREATED");
    expect(bookingStage({ created: "x", received: "y" })).toBe("RECEIVED");
    expect(bookingStage({ created: "x", received: "y", closed: "z" })).toBe("CLOSED");
    expect(bookingStage({ created: "x", deleted: "d" })).toBe("DELETED");
  });

  it("attributes get-prod-avails rows to the company by CUST_NAME when the token sees several", () => {
    const rows = [
      { ...RD.prodAvails[0]!, CUST_NAME: "Example Company Ltd." },
      { ...RD.prodAvails[0]!, CUST_NAME: "Second Example Ltd.", REFERENCE_NUMBER: "other" },
    ];
    const two = [
      { vendorCompanyId: 333, name: "Example Company Ltd." },
      { vendorCompanyId: 334, name: "Second Example Ltd." },
    ];
    expect(rowsForCompany(rows, two, 333).rows.map((r) => r.REFERENCE_NUMBER)).toEqual(["ref-test-54202"]);
    expect(rowsForCompany(rows, [two[0]!], 333).rows).toHaveLength(2);
    expect(rowsForCompany(rows, two, 999)).toEqual({ rows: [], unattributed: 2 });
    expect(rowsForCompany(rows, [], 333)).toEqual({ rows: [], unattributed: 2 });
    // A CUST_NAME that matches none of the token's companies is counted, never silently dropped.
    const off = [{ ...rows[0]!, CUST_NAME: "Example Company Ltd" }, rows[1]!];
    expect(rowsForCompany(off, two, 333)).toEqual({ rows: [], unattributed: 1 });
    // Two companies with the same name: no row can be attributed.
    const same = [two[0]!, { vendorCompanyId: 334, name: " example  company ltd. " }];
    expect(rowsForCompany(rows, same, 333)).toMatchObject({ rows: [], ambiguous: true });
  });
});

describe("euShipments read side (DB)", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  const routes: Record<string, Route> = {
    "/get-user-companies": () => json(RD.userCompanies),
    "/couriers/333": () => json(RD.couriers),
    "/fulfilment/warehouses": () => json(RD.warehouses),
    "/get-countries": () => json(RD.countries),
    "/offices-by-courier/15": (u) =>
      json(u.searchParams.get("page") === "2" ? RD.officesPage2 : RD.officesPage1),
    "/get-cities/2": () => json(RD.cities),
    "/fulfilment/get-products": () => json(products),
    "/fulfilment/get-prod-avails": () =>
      json([
        ...RD.prodAvails,
        { ...RD.prodAvails[0]!, STORE_NAME: "Warehouse Two", AVAIL_QTY: "3" },
        { ...RD.prodAvails[0]!, CUST_NAME: "Second Example Ltd.", AVAIL_QTY: 999 },
      ]),
  };

  beforeAll(async () => {
    g = await euTestGroup("read");
    // Reads are allowed in every mode, READ_ONLY included.
    await g.db.fulfillmentConnection.update({
      where: { id: g.connection.id },
      data: { liveMode: "READ_ONLY", skuPrefixRule: { prefix: "ref-" } },
    });
  });

  it("connection test mirrors the token's companies and checks ours is among them", async () => {
    const v = vendor(routes);
    expect(await testEuConnection(g.accountId, g.connection.id, v.deps)).toEqual({
      companies: 2,
      companyVisible: true,
    });
    const rows = await g.db.eushipmentsVendorCompany.findMany({ where: { connectionId: g.connection.id } });
    expect(rows.map((r) => r.vendorCompanyId).sort()).toEqual([333, 334]);
    const sync = await g.db.eushipmentsSync.findUniqueOrThrow({
      where: { connectionId_kind: { connectionId: g.connection.id, kind: "connection" } },
    });
    expect(sync.lastOkAt).not.toBeNull();
    expect(sync.lastError).toBeNull();
    expect(v.writes()).toHaveLength(0);
  });

  it("a token that does not see our company records the error", async () => {
    const v = vendor({ "/get-user-companies": () => json([RD.userCompanies[1]]) });
    await expect(testEuConnection(g.accountId, g.connection.id, v.deps)).rejects.toMatchObject({
      code: "company_not_visible",
    });
    const sync = await g.db.eushipmentsSync.findUniqueOrThrow({
      where: { connectionId_kind: { connectionId: g.connection.id, kind: "connection" } },
    });
    expect(sync.lastError).toBe("company_not_visible");
    // restore both companies for the next tests
    await testEuConnection(g.accountId, g.connection.id, vendor(routes).deps);
  });

  it("reference data: couriers, warehouses, countries and paged offices of office couriers", async () => {
    const v = vendor(routes);
    const info = await syncEuReference(g.accountId, g.connection.id, v.deps);
    expect(info).toEqual({ couriers: 2, warehouses: 1, countries: 2, offices: 2 });
    // only the courier that delivers to offices is asked for offices, page by page
    expect(v.calls.filter((c) => c.path.startsWith("/offices-by-courier")).map((c) => c.path)).toEqual([
      "/offices-by-courier/15",
      "/offices-by-courier/15",
    ]);
    const conn = await g.db.fulfillmentConnection.findUniqueOrThrow({ where: { id: g.connection.id } });
    expect(conn.warehouseIds).toEqual(["1"]);
    const offices = await g.db.eushipmentsOffice.findMany({
      where: { connectionId: g.connection.id },
      orderBy: { officeId: "asc" },
    });
    expect(offices.map((o) => [o.officeId, o.isStation, o.codSupport])).toEqual([
      [1297, false, true],
      [1298, true, false],
    ]);
    // a second run replaces rather than duplicates
    await syncEuReference(g.accountId, g.connection.id, vendor(routes).deps);
    expect(await g.db.eushipmentsOffice.count({ where: { connectionId: g.connection.id } })).toBe(2);
    expect(await g.db.eushipmentsCourier.count({ where: { connectionId: g.connection.id } })).toBe(2);
  });

  it("thousands of offices are replaced in batches; offices that disappeared are removed", async () => {
    const base = RD.officesPage1.offices[0]!;
    const many = (n: number, skip = -1) =>
      Array.from({ length: n }, (_, i) => ({ ...base, ID: 100_000 + i, OFFICE_NAME: `Office ${i}` })).filter(
        (_, i) => i !== skip,
      );
    const pageOf = (offices: unknown[]) => ({
      offices,
      pagination: { current_page: 1, per_page: offices.length, total: offices.length, last_page: 1 },
    });
    const big = { ...routes, "/offices-by-courier/15": () => json(pageOf(many(1_234))) };
    const t1 = new Date(Date.now() + 60_000); // later than the previous tests' runs
    expect(
      (await syncEuReference(g.accountId, g.connection.id, { ...vendor(big).deps, now: t1 })).offices,
    ).toBe(1_234);
    expect(await g.db.eushipmentsOffice.count({ where: { connectionId: g.connection.id } })).toBe(1_234);
    // Next run: office #7 is gone at the vendor; the rest are refreshed, nothing is duplicated.
    const fewer = { ...routes, "/offices-by-courier/15": () => json(pageOf(many(1_234, 7))) };
    const t2 = new Date(Date.now() + 120_000);
    await syncEuReference(g.accountId, g.connection.id, { ...vendor(fewer).deps, now: t2 });
    expect(await g.db.eushipmentsOffice.count({ where: { connectionId: g.connection.id } })).toBe(1_233);
    expect(
      await g.db.eushipmentsOffice.count({ where: { connectionId: g.connection.id, officeId: 100_007 } }),
    ).toBe(0);
    expect(
      await g.db.eushipmentsOffice.count({ where: { connectionId: g.connection.id, syncedAt: { lt: t2 } } }),
    ).toBe(0);
  });

  it("cities per country (paged); Great Britain is refused before any call", async () => {
    const v = vendor(routes);
    expect(await syncEuCities(g.accountId, g.connection.id, 2, v.deps)).toEqual({ countryId: 2, cities: 2 });
    await expect(syncEuCities(g.accountId, g.connection.id, 23, v.deps)).rejects.toMatchObject({
      code: "cities_unsupported",
    });
    expect(v.calls).toHaveLength(1);
  });

  it("products: mirrored by REFERENCE_NUMBER, auto-matched by SKU with prefix stripped, never by EAN", async () => {
    const master = await g.db.product.create({
      data: { accountId: g.accountId, sku: "TEST-54202", name: "Master" },
    });
    // a master that only shares the EAN must NOT be linked
    const eanOnly = await g.db.product.create({
      data: { accountId: g.accountId, sku: "OTHER-1", name: "EAN twin" },
    });
    await g.db.productEan.create({ data: { accountId: g.accountId, productId: eanOnly.id, ean: "54201" } });
    const v = vendor(routes);
    const info = await syncEuProducts(g.accountId, g.connection.id, v.deps);
    expect(info).toMatchObject({ rows: 2, created: 2, matched: 1, unmatched: 1 });
    const vps = await g.db.vendorProduct.findMany({
      where: { connectionId: g.connection.id },
      orderBy: { vendorId: "asc" },
    });
    expect(vps.map((p) => [p.vendorId, p.vendorCode, p.productId])).toEqual([
      ["ref-test-54201", "86", null],
      ["ref-test-54202", "85", master.id],
    ]);
    expect(vps.every((p) => p.vendorEan === null)).toBe(true);

    // a manual link is never replaced by a later sync
    const other = await g.db.product.create({ data: { accountId: g.accountId, sku: "MANUAL", name: "M" } });
    await g.db.vendorProduct.update({ where: { id: vps[1]!.id }, data: { productId: other.id } });
    await syncEuProducts(g.accountId, g.connection.id, vendor(routes).deps);
    expect((await g.db.vendorProduct.findUniqueOrThrow({ where: { id: vps[1]!.id } })).productId).toBe(
      other.id,
    );
    await g.db.vendorProduct.update({ where: { id: vps[1]!.id }, data: { productId: master.id } });
  });

  it("products gone from get-products are archived after the grace period, and come back", async () => {
    const later = new Date(Date.now() + 2 * 3600_000);
    const v = vendor({ "/fulfilment/get-products": () => json([products[0]]) });
    const info = await syncEuProducts(g.accountId, g.connection.id, { ...v.deps, now: later });
    expect(info.archived).toBe(1);
    const gone = await g.db.vendorProduct.findUniqueOrThrow({
      where: { connectionId_vendorId: { connectionId: g.connection.id, vendorId: "ref-test-54201" } },
    });
    expect(gone.archived).toBe(true);
    await syncEuProducts(g.accountId, g.connection.id, vendor(routes).deps);
    expect((await g.db.vendorProduct.findUniqueOrThrow({ where: { id: gone.id } })).archived).toBe(false);
  });

  it("stock: per-warehouse rows of OUR company only, summed into StockLevel with the snapshot time", async () => {
    const v = vendor(routes);
    const info = await syncEuStock(g.accountId, g.connection.id, v.deps);
    expect(info).toMatchObject({ rows: 2, products: 1, unknownRefs: 0, unattributed: 0 });
    const vp = await g.db.vendorProduct.findUniqueOrThrow({
      where: { connectionId_vendorId: { connectionId: g.connection.id, vendorId: "ref-test-54202" } },
      include: { stockLevel: true },
    });
    expect(vp.stockLevel).toMatchObject({ physical: 90, free: 90, sellable: 90, source: "POLL" });
    // A product the warehouse does not list has 0 (not "no data"): every active product of the connection has a level.
    const active = await g.db.vendorProduct.findMany({
      where: { connectionId: g.connection.id, archived: false },
      include: { stockLevel: true },
    });
    expect(active.every((p) => p.stockLevel)).toBe(true);
    expect(active.filter((p) => p.id !== vp.id).every((p) => p.stockLevel!.free === 0)).toBe(true);
    // AVAIL_DATE "2026-11-02 06:00:00" read as Europe/Sofia
    expect(vp.stockLevel!.snapshotAt.toISOString()).toBe("2026-11-02T04:00:00.000Z");
    // the next snapshot without that product sets it to 0 and drops the old per-warehouse rows
    await syncEuStock(
      g.accountId,
      g.connection.id,
      vendor({ "/fulfilment/get-prod-avails": () => json([]) }).deps,
    );
    expect(await g.db.eushipmentsStock.count({ where: { connectionId: g.connection.id } })).toBe(0);
    expect((await g.db.stockLevel.findUniqueOrThrow({ where: { vendorProductId: vp.id } })).free).toBe(0);
  });

  it("stock: rows that cannot be attributed to our company fail the sync and never zero the catalogue", async () => {
    await syncEuStock(g.accountId, g.connection.id, vendor(routes).deps);
    const vp = await g.db.vendorProduct.findUniqueOrThrow({
      where: { connectionId_vendorId: { connectionId: g.connection.id, vendorId: "ref-test-54202" } },
    });
    const level = () => g.db.stockLevel.findUniqueOrThrow({ where: { vendorProductId: vp.id } });
    expect((await level()).free).toBe(90);
    const before = (await level()).snapshotAt;
    // The cabinet's CUST_NAME differs by one character from get-user-companies' NAME.
    const off = vendor({
      "/fulfilment/get-prod-avails": () =>
        json([
          { ...RD.prodAvails[0]!, CUST_NAME: "Example Company Ltd" },
          { ...RD.prodAvails[0]!, CUST_NAME: "Second Example Ltd.", AVAIL_QTY: 999 },
        ]),
    });
    await expect(syncEuStock(g.accountId, g.connection.id, off.deps)).rejects.toMatchObject({
      code: "stock_unattributed",
    });
    expect(await level()).toMatchObject({ free: 90, physical: 90, snapshotAt: before });
    const sync = await g.db.eushipmentsSync.findUniqueOrThrow({
      where: { connectionId_kind: { connectionId: g.connection.id, kind: "stock" } },
    });
    expect(sync.lastError).toBe("stock_unattributed");
    expect(await g.db.eushipmentsStock.count({ where: { connectionId: g.connection.id } })).toBe(2);
  });

  it("orders-history: batches of 100, per-item results, final status stops polling", async () => {
    await g.db.fulfillment.deleteMany({ where: { connectionId: g.connection.id } });
    const fs = [];
    for (let i = 0; i < 102; i++) {
      const { order } = await euTestOrder(g, { number: `#P${i}` });
      fs.push(
        await g.db.fulfillment.create({
          data: {
            accountId: g.accountId,
            orderId: order.id,
            connectionId: g.connection.id,
            externalId: `TST-P${i}`,
            status: "ACCEPTED",
          },
        }),
      );
    }
    const history = (refs: { refNum: string }[]) =>
      refs.map(({ refNum }) =>
        refNum === "TST-P1"
          ? { refNum, error: "Not found order with specified reference number!", errorCode: 404 }
          : refNum === "TST-P2"
            ? { refNum, error: "Some other problem", errorCode: 500 }
            : {
                refNum,
                awb: `AWB-${refNum}`,
                error: null,
                statusesHistory: [
                  { ID: 1, STATUS: "Information received", DATE: "2026-11-02 08:00:00" },
                  ...(refNum === "TST-P0"
                    ? [{ ID: 2, STATUS: "Delivered", DATE: "2026-11-02 09:00:00" }]
                    : []),
                ],
              },
      );
    const v = vendor({
      "/fulfilment/orders-history": (_u, body) => json(history(body!.orders as { refNum: string }[])),
    });
    const now = new Date("2026-11-02T08:30:00Z");
    const info = await pollEuOrders(g.accountId, g.connection.id, { ...v.deps, now });
    expect(info).toMatchObject({
      shipments: 102,
      batches: 2,
      failedBatches: 0,
      updated: 100,
      notFound: 1,
      errors: 1,
    });
    const batches = v.calls.map((c) => (c.body!.orders as unknown[]).length);
    expect(batches).toEqual([100, 2]);
    expect(v.calls.every((c) => c.body!.testMode === false)).toBe(true);

    const delivered = await g.db.fulfillment.findUniqueOrThrow({ where: { id: fs[0]!.id } });
    expect(delivered.status).toBe("DELIVERED");
    expect(delivered.trackingNumbers).toEqual(["AWB-TST-P0"]);
    const t0 = await g.db.eushipmentsTracking.findUniqueOrThrow({ where: { fulfillmentId: fs[0]!.id } });
    expect(t0.stopPolling).toBe(true);
    const t1 = await g.db.eushipmentsTracking.findUniqueOrThrow({ where: { fulfillmentId: fs[1]!.id } });
    expect(t1.lastError).toBe("not found at euShipments");
    expect(await g.db.alert.count({ where: { kind: "eushipments_not_found", entityId: fs[1]!.id } })).toBe(1);
    const t2 = await g.db.eushipmentsTracking.findUniqueOrThrow({ where: { fulfillmentId: fs[2]!.id } });
    expect(t2.lastError).toContain("Some other problem");

    // second run: the delivered one is not asked again, the not-found alert is not duplicated
    const v2 = vendor({
      "/fulfilment/orders-history": (_u, body) => json(history(body!.orders as { refNum: string }[])),
    });
    await pollEuOrders(g.accountId, g.connection.id, { ...v2.deps, now });
    const asked = v2.calls.flatMap((c) => (c.body!.orders as { refNum: string }[]).map((o) => o.refNum));
    expect(asked).not.toContain("TST-P0");
    expect(asked).toHaveLength(101);
    expect(await g.db.alert.count({ where: { kind: "eushipments_not_found", entityId: fs[1]!.id } })).toBe(1);
  });

  it("orders-history: one failing batch does not stop the others; all failing fails the job", async () => {
    let n = 0;
    const v = vendor({
      "/fulfilment/orders-history": (_u, body) =>
        ++n === 1
          ? json({ error: "bad" }, 422)
          : json(
              (body!.orders as { refNum: string }[]).map((o) => ({
                refNum: o.refNum,
                error: null,
                statusesHistory: [],
              })),
            ),
    });
    const info = await pollEuOrders(g.accountId, g.connection.id, v.deps);
    expect(info.failedBatches).toBe(1);
    const all = vendor({ "/fulfilment/orders-history": () => json({ error: "bad" }, 422) });
    await expect(pollEuOrders(g.accountId, g.connection.id, all.deps)).rejects.toThrow(/bad/);
  });

  it("booking status: closed with differences fills accepted quantities and opens one task", async () => {
    const vps = await g.db.vendorProduct.findMany({
      where: { connectionId: g.connection.id },
      orderBy: { vendorId: "asc" },
    });
    // give the second product a master too
    const p2 = await g.db.product.create({ data: { accountId: g.accountId, sku: "TEST-54201", name: "P2" } });
    await g.db.vendorProduct.update({ where: { id: vps[0]!.id }, data: { productId: p2.id } });
    const inbound = await g.db.inboundShipment.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        externalRef: "PO-2026-0042",
        vendorId: "137",
        status: "CREATED",
        lines: {
          create: [
            { productId: vps[1]!.productId!, expectedQty: 10 },
            { productId: p2.id, expectedQty: 100 },
          ],
        },
      },
    });
    const received = {
      ...RD.bookingStatusClosed,
      statuses: { ...RD.bookingStatusClosed.statuses, closed: null },
    };
    let closed = false;
    const v = vendor({
      "/fulfilment/booking-request-status": () => json(closed ? RD.bookingStatusClosed : received),
    });
    await pollEuBookings(g.accountId, g.connection.id, v.deps);
    expect((await g.db.inboundShipment.findUniqueOrThrow({ where: { id: inbound.id } })).status).toBe(
      "RECEIVED",
    );
    expect(v.calls[0]).toMatchObject({ method: "POST", body: { companyId: 333, bookingId: 137 } });

    closed = true;
    const info = await pollEuBookings(g.accountId, g.connection.id, v.deps);
    expect(info).toMatchObject({ checked: 1, closed: 1, discrepancies: 1 });
    const lines = await g.db.inboundLine.findMany({
      where: { inboundId: inbound.id },
      orderBy: { expectedQty: "asc" },
    });
    expect(lines.map((l) => [l.expectedQty, l.receivedQty, l.comment])).toEqual([
      [10, 10, null],
      [100, 98, "2 damaged items"],
    ]);
    const alerts = await g.db.alert.findMany({
      where: { kind: "eushipments_inbound_discrepancy", entityId: inbound.id },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.body).toContain("accepted 98");
    // closed bookings are no longer polled
    const v2 = vendor({});
    await pollEuBookings(g.accountId, g.connection.id, v2.deps);
    expect(v2.calls).toHaveLength(0);
  });

  it("COD by reference: paid → COD_PAID; nothing found only records the check", async () => {
    const mk = async (ref: string) => {
      const { order } = await euTestOrder(g, { number: `#${ref}` });
      return g.db.fulfillment.create({
        data: {
          accountId: g.accountId,
          orderId: order.id,
          connectionId: g.connection.id,
          externalId: ref,
          status: "DELIVERED",
          deliveredAt: new Date(),
        },
      });
    };
    const paid = await mk("TST-1001");
    const open = await mk("TST-1002");
    const none = await mk("TST-1003");
    const v = vendor({
      "/check-cod-by-order/TST-1001": () => json(RD.codPaid),
      "/check-cod-by-order/TST-1002": () => json(RD.codNotPaid),
      "/check-cod-by-order/": () => new Response("null", { status: 200 }),
    });
    const info = await pollEuCod(g.accountId, g.connection.id, v.deps);
    expect(info).toMatchObject({ paid: 1, registered: 1 });
    expect(info.missing).toBeGreaterThanOrEqual(1);
    const f1 = await g.db.fulfillment.findUniqueOrThrow({ where: { id: paid.id } });
    expect(f1).toMatchObject({ status: "COD_PAID", codStatus: "PAID" });
    expect((await g.db.fulfillment.findUniqueOrThrow({ where: { id: open.id } })).codStatus).toBe(
      "REGISTERED",
    );
    const t3 = await g.db.eushipmentsTracking.findUniqueOrThrow({ where: { fulfillmentId: none.id } });
    expect(t3.codCheckedAt).not.toBeNull();
    expect(t3.codAmount).toBeNull();
    // re-run within 12 h asks nothing
    const v2 = vendor({});
    await pollEuCod(g.accountId, g.connection.id, v2.deps);
    expect(v2.calls).toHaveLength(0);
  });

  it("COD: one failing reference does not stop the run; the Order follows DELIVERED → COD_PAID", async () => {
    const mk = async (ref: string) => {
      const { order } = await euTestOrder(g, { number: `#${ref}` });
      await g.db.order.update({ where: { id: order.id }, data: { status: "DELIVERED" } });
      return g.db.fulfillment.create({
        data: {
          accountId: g.accountId,
          orderId: order.id,
          connectionId: g.connection.id,
          externalId: ref,
          status: "DELIVERED",
          deliveredAt: new Date(),
        },
      });
    };
    const bad = await mk("TST-2001");
    const good = await mk("TST-2002");
    const v = vendor({
      "/check-cod-by-order/TST-2001": () => json({ error: "Wrong params." }, 400),
      "/check-cod-by-order/TST-2002": () => json(RD.codPaid),
      "/check-cod-by-order/": () => new Response("null", { status: 200 }),
    });
    const info = await pollEuCod(g.accountId, g.connection.id, v.deps);
    expect(info).toMatchObject({ paid: 1, errors: 1 });
    const t = await g.db.eushipmentsTracking.findUniqueOrThrow({ where: { fulfillmentId: bad.id } });
    expect(t.lastError).toBeTruthy();
    expect(t.codCheckedAt).not.toBeNull();
    expect((await g.db.fulfillment.findUniqueOrThrow({ where: { id: good.id } })).status).toBe("COD_PAID");
    expect((await g.db.order.findUniqueOrThrow({ where: { id: good.orderId } })).status).toBe("COD_PAID");
    expect((await g.db.order.findUniqueOrThrow({ where: { id: bad.orderId } })).status).toBe("DELIVERED");

    // Every check failing fails the job.
    const only = await mk("TST-2003");
    await g.db.eushipmentsTracking.updateMany({
      where: { fulfillmentId: { in: [bad.id, good.id] } },
      data: { codCheckedAt: new Date() },
    });
    const allBad = vendor({ "/check-cod-by-order/": () => json({ error: "Wrong params." }, 400) });
    await expect(pollEuCod(g.accountId, g.connection.id, allBad.deps)).rejects.toBeTruthy();
    expect(
      (await g.db.eushipmentsTracking.findUniqueOrThrow({ where: { fulfillmentId: only.id } })).lastError,
    ).toBeTruthy();
  });

  it("everything above is scoped to the account", async () => {
    const other = await euTestGroup("read-other");
    expect(
      await accountDb(other.accountId).eushipmentsOffice.count({ where: { connectionId: g.connection.id } }),
    ).toBe(0);
    await expect(
      testEuConnection(other.accountId, g.connection.id, vendor(routes).deps),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
