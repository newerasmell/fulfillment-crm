import { beforeAll, describe, expect, it } from "vitest";
import type { ShopifyClient } from "@/integrations/shopify/client";
import { ShopifyError } from "@/integrations/shopify/errors";
import { PUSH_MUTATION, pushIdempotencyKey } from "@/integrations/shopify/inventory";
import { ForbiddenError } from "@/server/auth/rbac";
import { bootstrapOwner } from "@/server/auth/users";
import { accountDb, systemDb } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";
import { buildRow, groupTesters, stockBoard, stockProductDetail, type StockCtx } from "./board";
import { stockFindings, sweepStockAlerts } from "./discrepancies";
import {
  bookingDocumentNumber,
  createInbound,
  inboundDetail,
  inboundTotals,
  listInbounds,
  parseInboundTable,
  pollFhbReceipts,
  resolveInboundLines,
  sweepInboundAlerts,
} from "./inbound";
import { crmReservations, daysLeft, isStale, sellableOf } from "./levels";
import {
  createInventoryPush,
  storePushes,
  planInventoryPush,
  processInventoryPush,
  sweepInventoryPushes,
  type PushClients,
} from "./push";
import { DEFAULT_STOCK_SETTINGS, updateStockSettings } from "./settings";
import { setLocationConnection, syncStoreInventory } from "./shopify-inventory";

// Synthetic data only; Shopify and the vendors are mocked (no network).

describe("pure helpers", () => {
  it("sellable = min(free, physical − reserved), never negative", () => {
    expect(sellableOf({ physical: 10, free: 8 }, 0)).toBe(8);
    expect(sellableOf({ physical: 10, free: 8 }, 5)).toBe(5);
    expect(sellableOf({ physical: 2, free: 2 }, 5)).toBe(0);
  });

  it("stale and run-out arithmetic", () => {
    const now = new Date("2026-11-02T12:00:00Z");
    expect(isStale(new Date("2026-11-02T09:00:00Z"), 2, now)).toBe(true);
    expect(isStale(new Date("2026-11-02T11:00:00Z"), 2, now)).toBe(false);
    expect(daysLeft(10, 0, 30)).toBeNull();
    expect(daysLeft(10, 60, 30)).toBe(5);
  });

  it("testers sort under their original", () => {
    const rows = [
      { sku: "B-1", isTester: false, parentSku: null },
      { sku: "T-A", isTester: true, parentSku: "A-1" },
      { sku: "A-1", isTester: false, parentSku: null },
    ];
    expect(groupTesters(rows).map((r) => r.sku)).toEqual(["A-1", "T-A", "B-1"]);
  });

  it("parses an upload with or without a header, sums duplicates, reports bad rows", () => {
    const a = parseInboundTable([
      ["SKU", "Количество"],
      ["sk-1", "5"],
      ["SK-1", "3"],
      ["", "2"],
      ["SK-2", "x"],
      ["SK-3", "0"],
      ["SK-4", "7"],
    ]);
    expect(a.lines).toEqual([
      { row: 2, code: "sk-1", quantity: 8 },
      { row: 7, code: "SK-4", quantity: 7 },
    ]);
    expect(a.errors.map((e) => [e.row, e.code])).toEqual([
      [4, "sku_missing"],
      [5, "qty_invalid"],
      [6, "qty_invalid"],
    ]);
    expect(parseInboundTable([["SK-9", "4"]]).lines).toEqual([{ row: 1, code: "SK-9", quantity: 4 }]);
    expect(parseInboundTable([]).errors[0]!.code).toBe("empty");
  });

  it("idempotency keys are deterministic and UUID-shaped; document numbers are ASCII and deterministic", () => {
    const k = pushIdempotencyKey("push1", 0);
    expect(k).toBe(pushIdempotencyKey("push1", 0));
    expect(k).not.toBe(pushIdempotencyKey("push1", 1));
    expect(k).not.toBe(pushIdempotencyKey("push1", 0, 1));
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(bookingDocumentNumber("a", "c", "tok12345")).toMatch(/^IN-[0-9A-F]{16}$/);
    expect(bookingDocumentNumber("a", "c", "tok12345")).toBe(bookingDocumentNumber("a", "c", "tok12345"));
  });

  it("inbound totals", () => {
    expect(inboundTotals([{ expectedQty: 5, receivedQty: null }])).toEqual({
      expected: 5,
      received: null,
      differing: 0,
    });
    expect(
      inboundTotals([
        { expectedQty: 5, receivedQty: 4 },
        { expectedQty: 2, receivedQty: 2 },
      ]),
    ).toEqual({ expected: 7, received: 6, differing: 1 });
  });

  it("board row: Shopify at a mapped location is compared with that warehouse", () => {
    const now = new Date();
    const p = {
      id: "p1",
      sku: "A",
      name: "A",
      isTester: false,
      parentProductId: null,
      archived: false,
      parent: null,
      eans: [],
      vendorProducts: [
        {
          id: "vp1",
          connectionId: "c1",
          vendorId: "RA",
          vendorCode: null,
          raw: null,
          stockLevel: {
            id: "l",
            accountId: "x",
            vendorProductId: "vp1",
            physical: 10,
            free: 10,
            reserved: 0,
            sellable: 10,
            snapshotAt: now,
            source: "PUSH",
          },
        },
      ],
      variantLinks: [
        {
          id: "vl1",
          storeId: "s1",
          sku: "V-1",
          title: "Listing A",
          shopifyVariantGid: "gid://shopify/ProductVariant/1",
          inventoryLevels: [{ locationGid: "L1", available: 20, fetchedAt: now, tracked: true }],
        },
        {
          id: "vl2",
          storeId: "s1",
          sku: "V-2",
          title: "Listing B",
          shopifyVariantGid: "gid://shopify/ProductVariant/2",
          inventoryLevels: [{ locationGid: "L1", available: 7, fetchedAt: now, tracked: true }],
        },
      ],
    } satisfies Parameters<typeof buildRow>[0];
    const opts = {
      connections: [{ id: "c1", type: "FHB_V3" as const }],
      reservations: new Map([["c1:p1", 3]]),
      sales: new Map([["p1", 60]]),
      settings: DEFAULT_STOCK_SETTINGS,
      locationMap: new Map([["s1", new Map([["L1", "c1"]])]]),
      now,
    };
    const row = buildRow(p, opts);
    expect(row.cells.c1).toMatchObject({ physical: 10, free: 10, reserved: 3, sellable: 7, stale: false });
    // Two Shopify listings of the same product: the cell is their sum, and each listing is reported.
    expect(row.shopify.s1).toMatchObject({ available: 27, mismatch: true });
    expect(row.shopify.s1!.variants).toEqual([
      { sku: "V-1", title: "Listing A", variantGid: "gid://shopify/ProductVariant/1", available: 20 },
      { sku: "V-2", title: "Listing B", variantGid: "gid://shopify/ProductVariant/2", available: 7 },
    ]);
    expect(row.flags).toMatchObject({ inStock: true, runningOut: true, shopifyMismatch: true });
    expect(row.shopify.s1).toMatchObject({ linkIds: ["vl1", "vl2"], unmappedAvailable: 0 });
  });

  it("board row: the store buffer, unmapped locations and a mapped location that does not stock the variant", () => {
    const now = new Date();
    const base = {
      id: "p2",
      sku: "B",
      name: "B",
      isTester: false,
      parentProductId: null,
      archived: false,
      parent: null,
      eans: [],
      vendorProducts: [
        {
          id: "vp2",
          connectionId: "c1",
          vendorId: "RB",
          vendorCode: null,
          raw: null,
          stockLevel: {
            id: "l2",
            accountId: "x",
            vendorProductId: "vp2",
            physical: 10,
            free: 10,
            reserved: 0,
            sellable: 10,
            snapshotAt: now,
            source: "PUSH",
          },
        },
        {
          id: "vp3",
          connectionId: "c2",
          vendorId: "EB",
          vendorCode: null,
          raw: null,
          stockLevel: null,
        },
      ],
      variantLinks: [
        {
          id: "vl3",
          storeId: "s1",
          sku: "B",
          title: "B",
          shopifyVariantGid: "gid://shopify/ProductVariant/3",
          inventoryLevels: [
            // Mapped to c1: 5 = 10 sellable − buffer 5, so it agrees.
            { locationGid: "L1", available: 5, fetchedAt: now, tracked: true },
            // An old app's location, not mapped: counted in the sum, never compared or pushed.
            { locationGid: "OLD", available: 5, fetchedAt: now, tracked: true },
          ],
        },
      ],
    } satisfies Parameters<typeof buildRow>[0];
    const row = buildRow(base, {
      connections: [
        { id: "c1", type: "FHB_V3" as const },
        { id: "c2", type: "EUSHIPMENTS" as const },
      ],
      reservations: new Map(),
      sales: new Map(),
      settings: DEFAULT_STOCK_SETTINGS,
      // L2 (the euShipments location) is mapped but the variant is not stocked there.
      locationMap: new Map([
        [
          "s1",
          new Map([
            ["L1", "c1"],
            ["L2", "c2"],
          ]),
        ],
      ]),
      buffers: new Map([["s1", 5]]),
      now,
    });
    expect(row.shopify.s1).toMatchObject({
      available: 10,
      unmappedAvailable: 5,
      mismatch: false,
      why: null,
    });
    // Without the buffer the same 5 vs 10 is a difference (threshold 2).
    expect(
      buildRow(base, {
        connections: [{ id: "c1", type: "FHB_V3" as const }],
        reservations: new Map(),
        sales: new Map(),
        settings: DEFAULT_STOCK_SETTINGS,
        locationMap: new Map([["s1", new Map([["L1", "c1"]])]]),
        now,
      }).shopify.s1!.mismatch,
    ).toBe(true);
  });
});

// ───────────── database ─────────────

async function group(label: string) {
  const r = await bootstrapOwner({
    email: `stock-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    name: "O",
    accountName: `Stock test ${label}`,
    password: "correct horse battery staple",
  });
  const accountId = r.account.id;
  const db = accountDb(accountId);
  const company = await systemDb().company.findFirstOrThrow({ where: { accountId } });
  const owner: ScopedActor = { userId: r.user.id, accountId, role: "OWNER", companyScope: null };
  const ctx: StockCtx & ScopedActor = {
    ...owner,
    activeCompanyId: null,
    activeLineId: null,
    lineCompanyIds: null,
  };
  const fhb = await db.fulfillmentConnection.create({
    data: { accountId, companyId: company.id, type: "FHB_V3", name: "FHB syn", liveMode: "LIVE" },
  });
  const eu = await db.fulfillmentConnection.create({
    data: {
      accountId,
      companyId: company.id,
      type: "EUSHIPMENTS",
      name: "EU syn",
      liveMode: "LIVE",
      vendorIds: { companyId: 333 },
    },
  });
  const store = await db.store.create({
    data: {
      accountId,
      companyId: company.id,
      domain: `stock-${label}-${Date.now()}.myshopify.com`,
      code: "ST",
      name: "Store",
      currency: "EUR",
      connectionStatus: { ok: true },
    },
  });
  const product = async (sku: string, extra: { isTester?: boolean; parentProductId?: string } = {}) =>
    db.product.create({ data: { accountId, sku, name: `Синтетичен ${sku}`, ...extra } });
  const vp = async (
    connectionId: string,
    productId: string,
    vendorId: string,
    level?: { physical: number; free: number; snapshotAt?: Date },
  ) =>
    db.vendorProduct.create({
      data: {
        accountId,
        connectionId,
        productId,
        vendorId,
        raw: { type: "single" },
        ...(level
          ? {
              stockLevel: {
                create: {
                  physical: level.physical,
                  free: level.free,
                  sellable: level.free,
                  snapshotAt: level.snapshotAt ?? new Date(),
                  source: "PUSH",
                },
              },
            }
          : {}),
      },
    });
  const link = async (productId: string | null, n: number, sku: string) =>
    db.storeVariantLink.create({
      data: {
        accountId,
        storeId: store.id,
        shopifyVariantGid: `gid://shopify/ProductVariant/${n}`,
        shopifyProductGid: `gid://shopify/Product/${n}`,
        sku,
        title: sku,
        productId,
      },
    });
  return { accountId, db, company, owner, ctx, fhb, eu, store, product, vp, link };
}

type G = Awaited<ReturnType<typeof group>>;

async function approvedOrder(g: G, productId: string, qty: number, connectionId: string) {
  return g.db.order.create({
    data: {
      accountId: g.accountId,
      companyId: g.company.id,
      source: "MANUAL",
      number: `M-${Math.random().toString(36).slice(2, 7)}`,
      status: "APPROVED",
      currency: "EUR",
      subtotal: 1,
      total: 1,
      paymentMethod: "PREPAID",
      placedAt: new Date(),
      lines: { create: [{ productId, title: "x", quantity: qty, unitPrice: 1 }] },
      check: { create: { connectionId, routing: {} } },
    },
  });
}

/** Fake Shopify: answers by operation name; records every call. */
function fakeShopify(handlers: Record<string, (vars: Record<string, unknown>) => unknown>) {
  const calls: { op: string; vars: Record<string, unknown> }[] = [];
  const client = {
    async query(doc: string, vars: Record<string, unknown>, schema: { parse: (x: unknown) => unknown }) {
      const op = /(?:query|mutation)\s+(\w+)/.exec(doc)![1]!;
      calls.push({ op, vars });
      const h = handlers[op];
      if (!h) throw new Error(`unexpected ${op}`);
      return schema.parse(await h(vars));
    },
  } as unknown as ShopifyClient;
  const clients: PushClients = async () => ({ client });
  return { calls, clients, count: (op: string) => calls.filter((c) => c.op === op).length };
}

describe("stock board", () => {
  let g: G;
  beforeAll(async () => {
    g = await group("board");
  });

  it("per master: warehouses, CRM reservation, Shopify per store, filters with counts, testers under original", async () => {
    const orig = await g.product("BRD-A");
    const tester = await g.product("BRD-T", { isTester: true, parentProductId: orig.id });
    const zero = await g.product("BRD-Z");
    await g.vp(g.fhb.id, orig.id, "R-BRD-A", { physical: 10, free: 9 });
    await g.vp(g.eu.id, orig.id, "EU-BRD-A", { physical: 4, free: 4 });
    await g.vp(g.fhb.id, tester.id, "R-BRD-T", { physical: 1, free: 1 });
    await g.vp(g.fhb.id, zero.id, "R-BRD-Z", { physical: 0, free: 0 });
    await approvedOrder(g, orig.id, 2, g.fhb.id);
    const l = await g.link(orig.id, 9001, "SH-BRD-A");
    await g.db.shopifyInventoryLevel.create({
      data: {
        accountId: g.accountId,
        storeId: g.store.id,
        variantLinkId: l.id,
        locationGid: "gid://shopify/Location/1",
        inventoryItemGid: "gid://shopify/InventoryItem/1",
        available: 30,
        fetchedAt: new Date(),
      },
    });
    const res = await crmReservations(g.accountId);
    expect(res.get(`${g.fhb.id}:${orig.id}`)).toBe(2);

    const board = await stockBoard(g.ctx, {});
    expect(board.rows.map((r) => r.sku)).toEqual(["BRD-A", "BRD-T", "BRD-Z"]);
    const a = board.rows[0]!;
    expect(a.cells[g.fhb.id]).toMatchObject({ physical: 10, free: 9, reserved: 2, sellable: 8 });
    expect(a.cells[g.eu.id]).toMatchObject({ sellable: 4 });
    expect(a.totalSellable).toBe(12);
    expect(a.shopify[g.store.id]).toMatchObject({ available: 30, mismatch: true });
    expect(board.counts).toMatchObject({ all: 3, inStock: 2, zero: 1, testers: 1, shopifyMismatch: 1 });
    expect((await stockBoard(g.ctx, { filter: "testers" })).rows.map((r) => r.sku)).toEqual(["BRD-T"]);
    // Search by a warehouse code; EAN is a search term only.
    expect((await stockBoard(g.ctx, { q: "EU-BRD" })).rows.map((r) => r.sku)).toEqual(["BRD-A"]);

    const d = await stockProductDetail(g.ctx, orig.id);
    expect(d?.row.totalSellable).toBe(12);
    expect(d?.product.testers.map((t) => t.sku)).toEqual(["BRD-T"]);
  });

  it("is scoped by account", async () => {
    const other = await group("board-other");
    expect((await stockBoard(other.ctx, {})).rows).toEqual([]);
    const own = await stockBoard(g.ctx, {});
    expect(await stockProductDetail(other.ctx, own.rows[0]!.id)).toBeNull();
  });

  it("raises a Shopify oversell alert and resolves it when the numbers agree again", async () => {
    const findings = await stockFindings(g.accountId);
    expect(findings.map((f) => f.kind)).toContain("stock_shopify_oversell");
    await sweepStockAlerts();
    const open = () =>
      g.db.alert.findMany({ where: { kind: "stock_shopify_oversell", status: { not: "RESOLVED" } } });
    expect(await open()).toHaveLength(1);
    await sweepStockAlerts(); // idempotent
    expect(await open()).toHaveLength(1);
    await g.db.shopifyInventoryLevel.updateMany({ data: { available: 12 } });
    await sweepStockAlerts();
    expect(await open()).toHaveLength(0);
  });

  it("stale snapshots raise an alert per warehouse; settings are admin-only and audited", async () => {
    await g.db.stockLevel.updateMany({
      where: { vendorProduct: { connectionId: g.eu.id } },
      data: { snapshotAt: new Date(Date.now() - 48 * 3_600_000) },
    });
    const kinds = (await stockFindings(g.accountId)).filter((f) => f.kind === "stock_snapshot_stale");
    expect(kinds.map((k) => k.entityId)).toEqual([g.eu.id]);
    await expect(
      updateStockSettings(
        { ...g.owner, role: "OPERATOR" },
        { shopifyThreshold: 1, fhbStaleHours: 2, euStaleHours: 72, runOutDays: 7 },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await updateStockSettings(g.owner, {
      shopifyThreshold: 1,
      fhbStaleHours: 2,
      euStaleHours: 72,
      runOutDays: 7,
    });
    expect((await stockFindings(g.accountId)).filter((f) => f.kind === "stock_snapshot_stale")).toEqual([]);
  });
});

describe("inbound", () => {
  let g: G;
  let p1: { id: string };
  let p2: { id: string };
  beforeAll(async () => {
    g = await group("inbound");
    p1 = await g.product("INB-1");
    p2 = await g.product("INB-2");
    await g.vp(g.fhb.id, p1.id, "R-INB-1");
    await g.vp(g.eu.id, p1.id, "EU-INB-1");
    await g.vp(g.eu.id, p2.id, "EU-INB-2");
  });

  it("resolves uploaded codes by our SKU or the warehouse code, never by EAN", async () => {
    await g.db.productEan.create({
      data: { accountId: g.accountId, productId: p2.id, ean: "0000000000024" },
    });
    const r = await resolveInboundLines(g.ctx, g.fhb.id, [
      { row: 1, code: "inb-1", quantity: 3 },
      { row: 2, code: "INB-2", quantity: 1 },
      { row: 3, code: "0000000000024", quantity: 1 },
      { row: 4, code: "EU-INB-2", quantity: 1 },
    ]);
    expect(r.map((x) => [x.code, x.productId, x.problem])).toEqual([
      ["inb-1", p1.id, null],
      ["INB-2", p2.id, "not_at_warehouse"],
      ["0000000000024", null, "not_found"],
      ["EU-INB-2", null, "not_found"],
    ]);
    const eu = await resolveInboundLines(g.ctx, g.eu.id, [{ row: 1, code: "EU-INB-2", quantity: 2 }]);
    expect(eu[0]).toMatchObject({ productId: p2.id, problem: null });
  });

  it("FHB: the same request token is one receipt and one outbox request", async () => {
    const input = {
      connectionId: g.fhb.id,
      requestToken: "token-fhb-0001",
      name: "Доставка 1",
      expectedDate: "2026-11-01",
      lines: [
        { productId: p1.id, quantity: 4 },
        { productId: p1.id, quantity: 1 },
      ],
    };
    const [a, b] = await Promise.all([createInbound(g.ctx, input), createInbound(g.ctx, input)]);
    expect(a.inboundId).toBe(b.inboundId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await g.db.inboundShipment.count({ where: { connectionId: g.fhb.id } })).toBe(1);
    expect(
      await g.db.outboundRequest.count({
        where: { connectionId: g.fhb.id, operation: "fhb.stockReceipt.create" },
      }),
    ).toBe(1);
    const d = await inboundDetail(g.ctx, a.inboundId);
    expect(d?.inbound.lines.map((l) => l.expectedQty)).toEqual([5]);
    expect(d?.requests).toHaveLength(1);
  });

  it("FHB: received quantities are read back, a difference opens a task that resolves itself", async () => {
    const inbound = await g.db.inboundShipment.findFirstOrThrow({ where: { connectionId: g.fhb.id } });
    await g.db.inboundShipment.update({
      where: { id: inbound.id },
      data: { vendorId: inbound.externalRef, status: "created" },
    });
    let received = 3;
    const client = {
      getStockReceipt: async (id: string) => ({
        id,
        status: "received",
        items: [{ id: "R-INB-1", quantity: 5, received }],
      }),
    } as unknown as Parameters<typeof pollFhbReceipts>[2];
    expect(await pollFhbReceipts(g.accountId, g.fhb.id, client)).toEqual({ checked: 1, missing: 0 });
    const line = await g.db.inboundLine.findFirstOrThrow({ where: { inboundId: inbound.id } });
    expect(line.receivedQty).toBe(3);
    await sweepInboundAlerts();
    const open = () =>
      g.db.alert.findMany({
        where: { kind: "fhb_inbound_discrepancy", entityId: inbound.id, status: { not: "RESOLVED" } },
      });
    expect(await open()).toHaveLength(1);
    await sweepInboundAlerts();
    expect(await open()).toHaveLength(1);
    received = 5;
    await pollFhbReceipts(g.accountId, g.fhb.id, client);
    await sweepInboundAlerts();
    expect(await open()).toHaveLength(0);
    const list = await listInbounds(g.ctx, { tab: "all" });
    expect(list.rows[0]!.totals).toEqual({ expected: 5, received: 5, differing: 0 });
  });

  it("euShipments: a booking per token; a repeat returns the same inbound; warehouse is required", async () => {
    const input = {
      connectionId: g.eu.id,
      requestToken: "token-eu-0001",
      name: "Booking 1",
      warehouseId: 7,
      lines: [{ productId: p2.id, quantity: 6 }],
    };
    await expect(createInbound(g.ctx, { ...input, warehouseId: undefined })).rejects.toMatchObject({
      code: "warehouse_required",
    });
    const a = await createInbound(g.ctx, input);
    const b = await createInbound(g.ctx, input);
    expect(b).toEqual({ inboundId: a.inboundId, created: false });
    const ib = await g.db.inboundShipment.findUniqueOrThrow({ where: { id: a.inboundId } });
    expect(ib.externalRef).toBe(bookingDocumentNumber(g.accountId, g.eu.id, "token-eu-0001"));
    expect(await g.db.outboundRequest.count({ where: { connectionId: g.eu.id } })).toBe(1);
  });

  it("refuses products outside the member's scope and roles without inbound.manage", async () => {
    await expect(
      createInbound(
        { ...g.ctx, role: "OPERATOR" },
        {
          connectionId: g.fhb.id,
          requestToken: "token-fhb-0002",
          name: "x",
          lines: [{ productId: p1.id, quantity: 1 }],
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const other = await group("inbound-other");
    await expect(
      createInbound(other.ctx, {
        connectionId: other.fhb.id,
        requestToken: "token-fhb-0003",
        name: "x",
        lines: [{ productId: p1.id, quantity: 1 }],
      }),
    ).rejects.toMatchObject({ code: "product_not_in_line" });
  });
});

describe("Shopify inventory read + push", () => {
  let g: G;
  let p: { id: string };
  let locId: string;
  const LOC = "gid://shopify/Location/77";
  const ITEM = "gid://shopify/InventoryItem/55";
  let shopifyAvailable = 3;

  const shop = () =>
    fakeShopify({
      StoreLocations: () => ({
        locations: {
          nodes: [{ id: LOC, name: "FHB склад", isActive: true, fulfillmentService: null }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
      LocationInventory: () => ({
        location: {
          id: LOC,
          inventoryLevels: {
            nodes: [
              {
                quantities: [
                  { name: "available", quantity: shopifyAvailable },
                  { name: "on_hand", quantity: shopifyAvailable },
                ],
                item: {
                  id: ITEM,
                  tracked: true,
                  variants: { nodes: [{ id: "gid://shopify/ProductVariant/7001" }] },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      InventoryReadBack: () => ({
        nodes: [
          {
            id: ITEM,
            tracked: true,
            inventoryLevel: { quantities: [{ name: "available", quantity: shopifyAvailable }] },
          },
        ],
      }),
      InventoryPush: (vars) => {
        const q = (vars.input as { quantities: { quantity: number }[] }).quantities[0]!;
        shopifyAvailable = q.quantity;
        return {
          inventorySetQuantities: {
            inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/1" },
            userErrors: [],
          },
        };
      },
    });

  beforeAll(async () => {
    g = await group("push");
    p = await g.product("PSH-1");
    await g.vp(g.fhb.id, p.id, "R-PSH-1", { physical: 20, free: 18 });
    await g.link(p.id, 7001, "SH-PSH-1");
    await g.db.store.update({ where: { id: g.store.id }, data: { inventoryBuffer: 2 } });
  });

  it("reads locations and levels into the mirror (reads only)", async () => {
    const s = shop();
    expect(await syncStoreInventory(g.accountId, g.store.id, s.clients)).toMatchObject({
      locations: 1,
      levels: 1,
    });
    expect(s.count("InventoryPush")).toBe(0);
    const lvl = await g.db.shopifyInventoryLevel.findFirstOrThrow({ where: { storeId: g.store.id } });
    expect(lvl).toMatchObject({ available: 3, inventoryItemGid: ITEM, locationGid: LOC });
    locId = (await g.db.storeLocation.findFirstOrThrow({ where: { storeId: g.store.id } })).id;
  });

  it("maps a location to one warehouse (admin only)", async () => {
    await expect(
      setLocationConnection(
        { ...g.owner, role: "OPERATOR" },
        { storeId: g.store.id, locationId: locId, connectionId: g.fhb.id },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await setLocationConnection(g.owner, { storeId: g.store.id, locationId: locId, connectionId: g.fhb.id });
    const plan = await planInventoryPush(g.accountId, g.store.id);
    expect(plan.lines).toEqual([
      expect.objectContaining({ sellable: 18, target: 16, shopifyNow: 3, locationGid: LOC }),
    ]);
  });

  it("DISABLED (default) refuses; DRY_RUN records the exact mutation with compare-and-set and sends nothing", async () => {
    await expect(createInventoryPush(g.store.id, { kind: "user", actor: g.owner })).rejects.toMatchObject({
      code: "inventory_push_disabled",
    });
    await g.db.store.update({ where: { id: g.store.id }, data: { inventoryPushMode: "DRY_RUN" } });
    const r = await createInventoryPush(g.store.id, { kind: "user", actor: g.owner });
    expect(r.created).toBe(true);
    // One open push per store.
    expect((await createInventoryPush(g.store.id, { kind: "system" })).created).toBe(false);
    const s = shop();
    expect(await processInventoryPush(r.pushId!, s.clients)).toBe("DRY_RUN_RECORDED");
    expect(s.count("InventoryPush")).toBe(0);
    const push = await g.db.inventoryPush.findUniqueOrThrow({
      where: { id: r.pushId! },
      include: { lines: true },
    });
    const req = push.request as { mutation: string; batches: { idempotencyKey: string; input: unknown }[] };
    expect(req.mutation).toBe(PUSH_MUTATION);
    expect(req.batches[0]!.idempotencyKey).toBe(pushIdempotencyKey(push.id, 0));
    expect(req.batches[0]!.input).toMatchObject({
      name: "available",
      reason: "correction",
      quantities: [{ inventoryItemId: ITEM, locationId: LOC, quantity: 16, changeFromQuantity: 3 }],
    });
    expect(push.lines[0]).toMatchObject({ status: "dry_run", shopifyBefore: 3, target: 16 });
  });

  it("LIVE sends once; a double process is skipped; a later push finds nothing to change", async () => {
    await g.db.store.update({ where: { id: g.store.id }, data: { inventoryPushMode: "LIVE" } });
    const r = await createInventoryPush(g.store.id, { kind: "user", actor: g.owner });
    const s = shop();
    const [x, y] = await Promise.all([
      processInventoryPush(r.pushId!, s.clients),
      processInventoryPush(r.pushId!, s.clients),
    ]);
    expect([x, y].sort()).toEqual(["SENT", "skipped"]);
    expect(s.count("InventoryPush")).toBe(1);
    expect(shopifyAvailable).toBe(16);
    expect(await processInventoryPush(r.pushId!, s.clients)).toBe("skipped");
    await syncStoreInventory(g.accountId, g.store.id, s.clients);
    expect((await createInventoryPush(g.store.id, { kind: "user", actor: g.owner })).reason).toBe(
      "nothing_to_push",
    );
  });

  it("the store page history: line counts by status, a few lines, the request only for the newest push", async () => {
    const list = await storePushes(g.accountId, g.store.id);
    expect(list.length).toBeGreaterThan(1);
    for (const p of list) {
      expect(p.total).toBe(Object.values(p.byStatus).reduce((a, n) => a + n, 0));
      expect(p.sample.length).toBeLessThanOrEqual(Math.min(10, p.total));
    }
    expect(list[0]!.request).not.toBeNull();
    expect(list.slice(1).every((p) => p.request === null)).toBe(true);
  });

  it("an unknown outcome is read back; a retry re-sends the stored variables under the same key", async () => {
    shopifyAvailable = 1;
    const s0 = shop();
    await syncStoreInventory(g.accountId, g.store.id, s0.clients);
    const r = await createInventoryPush(g.store.id, { kind: "system" });
    const keys: string[] = [];
    let fail = true;
    const s = fakeShopify({
      InventoryReadBack: () => ({
        nodes: [
          {
            id: ITEM,
            tracked: true,
            inventoryLevel: { quantities: [{ name: "available", quantity: shopifyAvailable }] },
          },
        ],
      }),
      InventoryPush: (vars) => {
        keys.push(vars.idempotencyKey as string);
        if (fail) throw new ShopifyError("http_error", "HTTP 502", 502);
        shopifyAvailable = 16;
        return { inventorySetQuantities: { inventoryAdjustmentGroup: { id: "g2" }, userErrors: [] } };
      },
    });
    expect(await processInventoryPush(r.pushId!, s.clients)).toBe("PENDING");
    fail = false;
    expect(await processInventoryPush(r.pushId!, s.clients, new Date(Date.now() + 3_600_000))).toBe("SENT");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(shopifyAvailable).toBe(16);
  });

  it("a stale compare value marks the line stale instead of overwriting; the kill switch parks pushes", async () => {
    shopifyAvailable = 5;
    await syncStoreInventory(g.accountId, g.store.id, shop().clients);
    const r = await createInventoryPush(g.store.id, { kind: "system" });
    const s = fakeShopify({
      InventoryReadBack: () => ({
        nodes: [
          { id: ITEM, tracked: true, inventoryLevel: { quantities: [{ name: "available", quantity: 5 }] } },
        ],
      }),
      InventoryPush: () => ({
        inventorySetQuantities: {
          inventoryAdjustmentGroup: null,
          userErrors: [{ code: "CHANGE_FROM_QUANTITY_STALE", field: ["input"], message: "stale" }],
        },
      }),
    });
    // Nothing applied: not SENT (no misleading success); the next push starts from fresh numbers.
    expect(await processInventoryPush(r.pushId!, s.clients)).toBe("FAILED");
    expect((await g.db.inventoryPushLine.findFirstOrThrow({ where: { pushId: r.pushId! } })).status).toBe(
      "stale",
    );
    expect((await g.db.inventoryPush.findUniqueOrThrow({ where: { id: r.pushId! } })).lastError).toMatch(
      /^stale_only/,
    );

    const r2 = await createInventoryPush(g.store.id, { kind: "system" });
    await systemDb().account.update({ where: { id: g.accountId }, data: { outboxPaused: true } });
    expect(await processInventoryPush(r2.pushId!, s.clients)).toBe("PAUSED");
    expect(s.count("InventoryPush")).toBe(1);
    await systemDb().account.update({ where: { id: g.accountId }, data: { outboxPaused: false } });
    const sweep = await sweepInventoryPushes();
    expect(sweep.ready.map((x) => x.id)).toContain(r2.pushId);
  });
});

// ───────────── audit fixes (wave 3 review) ─────────────

async function order(
  g: G,
  productId: string,
  qty: number,
  status: "NEEDS_REVIEW" | "IMPORTED" | "ACCEPTED",
  connectionId: string | null,
) {
  return g.db.order.create({
    data: {
      accountId: g.accountId,
      companyId: g.company.id,
      source: "MANUAL",
      number: `M-${Math.random().toString(36).slice(2, 7)}`,
      status,
      currency: "EUR",
      subtotal: 1,
      total: 1,
      paymentMethod: "PREPAID",
      placedAt: new Date(),
      lines: { create: [{ productId, title: "x", quantity: qty, unitPrice: 1 }] },
      ...(status === "IMPORTED" ? {} : { check: { create: { connectionId, routing: {} } } }),
    },
    include: { lines: true },
  });
}

/** A store location mapped to `connectionId` with the variant stocked at Shopify `available`. */
async function mapped(g: G, productId: string, connectionId: string, available: number, n: number) {
  const gid = `gid://shopify/Location/${n}`;
  await g.db.storeLocation.create({
    data: {
      accountId: g.accountId,
      storeId: g.store.id,
      shopifyLocationGid: gid,
      name: `L${n}`,
      connectionId,
      fetchedAt: new Date(),
    },
  });
  const link = await g.link(productId, n, `SH-${n}`);
  await g.db.shopifyInventoryLevel.create({
    data: {
      accountId: g.accountId,
      storeId: g.store.id,
      variantLinkId: link.id,
      locationGid: gid,
      inventoryItemGid: `gid://shopify/InventoryItem/${n}`,
      available,
      fetchedAt: new Date(),
    },
  });
  return { gid, link };
}

const targetOf = async (g: G, gid: string) =>
  (await planInventoryPush(g.accountId, g.store.id)).lines.find((l) => l.locationGid === gid)?.target;

describe("stock board explains a differing Shopify cell with the push planner's own reasons", () => {
  const LOC_N = 8301;
  it("store blocks, will push, applied (waiting for the read / overwritten), failed, skips", async () => {
    const g = await group("why");
    const now = new Date();
    const a = await g.product("WHY-A");
    await g.vp(g.fhb.id, a.id, "R-WHY-A", { physical: 10, free: 10 });
    const { gid, link } = await mapped(g, a.id, g.fhb.id, 3, LOC_N);
    // At the mapped warehouse only as a stale snapshot.
    const stale = await g.product("WHY-S");
    await g.vp(g.fhb.id, stale.id, "R-WHY-S", {
      physical: 5,
      free: 5,
      snapshotAt: new Date(now.getTime() - 30 * 86_400_000),
    });
    const ls = await g.link(stale.id, LOC_N + 1, "SH-WHY-S");
    // Only at the OTHER (unmapped) warehouse, yet stocked at the mapped location.
    const other = await g.product("WHY-O");
    await g.vp(g.eu.id, other.id, "EU-WHY-O", { physical: 6, free: 6 });
    const lo = await g.link(other.id, LOC_N + 2, "SH-WHY-O");
    for (const [l, n] of [
      [ls, LOC_N + 1],
      [lo, LOC_N + 2],
    ] as const)
      await g.db.shopifyInventoryLevel.create({
        data: {
          accountId: g.accountId,
          storeId: g.store.id,
          variantLinkId: l.id,
          locationGid: gid,
          inventoryItemGid: `gid://shopify/InventoryItem/${n}`,
          available: 9,
          fetchedAt: now,
        },
      });
    const why = async (sku: string) =>
      (await stockBoard(g.ctx, {})).rows.find((r) => r.sku === sku)!.shopify[g.store.id]!.why;

    expect(await why("WHY-A")).toEqual({
      store: ["push_off"],
      // Push is off: what it WOULD set, never "within 10 min".
      locations: [{ locationName: `L${LOC_N}`, sku: null, why: { kind: "would_set", target: 10 } }],
    });
    expect((await why("WHY-S"))!.locations[0]!.why).toEqual({ kind: "stale_snapshot" });
    expect((await why("WHY-O"))!.locations[0]!.why).toEqual({ kind: "not_at_warehouse" });

    await g.db.store.update({ where: { id: g.store.id }, data: { inventoryPushMode: "LIVE" } });
    const sentAt = new Date(now.getTime() + 60_000);
    const push = (status: string, target: number, at: Date) =>
      g.db.inventoryPush.create({
        data: {
          accountId: g.accountId,
          storeId: g.store.id,
          trigger: "cron",
          status: "SENT",
          buffer: 0,
          sentAt: at,
          createdAt: at,
          lines: {
            create: {
              variantLinkId: link.id,
              productId: a.id,
              connectionId: g.fhb.id,
              locationGid: gid,
              inventoryItemGid: `gid://shopify/InventoryItem/${LOC_N}`,
              sellable: target,
              target,
              shopifyBefore: 3,
              status,
            },
          },
        },
      });
    // An older failed line is superseded by the newest one.
    await push("failed", 10, new Date(now.getTime() - 60_000));
    expect((await why("WHY-A"))!.locations[0]!.why).toMatchObject({ kind: "failed" });
    await push("applied", 10, sentAt);
    // Applied after our last read of Shopify: not "overwritten", just not read back yet.
    expect(await why("WHY-A")).toEqual({
      store: [],
      locations: [
        {
          locationName: `L${LOC_N}`,
          sku: null,
          why: { kind: "applied_waiting_read", target: 10, at: sentAt },
        },
      ],
    });
    // A later read still shows 3: something else wrote it.
    await g.db.shopifyInventoryLevel.updateMany({
      where: { variantLinkId: link.id },
      data: { fetchedAt: new Date(sentAt.getTime() + 60_000) },
    });
    expect((await why("WHY-A"))!.locations[0]!.why).toEqual({ kind: "overwritten", target: 10, at: sentAt });
    // Another account's newer push line with the same ids never leaks in (the raw query is scoped by account).
    const o = await group("why-other");
    await o.db.inventoryPush.create({
      data: {
        accountId: o.accountId,
        storeId: o.store.id,
        trigger: "cron",
        status: "FAILED",
        lastError: "other account",
        buffer: 0,
        createdAt: new Date(sentAt.getTime() + 120_000),
        lines: {
          create: {
            variantLinkId: link.id,
            connectionId: o.fhb.id,
            locationGid: gid,
            inventoryItemGid: "gid://shopify/InventoryItem/1",
            sellable: 1,
            target: 1,
            status: "failed",
            error: "other account",
          },
        },
      },
    });
    expect((await why("WHY-A"))!.locations[0]!.why).toEqual({ kind: "overwritten", target: 10, at: sentAt });
    // Disconnected store: a store-wide block.
    await g.db.store.update({ where: { id: g.store.id }, data: { connectionStatus: { ok: false } } });
    expect((await why("WHY-A"))!.store).toEqual(["disconnected"]);
    // What already happened (the overwrite) is still reported next to the block.
    expect((await why("WHY-A"))!.locations[0]!.why).toMatchObject({ kind: "overwritten" });
    // No active mapped location: nothing is ever pushed to this store.
    await g.db.storeLocation.updateMany({ where: { storeId: g.store.id }, data: { isActive: false } });
    expect((await why("WHY-A"))!.store).toEqual(["disconnected", "no_location"]);
  });
});

describe("reservations cover every order not inside the warehouse numbers yet", () => {
  it("an order in NEEDS_REVIEW (routed or not) lowers the push target", async () => {
    const g = await group("resv-review");
    const p = await g.product("RSV-1");
    await g.vp(g.fhb.id, p.id, "R-RSV-1", { physical: 10, free: 10 });
    const { gid } = await mapped(g, p.id, g.fhb.id, 10, 8101);
    expect(await targetOf(g, gid)).toBe(10);
    // Shopify already took 2 as "committed" (available 8); the order waits in review, routed to FHB.
    await order(g, p.id, 2, "NEEDS_REVIEW", g.fhb.id);
    expect(await targetOf(g, gid)).toBe(8);
    // Not routed yet: reserved at every warehouse carrying the product.
    await order(g, p.id, 1, "IMPORTED", null);
    expect(await targetOf(g, gid)).toBe(7);
    expect((await crmReservations(g.accountId)).get(`${g.fhb.id}:${p.id}`)).toBe(3);
  });

  it("euShipments: an order accepted after the (daily) snapshot lowers the target, one before does not", async () => {
    const g = await group("resv-eu");
    const p = await g.product("RSV-EU");
    const snapshotAt = new Date(Date.now() - 6 * 3_600_000);
    await g.vp(g.eu.id, p.id, "EU-RSV", { physical: 10, free: 10, snapshotAt });
    const { gid } = await mapped(g, p.id, g.eu.id, 10, 8201);
    const ship = async (acceptedAt: Date, qty: number) => {
      const o = await order(g, p.id, qty, "ACCEPTED", g.eu.id);
      await g.db.fulfillment.create({
        data: {
          accountId: g.accountId,
          orderId: o.id,
          connectionId: g.eu.id,
          externalId: `ST-${o.number}`,
          status: "ACCEPTED",
          submittedAt: acceptedAt,
          lines: { create: [{ orderLineId: o.lines[0]!.id, quantity: qty }] },
        },
      });
    };
    await ship(new Date(snapshotAt.getTime() - 3_600_000), 4); // already excluded from the vendor's free
    expect(await targetOf(g, gid)).toBe(10);
    await ship(new Date(), 3); // accepted this morning, the snapshot does not know it yet
    expect(await targetOf(g, gid)).toBe(7);
  });
});

describe("push plans expire", () => {
  it("PAUSED, then warehouse free drops, then unpause: the old target is never sent", async () => {
    const g = await group("push-expire");
    const p = await g.product("EXP-1");
    const v = await g.vp(g.fhb.id, p.id, "R-EXP-1", { physical: 10, free: 10 });
    const { gid } = await mapped(g, p.id, g.fhb.id, 2, 8301);
    await g.db.store.update({ where: { id: g.store.id }, data: { inventoryPushMode: "LIVE" } });
    const r = await createInventoryPush(g.store.id, { kind: "system" });
    await systemDb().account.update({ where: { id: g.accountId }, data: { outboxPaused: true } });
    const s = fakeShopify({
      InventoryReadBack: () => ({
        nodes: [
          {
            id: "gid://shopify/InventoryItem/8301",
            tracked: true,
            inventoryLevel: { quantities: [{ name: "available", quantity: 2 }] },
          },
        ],
      }),
      InventoryPush: () => ({
        inventorySetQuantities: { inventoryAdjustmentGroup: { id: "g" }, userErrors: [] },
      }),
    });
    expect(await processInventoryPush(r.pushId!, s.clients)).toBe("PAUSED");
    await g.db.stockLevel.update({ where: { vendorProductId: v.id }, data: { free: 4, physical: 4 } });
    await systemDb().account.update({ where: { id: g.accountId }, data: { outboxPaused: false } });
    expect(await processInventoryPush(r.pushId!, s.clients)).toBe("FAILED");
    expect(s.count("InventoryPush")).toBe(0);
    expect(await g.db.inventoryPush.findUniqueOrThrow({ where: { id: r.pushId! } })).toMatchObject({
      lastError: "plan_expired",
    });
    expect(await g.db.alert.count({ where: { kind: "inventory_push_failed" } })).toBe(0);
    // The next push plans from today's numbers.
    const r2 = await createInventoryPush(g.store.id, { kind: "system" });
    expect(r2.created).toBe(true);
    expect(await processInventoryPush(r2.pushId!, s.clients)).toBe("SENT");
    const sent = s.calls.find((c) => c.op === "InventoryPush")!;
    expect((sent.vars.input as { quantities: { quantity: number }[] }).quantities[0]!.quantity).toBe(4);
    expect(await targetOf(g, gid)).toBe(4);
  });

  it("an unbuilt push older than the TTL is expired by the sweep and replaced", async () => {
    const g = await group("push-ttl");
    const p = await g.product("TTL-1");
    await g.vp(g.fhb.id, p.id, "R-TTL-1", { physical: 5, free: 5 });
    await mapped(g, p.id, g.fhb.id, 1, 8401);
    await g.db.store.update({ where: { id: g.store.id }, data: { inventoryPushMode: "DRY_RUN" } });
    const r = await createInventoryPush(g.store.id, { kind: "system" });
    await g.db.inventoryPush.update({
      where: { id: r.pushId! },
      data: { status: "PAUSED", createdAt: new Date(Date.now() - 3 * 3_600_000) },
    });
    const sweep = await sweepInventoryPushes();
    expect(await g.db.inventoryPush.findUniqueOrThrow({ where: { id: r.pushId! } })).toMatchObject({
      status: "FAILED",
      lastError: "plan_expired",
    });
    expect(sweep.ready.map((x) => x.id)).not.toContain(r.pushId);
    expect(await g.db.inventoryPush.count({ where: { storeId: g.store.id, status: "PENDING" } })).toBe(1);
  });
});

describe("location mapping guards", () => {
  it("refuses another company's warehouse; concurrent mappings to one warehouse end in a domain error", async () => {
    const g = await group("map-guard");
    const other = await g.db.company.create({ data: { accountId: g.accountId, name: "Друга фирма" } });
    const foreign = await g.db.fulfillmentConnection.create({
      data: {
        accountId: g.accountId,
        companyId: other.id,
        type: "FHB_V3",
        name: "FHB other",
        liveMode: "LIVE",
      },
    });
    const loc = async (n: number) =>
      g.db.storeLocation.create({
        data: {
          accountId: g.accountId,
          storeId: g.store.id,
          shopifyLocationGid: `gid://shopify/Location/${n}`,
          name: `L${n}`,
          fetchedAt: new Date(),
        },
      });
    const a = await loc(8501);
    const b = await loc(8502);
    await expect(
      setLocationConnection(g.owner, { storeId: g.store.id, locationId: a.id, connectionId: foreign.id }),
    ).rejects.toMatchObject({ code: "connection_other_company" });
    const results = await Promise.allSettled([
      setLocationConnection(g.owner, { storeId: g.store.id, locationId: a.id, connectionId: g.fhb.id }),
      setLocationConnection(g.owner, { storeId: g.store.id, locationId: b.id, connectionId: g.fhb.id }),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "location_connection_taken" });
  });
});

describe("stock alert suppression", () => {
  it("an auto-resolved alert does not mute the condition when it returns; a person's resolution does", async () => {
    const g = await group("suppress");
    const p = await g.product("SUP-1");
    const v = await g.vp(g.fhb.id, p.id, "R-SUP-1", { physical: 2, free: 2 });
    await approvedOrder(g, p.id, 5, g.fhb.id); // physical − reserved < 0
    const open = () =>
      g.db.alert.findMany({ where: { kind: "stock_negative_sellable", status: { not: "RESOLVED" } } });
    await sweepStockAlerts();
    expect(await open()).toHaveLength(1);
    await g.db.stockLevel.update({ where: { vendorProductId: v.id }, data: { physical: 20, free: 20 } });
    await sweepStockAlerts(); // auto-resolved
    expect(await open()).toHaveLength(0);
    await g.db.stockLevel.update({ where: { vendorProductId: v.id }, data: { physical: 2, free: 2 } });
    await sweepStockAlerts(); // the condition is back: alerted again
    const [again] = await open();
    expect(again).toBeDefined();
    // A person resolves it: muted for the suppression window.
    await g.db.alert.update({
      where: { id: again!.id },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    await g.db.alertNote.create({
      data: { accountId: g.accountId, alertId: again!.id, userId: g.owner.userId, action: "resolve" },
    });
    await sweepStockAlerts();
    expect(await open()).toHaveLength(0);
  });
});
