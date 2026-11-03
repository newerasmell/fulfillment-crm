import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/auth/rbac";
import { systemDb } from "@/server/db/client";
import { writeCsv } from "@/lib/xlsx";
import {
  codReport,
  ordersCsv,
  ordersReport,
  parseRange,
  presetRange,
  rate,
  reviewReport,
  shipmentsCsv,
  shipmentsReport,
  sofiaDay,
  sofiaDayStart,
  stockReport,
  timingReport,
  type ReportCtx,
} from "./index";
import { scopeCompanyIds } from "./sql";

// Synthetic data only; every DB test works in its own account and filters by it (the test DB is shared).

const NOW = new Date("2026-11-02T10:00:00Z");
const H = 3_600_000;

describe("range (pure)", () => {
  it("Sofia days map to UTC instants across DST", () => {
    expect(sofiaDayStart("2026-01-15").toISOString()).toBe("2026-01-14T22:00:00.000Z");
    expect(sofiaDayStart("2026-07-15").toISOString()).toBe("2026-07-14T21:00:00.000Z");
    // DST ends on 2026-10-25 in Sofia (03:00 EEST → 02:00 EET).
    expect(sofiaDayStart("2026-10-25").toISOString()).toBe("2026-10-24T21:00:00.000Z");
    expect(sofiaDayStart("2026-10-26").toISOString()).toBe("2026-10-25T22:00:00.000Z");
    expect(sofiaDay(new Date("2026-11-01T22:30:00Z"))).toBe("2026-11-02");
  });

  it("parses, swaps, clamps and falls back to the last 30 days", () => {
    const d = parseRange({}, NOW);
    expect(d).toMatchObject({ from: "2026-10-04", to: "2026-11-02", days: 30, preset: "30d" });
    expect(parseRange({ from: "2026-11-01", to: "2026-10-01" }, NOW)).toMatchObject({
      from: "2026-10-01",
      to: "2026-11-01",
    });
    expect(parseRange({ from: "2020-01-01", to: "2026-11-01" }, NOW).days).toBe(366);
    expect(parseRange({ from: "2026-02-30", to: "x" }, NOW).preset).toBe("30d");
    expect(parseRange({ preset: "7d" }, NOW)).toMatchObject({ from: "2026-10-27", to: "2026-11-02" });
    expect(presetRange("lastMonth", NOW)).toMatchObject({ from: "2026-10-01", to: "2026-10-31", days: 31 });
    expect(presetRange("thisMonth", NOW)).toMatchObject({ from: "2026-11-01", to: "2026-11-02" });
  });

  it("rates exclude nothing-sent; company scope follows the sidebar", () => {
    expect(rate(3, 4)).toBe(0.75);
    expect(rate(0, 0)).toBeNull();
    const base = { accountId: "a", role: "OWNER", companyScope: null, activeLineId: null };
    expect(scopeCompanyIds({ ...base, activeCompanyId: null, lineCompanyIds: null })).toBeNull();
    expect(scopeCompanyIds({ ...base, activeCompanyId: "c1", lineCompanyIds: ["c1", "c2"] })).toEqual(["c1"]);
    expect(scopeCompanyIds({ ...base, activeCompanyId: null, lineCompanyIds: [] })).toEqual([]);
    expect(
      scopeCompanyIds({ ...base, companyScope: ["c3"], activeCompanyId: null, lineCompanyIds: null }),
    ).toEqual(["c3"]);
  });
});

let seq = 0;
async function setup() {
  const n = `${Date.now()}-${++seq}`;
  const sys = systemDb();
  const account = await sys.account.create({ data: { name: `Reports ${n}` } });
  const accountId = account.id;
  const coA = await sys.company.create({ data: { accountId, name: "Фирма А" } });
  const coB = await sys.company.create({ data: { accountId, name: "Фирма Б" } });
  const store = await sys.store.create({
    data: {
      accountId,
      companyId: coA.id,
      domain: `r-${n}.example`,
      code: "RA",
      name: "Магазин А",
      currency: "EUR",
    },
  });
  const fhb = await sys.fulfillmentConnection.create({
    data: { accountId, companyId: coA.id, name: "FHB Справки", type: "FHB_V3" },
  });
  const eu = await sys.fulfillmentConnection.create({
    data: { accountId, companyId: coB.id, name: "euShipments Справки", type: "EUSHIPMENTS" },
  });
  await sys.fhbCarrier.create({
    data: { accountId, connectionId: fhb.id, code: "gls", name: "GLS", lastSyncAt: NOW },
  });
  const ctx: ReportCtx = {
    accountId,
    role: "OWNER",
    companyScope: null,
    activeCompanyId: null,
    activeLineId: null,
    lineCompanyIds: null,
  };
  let k = 0;
  const order = async (o: {
    company: string;
    placed: Date;
    currency?: string;
    total?: number;
    cod?: boolean;
    status?: "IMPORTED" | "DELIVERED" | "CANCELLED" | "ON_HOLD" | "BLOCKED" | "SHIPPED" | "RETURNING";
    store?: boolean;
  }) =>
    sys.order.create({
      data: {
        accountId,
        companyId: o.company,
        storeId: o.store === false ? null : store.id,
        source: o.store === false ? "MANUAL" : "SHOPIFY",
        number: `#R-${n}-${++k}`,
        currency: o.currency ?? "EUR",
        subtotal: o.total ?? 10,
        total: o.total ?? 10,
        paymentMethod: o.cod ? "COD" : "PREPAID",
        codAmount: o.cod ? (o.total ?? 10) : null,
        codLocalAmount: o.cod ? (o.total ?? 10) : null,
        codLocalCurrency: o.cod ? (o.currency ?? "EUR") : null,
        placedAt: o.placed,
        createdAt: new Date(o.placed.getTime() + 0.5 * H),
        status: o.status ?? "IMPORTED",
      },
    });
  const ship = (
    orderId: string,
    connectionId: string,
    f: {
      status: "SHIPPED" | "DELIVERED" | "RETURNING" | "CANCELLED" | "SUBMIT_FAILED" | "COD_PAID";
      created: Date;
      carrier?: string;
      submitted?: Date;
      shipped?: Date;
      delivered?: Date;
    },
  ) =>
    sys.fulfillment.create({
      data: {
        accountId,
        orderId,
        connectionId,
        externalId: `R-${n}-${++k}`,
        status: f.status,
        carrier: f.carrier ?? null,
        createdAt: f.created,
        submittedAt: f.submitted ?? null,
        shippedAt: f.shipped ?? null,
        deliveredAt: f.delivered ?? null,
      },
    });
  return { accountId, ctx, coA, coB, store, fhb, eu, order, ship, sys };
}

describe("reports on the database", () => {
  it("orders: per Sofia day, per currency (never mixed), COD share, by store and company, scope", async () => {
    const s = await setup();
    // 2026-10-31 23:30 Sofia = 21:30 UTC (EET, UTC+2) → counts on 31 Oct, not 1 Nov... and 22:30 UTC → 1 Nov.
    await s.order({ company: s.coA.id, placed: new Date("2026-10-31T21:30:00Z"), cod: true, total: 20 });
    await s.order({ company: s.coA.id, placed: new Date("2026-10-31T22:30:00Z"), total: 5.5 });
    await s.order({
      company: s.coB.id,
      placed: new Date("2026-11-01T09:00:00Z"),
      currency: "HUF",
      total: 5000,
      cod: true,
      store: false,
    });
    await s.order({
      company: s.coB.id,
      placed: new Date("2026-11-01T10:00:00Z"),
      status: "CANCELLED",
      total: 99,
    });
    await s.order({ company: s.coA.id, placed: new Date("2026-09-01T10:00:00Z"), total: 1 }); // outside
    const range = parseRange({ from: "2026-10-31", to: "2026-11-02" }, NOW);
    const r = await ordersReport(s.ctx, range);
    expect(r.orders).toBe(3);
    expect(r.cod).toBe(2);
    expect(r.cancelled).toBe(1);
    expect(r.days.map((d) => [d.day, d.orders, d.cod, d.cancelled])).toEqual([
      ["2026-10-31", 1, 1, 0],
      ["2026-11-01", 2, 1, 1],
      ["2026-11-02", 0, 0, 0],
    ]);
    expect(r.totals).toEqual(
      expect.arrayContaining([
        { currency: "EUR", count: 2, cod: 1, totalCents: 2550, codCents: 2000 },
        { currency: "HUF", count: 1, cod: 1, totalCents: 500000, codCents: 500000 },
      ]),
    );
    expect(r.byStore.find((g) => g.id === s.store.id)).toMatchObject({ name: "Магазин А", orders: 2 });
    expect(r.byStore.find((g) => g.id === null)).toMatchObject({ orders: 1 });
    expect(r.byCompany.find((g) => g.id === s.coB.id)?.totals).toEqual([
      { currency: "HUF", count: 1, cod: 1, totalCents: 500000, codCents: 500000 },
    ]);
    // Company scope (restricted member / sidebar company).
    const onlyB = await ordersReport({ ...s.ctx, activeCompanyId: s.coB.id }, range);
    expect(onlyB.orders).toBe(1);
    expect((await ordersReport({ ...s.ctx, lineCompanyIds: [] }, range)).orders).toBe(0);
    const csv = writeCsv(ordersCsv(r, { manual: "manual", noCompany: "-" }));
    expect(csv).toContain("total;;EUR;2;1;50.0;;25.50");
    // Viewers have no reports.read.
    await expect(ordersReport({ ...s.ctx, role: "VIEWER" }, range)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("shipments: sent / delivered / returned / cancelled per warehouse and carrier, rates, warehouse scope", async () => {
    const s = await setup();
    const t = new Date("2026-10-20T10:00:00Z");
    // One active shipment per order (DB guard), so one order per shipment here.
    const one = async (company: string, connectionId: string, f: Parameters<typeof s.ship>[2]) =>
      s.ship((await s.order({ company, placed: t, cod: true })).id, connectionId, f);
    await one(s.coA.id, s.fhb.id, {
      status: "DELIVERED",
      created: t,
      carrier: "gls",
      shipped: t,
      delivered: t,
    });
    await one(s.coA.id, s.fhb.id, { status: "RETURNING", created: t, carrier: "gls", shipped: t });
    await one(s.coA.id, s.fhb.id, { status: "SHIPPED", created: t, carrier: "gls", shipped: t });
    await one(s.coA.id, s.fhb.id, { status: "CANCELLED", created: t, carrier: "gls" });
    await one(s.coB.id, s.eu.id, { status: "COD_PAID", created: t, shipped: t });
    await one(s.coB.id, s.eu.id, { status: "SUBMIT_FAILED", created: t });
    const range = parseRange({ from: "2026-10-01", to: "2026-10-31" }, NOW);
    const r = await shipmentsReport(s.ctx, range);
    const f = r.warehouses.find((w) => w.connectionId === s.fhb.id)!;
    expect(f).toMatchObject({ created: 4, sent: 3, delivered: 1, returned: 1, inTransit: 1, cancelled: 1 });
    expect(f.carriers[0]).toMatchObject({ carrier: "gls", carrierName: "GLS" });
    expect(rate(f.delivered, f.sent)).toBeCloseTo(1 / 3);
    expect(r.warehouses.find((w) => w.connectionId === s.eu.id)).toMatchObject({
      created: 2,
      sent: 1,
      delivered: 1,
      failed: 1,
    });
    expect(r.total.sent).toBe(4);
    const euOnly = await shipmentsReport({ ...s.ctx, connectionTypes: ["EUSHIPMENTS"] }, range);
    expect(euOnly.warehouses.map((w) => w.connectionId)).toEqual([s.eu.id]);
    expect(writeCsv(shipmentsCsv(r, { noCarrier: "-" }))).toContain(
      "FHB Справки;FHB_V3;GLS (gls);4;3;1;1;1;1;0;33.3;33.3",
    );
  });

  it("timing: median and p90 per step from OrderEvent + Fulfillment times", async () => {
    const s = await setup();
    const base = new Date("2026-10-10T08:00:00Z");
    for (const [i, hours] of [
      [0, 1],
      [1, 2],
      [2, 3],
    ] as const) {
      const placed = new Date(base.getTime() + i * 24 * H);
      const o = await s.order({ company: s.coA.id, placed, status: "DELIVERED" });
      // imported = placed + 0.5 h; approved after `hours` more.
      const approved = new Date(o.createdAt.getTime() + hours * H);
      await s.sys.orderEvent.create({
        data: {
          accountId: s.accountId,
          orderId: o.id,
          toStatus: "APPROVED",
          cause: "approve",
          actorType: "user",
          createdAt: approved,
        },
      });
      const submitted = new Date(approved.getTime() + H);
      await s.ship(o.id, s.fhb.id, {
        status: "DELIVERED",
        created: submitted,
        submitted,
        shipped: new Date(submitted.getTime() + 10 * H),
        delivered: new Date(submitted.getTime() + 58 * H),
      });
    }
    // An order without shipment: only the approve step can count.
    await s.order({ company: s.coB.id, placed: base });
    const range = parseRange({ from: "2026-10-01", to: "2026-10-31" }, NOW);
    const r = await timingReport(s.ctx, range);
    expect(r.overall?.orders).toBe(4);
    expect(r.overall?.stages.approve).toMatchObject({ n: 3, median: 2 * 3600 });
    expect(r.overall?.stages.approve.p90).toBeCloseTo(2.8 * 3600);
    expect(r.overall?.stages.submit).toMatchObject({ n: 3, median: 3600 });
    expect(r.overall?.stages.ship).toMatchObject({ n: 3, median: 10 * 3600 });
    expect(r.overall?.stages.deliver).toMatchObject({ n: 3, median: 48 * 3600 });
    expect(r.overall?.stages.total).toMatchObject({ n: 3, median: 61 * 3600 });
    const fhbRow = r.warehouses.find((w) => w.connectionId === s.fhb.id)!;
    expect(fhbRow).toMatchObject({ name: "FHB Справки", orders: 3 });
    expect(r.warehouses.find((w) => w.connectionId === null)?.orders).toBe(1);
    const eu = await timingReport({ ...s.ctx, connectionTypes: ["EUSHIPMENTS"] }, range);
    expect(eu.overall).toBeNull();
  });

  it("COD: totals per currency and warehouse, ageing, from the COD board rows", async () => {
    const s = await setup();
    const created = new Date("2026-10-15T10:00:00Z");
    const a = await s.order({
      company: s.coA.id,
      placed: created,
      cod: true,
      total: 25,
      status: "DELIVERED",
    });
    await s.ship(a.id, s.fhb.id, {
      status: "DELIVERED",
      created,
      delivered: new Date("2026-10-30T10:00:00Z"),
    });
    const b = await s.order({
      company: s.coB.id,
      placed: created,
      cod: true,
      total: 5000,
      currency: "HUF",
      status: "DELIVERED",
    });
    const fb = await s.ship(b.id, s.eu.id, {
      status: "COD_PAID",
      created,
      delivered: new Date("2026-10-16T10:00:00Z"),
    });
    await s.sys.eushipmentsTracking.create({
      data: {
        accountId: s.accountId,
        connectionId: s.eu.id,
        fulfillmentId: fb.id,
        referenceNumber: fb.externalId,
        codAmount: "5000",
        codPaidAt: NOW,
        codCheckedAt: NOW,
      },
    });
    const range = parseRange({ from: "2026-10-01", to: "2026-10-31" }, NOW);
    const r = await codReport(s.ctx, range, NOW);
    expect(r.byCurrency).toEqual([
      expect.objectContaining({ currency: "EUR", expected: 25, outstanding: 25, paid: 0 }),
      expect.objectContaining({ currency: "HUF", expected: 5000, paid: 5000, outstanding: 0 }),
    ]);
    expect(r.byWarehouse.map((w) => w.name)).toEqual(["euShipments Справки", "FHB Справки"]);
    expect(r.ageing).toEqual([
      { currency: "EUR", buckets: expect.objectContaining({ d0_7: { count: 1, amount: 25 } }) },
    ]);
    const outside = await codReport(s.ctx, parseRange({ from: "2026-09-01", to: "2026-09-30" }, NOW), NOW);
    expect(outside.shipments).toBe(0);
  });

  it("review: findings, decisions, reasons, open states; AI agreement only when AI data exist", async () => {
    const s = await setup();
    const t = new Date("2026-10-10T08:00:00Z");
    const o1 = await s.order({ company: s.coA.id, placed: t, status: "ON_HOLD" });
    const o2 = await s.order({ company: s.coA.id, placed: t, status: "BLOCKED" });
    for (const o of [o1, o2])
      await s.sys.orderCheck.create({
        data: {
          accountId: s.accountId,
          orderId: o.id,
          routing: {},
          findings: [{ code: "phone_invalid", severity: "hard", message_bg: "Невалиден телефон" }],
          hardCount: 1,
        },
      });
    await s.sys.review.create({
      data: {
        accountId: s.accountId,
        orderId: o1.id,
        decision: "HOLD",
        reasonCode: "customer_contact",
        timeSpentMs: 4000,
        decidedAt: t,
      },
    });
    await s.sys.review.create({
      data: {
        accountId: s.accountId,
        orderId: o2.id,
        decision: "APPROVE",
        reasonCode: "customer_contact",
        timeSpentMs: 2000,
        decidedAt: t,
      },
    });
    const range = parseRange({ from: "2026-10-01", to: "2026-10-31" }, NOW);
    const r = await reviewReport(s.ctx, range);
    expect(r.findings).toEqual([
      { code: "phone_invalid", severity: "hard", n: 2, sample: "Невалиден телефон" },
    ]);
    expect(r.decided).toBe(2);
    expect(r.reasons).toEqual([expect.objectContaining({ code: "customer_contact", count: 2 })]);
    expect(r.open).toEqual({ NEEDS_REVIEW: 0, ON_HOLD: 1, BLOCKED: 1 });
    expect(r.ai).toBeNull();
    await s.sys.aiSuggestion.create({
      data: {
        accountId: s.accountId,
        orderId: o2.id,
        model: "test-model",
        decision: "APPROVE",
        confidence: 0.9,
        explanationBg: "тест",
        orderStatus: "NEEDS_REVIEW",
        decisionAgreed: true,
        evaluatedAt: t,
      },
    });
    const withAi = await reviewReport(s.ctx, range);
    expect(withAi.ai).toMatchObject({ suggestions: 1, evaluated: 1, agreement: 1, target: 0.98 });
    // An operator restricted to company B sees none of it.
    const b = await reviewReport({ ...s.ctx, role: "OPERATOR", companyScope: [s.coB.id] }, range);
    expect(b.decided).toBe(0);
    expect(b.findings).toEqual([]);
    expect(b.ai).toBeNull();
  });

  it("stock: zero stock with open orders, from the stock board rows", async () => {
    const s = await setup();
    const p = await s.sys.product.create({
      data: { accountId: s.accountId, sku: `RS-${s.accountId}`, name: "Крем" },
    });
    const vp = await s.sys.vendorProduct.create({
      data: { accountId: s.accountId, connectionId: s.fhb.id, productId: p.id, vendorId: `V-${s.accountId}` },
    });
    await s.sys.stockLevel.create({
      data: {
        accountId: s.accountId,
        vendorProductId: vp.id,
        physical: 0,
        free: 0,
        snapshotAt: NOW,
        source: "POLL",
      },
    });
    const o = await s.order({ company: s.coA.id, placed: NOW });
    await s.sys.orderLine.create({
      data: {
        accountId: s.accountId,
        orderId: o.id,
        productId: p.id,
        title: "Крем",
        quantity: 3,
        unitPrice: 5,
      },
    });
    const r = await stockReport(s.ctx, NOW);
    expect(r.zeroOpen).toEqual([expect.objectContaining({ id: p.id, open: { units: 3, lines: 1 } })]);
    expect(r.runningOut).toEqual([]);
  });
});
