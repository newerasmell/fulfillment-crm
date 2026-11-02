import { describe, expect, it } from "vitest";
import type { Actor } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { accountDb, systemDb } from "@/server/db/client";
import { updateReturnsCodSettings } from "@/server/returns/settings";
import { exportCodCsv, listCod, sweepCodMismatches } from "./board";
import { bucketOf, classifyCod, totalsBy, type CodShipmentIn } from "./classify";

// Synthetic data only. The COD board reads the local mirrors (FhbCodMirror, EushipmentsTracking); no vendor call.

const DAY = 86_400_000;
const NOW = new Date("2026-11-02T10:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
const opts = { now: NOW, missingDays: 14 };

const base = (over: Partial<CodShipmentIn> = {}): CodShipmentIn => ({
  fulfillmentId: "f",
  connectionType: "FHB_V3",
  status: "DELIVERED",
  codStatus: null,
  deliveredAt: ago(3),
  order: {
    paymentMethod: "COD",
    currency: "EUR",
    codAmount: 50,
    codLocalAmount: 12500,
    codLocalCurrency: "HUF",
  },
  fhb: null,
  eu: null,
  ...over,
});

describe("classifyCod (pure)", () => {
  it("expected COD is the local-currency amount; buckets by days since delivery", () => {
    expect(bucketOf(0)).toBe("d0_7");
    expect(bucketOf(7)).toBe("d0_7");
    expect(bucketOf(8)).toBe("d8_14");
    expect(bucketOf(14)).toBe("d8_14");
    expect(bucketOf(15)).toBe("d15_30");
    expect(bucketOf(30)).toBe("d15_30");
    expect(bucketOf(31)).toBe("d30_plus");
    const r = classifyCod(
      base({ fhb: { cod: 12500, status: "waiting", receivedAt: null, paidAt: null } }),
      opts,
    );
    expect(r).toMatchObject({
      expected: { amount: 12500, currency: "HUF" },
      vendor: { state: "waiting", amount: 12500 },
      ageDays: 3,
      bucket: "d0_7",
      mismatch: null,
    });
    expect(classifyCod(base({ status: "SHIPPED", deliveredAt: null }), opts).bucket).toBe("in_transit");
  });

  it("FHB: paid / received / unknown raw status; amount and missing mismatches", () => {
    const paid = classifyCod(
      base({ fhb: { cod: 12500, status: "paid", receivedAt: ago(2), paidAt: ago(1) } }),
      opts,
    );
    expect(paid).toMatchObject({ bucket: "paid", vendor: { state: "paid" } });
    expect(
      classifyCod(base({ fhb: { cod: 12500, status: "on_hold", receivedAt: null, paidAt: null } }), opts)
        .vendor,
    ).toMatchObject({ state: "unknown", raw: "on_hold" });
    expect(
      classifyCod(base({ fhb: { cod: 12000, status: "received", receivedAt: null, paidAt: null } }), opts)
        .mismatch,
    ).toBe("amount");
    expect(classifyCod(base({ deliveredAt: ago(13) }), opts).mismatch).toBeNull();
    expect(classifyCod(base({ deliveredAt: ago(14) }), opts).mismatch).toBe("missing");
    expect(
      classifyCod(
        base({
          order: {
            paymentMethod: "PREPAID",
            currency: "EUR",
            codAmount: null,
            codLocalAmount: null,
            codLocalCurrency: null,
          },
          fhb: { cod: 10, status: "waiting", receivedAt: null, paidAt: null },
        }),
        opts,
      ),
    ).toMatchObject({ expected: null, mismatch: "unexpected" });
  });

  it("euShipments: registered vs paid; missing only after check-cod-by-order has answered", () => {
    const eu = (t: Partial<NonNullable<CodShipmentIn["eu"]>> | null, over: Partial<CodShipmentIn> = {}) =>
      classifyCod(
        base({
          connectionType: "EUSHIPMENTS",
          deliveredAt: ago(20),
          eu: t ? { codAmount: null, codPaidAt: null, codPaidNumber: null, codCheckedAt: null, ...t } : null,
          ...over,
        }),
        opts,
      );
    expect(eu(null).mismatch).toBeNull();
    expect(eu({ codCheckedAt: ago(1) }).mismatch).toBe("missing");
    expect(eu({ codAmount: "12500.00", codCheckedAt: ago(1) })).toMatchObject({
      vendor: { state: "received", raw: "registered", amount: 12500 },
      mismatch: null,
    });
    expect(
      eu({ codAmount: "12500.00", codPaidAt: ago(1), codPaidNumber: "10793" }, { status: "COD_PAID" }).vendor,
    ).toMatchObject({
      state: "paid",
      protocol: "10793",
    });
    expect(eu({ codAmount: "125.00" }).mismatch).toBe("amount");
  });

  it("totals by currency never mix currencies and count outstanding delivered COD", () => {
    const rows = [
      classifyCod(base({ fhb: { cod: 12500, status: "paid", receivedAt: null, paidAt: ago(1) } }), opts),
      classifyCod(base(), opts),
      classifyCod(
        base({
          order: {
            paymentMethod: "COD",
            currency: "EUR",
            codAmount: 10.1,
            codLocalAmount: 10.1,
            codLocalCurrency: "EUR",
          },
        }),
        opts,
      ),
      classifyCod(
        base({
          order: {
            paymentMethod: "COD",
            currency: "EUR",
            codAmount: 0.2,
            codLocalAmount: 0.2,
            codLocalCurrency: "EUR",
          },
          fhb: { cod: 0.2, status: "received", receivedAt: null, paidAt: null },
        }),
        opts,
      ),
    ];
    const t = totalsBy(rows.map((row) => ({ key: "all", row }))).get("all")!;
    expect(t.get("HUF")).toMatchObject({ expected: 25000, paid: 12500, outstanding: 12500, count: 2 });
    expect(t.get("EUR")).toMatchObject({ expected: 10.3, received: 0.2, outstanding: 10.3, count: 2 });
  });
});

let seq = 0;
async function setup() {
  const n = ++seq;
  const sys = systemDb();
  const account = await sys.account.create({ data: { name: `COD ${n}` } });
  const coA = await sys.company.create({ data: { accountId: account.id, name: "Фирма А" } });
  const coB = await sys.company.create({ data: { accountId: account.id, name: "Фирма Б" } });
  const owner: Actor & { companyScope: null } = {
    userId: "u-owner",
    accountId: account.id,
    role: "OWNER",
    companyScope: null,
  };
  const fhb = await sys.fulfillmentConnection.create({
    data: { accountId: account.id, companyId: coA.id, name: "FHB А", type: "FHB_V3" },
  });
  const eu = await sys.fulfillmentConnection.create({
    data: { accountId: account.id, companyId: coB.id, name: "euShipments Б", type: "EUSHIPMENTS" },
  });
  let k = 0;
  const ship = async (
    connectionId: string,
    companyId: string,
    o: {
      cod: number | null;
      currency: string;
      delivered: number | null;
      status?: "SHIPPED" | "DELIVERED" | "COD_PAID";
    },
  ) => {
    k++;
    const order = await sys.order.create({
      data: {
        accountId: account.id,
        companyId,
        source: "MANUAL",
        number: `#C-${n}-${k}`,
        currency: "EUR",
        subtotal: 10,
        total: 10,
        paymentMethod: o.cod == null ? "PREPAID" : "COD",
        codAmount: o.cod,
        codLocalAmount: o.cod,
        codLocalCurrency: o.cod == null ? null : o.currency,
        placedAt: ago(40),
        status: o.status ?? (o.delivered == null ? "SHIPPED" : "DELIVERED"),
      },
    });
    return sys.fulfillment.create({
      data: {
        accountId: account.id,
        orderId: order.id,
        connectionId,
        externalId: `M-${n}-${k}`,
        status: o.status ?? (o.delivered == null ? "SHIPPED" : "DELIVERED"),
        deliveredAt: o.delivered == null ? null : ago(o.delivered),
        trackingNumbers: [`T-${n}-${k}`],
      },
      include: { order: true },
    });
  };
  const fhbCod = (f: { externalId: string }, cod: number, status: string) =>
    sys.fhbCodMirror.create({
      data: {
        accountId: account.id,
        connectionId: fhb.id,
        externalId: f.externalId,
        cod,
        status,
        raw: {},
        lastSyncAt: NOW,
      },
    });
  return { account, coA, coB, owner, fhb, eu, ship, fhbCod };
}

describe("COD board + sweep", () => {
  it("lists, totals by currency and company, filters by tab/bucket/company/warehouse, raises and resolves tasks", async () => {
    const s = await setup();
    const a = s.account.id;
    const okWaiting = await s.ship(s.fhb.id, s.coA.id, { cod: 25.5, currency: "EUR", delivered: 3 });
    await s.fhbCod(okWaiting, 25.5, "waiting");
    const wrongAmount = await s.ship(s.fhb.id, s.coA.id, { cod: 30, currency: "EUR", delivered: 10 });
    await s.fhbCod(wrongAmount, 3, "received");
    const missing = await s.ship(s.fhb.id, s.coA.id, { cod: 12500, currency: "HUF", delivered: 40 });
    const paid = await s.ship(s.fhb.id, s.coA.id, {
      cod: 99,
      currency: "RON",
      delivered: 20,
      status: "COD_PAID",
    });
    await s.fhbCod(paid, 99, "paid");
    const prepaid = await s.ship(s.fhb.id, s.coA.id, { cod: null, currency: "EUR", delivered: 5 });
    await s.fhbCod(prepaid, 15, "waiting");
    const transit = await s.ship(s.eu.id, s.coB.id, { cod: 40, currency: "EUR", delivered: null });
    const euReg = await s.ship(s.eu.id, s.coB.id, { cod: 40, currency: "EUR", delivered: 16 });
    await systemDb().eushipmentsTracking.create({
      data: {
        accountId: a,
        connectionId: s.eu.id,
        fulfillmentId: euReg.id,
        referenceNumber: euReg.externalId,
        codAmount: "40.00",
        codCheckedAt: ago(1),
      },
    });

    const all = await listCod(s.owner, { tab: "all" }, NOW);
    expect(all.total).toBe(7);
    expect(all.counts).toMatchObject({ all: 7, outstanding: 4, mismatch: 3, paid: 1, in_transit: 1 });
    expect(all.mismatches).toEqual({ amount: 1, missing: 1, unexpected: 1 });
    const out = await listCod(s.owner, { tab: "outstanding" }, NOW);
    expect(out.buckets).toMatchObject({ d0_7: 1, d8_14: 1, d15_30: 1, d30_plus: 1, paid: 0 });
    // Outstanding = delivered and not paid out: the prepaid one is listed only for its mismatch (expected 0).
    expect(out.byCurrency.find((t) => t.currency === "EUR")).toMatchObject({ outstanding: 95.5 });
    expect(out.byCurrency.find((t) => t.currency === "HUF")).toMatchObject({ outstanding: 12500 });
    expect(out.byCompany.map((c) => c.company)).toEqual(["Фирма А", "Фирма Б"]);
    const old = await listCod(s.owner, { tab: "outstanding", bucket: "d30_plus" }, NOW);
    expect(old.rows.map((r) => r.fulfillmentId)).toEqual([missing.id]);
    expect((await listCod(s.owner, { tab: "all", connectionTypes: ["EUSHIPMENTS"] }, NOW)).total).toBe(2);
    expect((await listCod({ ...s.owner, activeCompanyId: s.coB.id }, { tab: "all" }, NOW)).total).toBe(2);
    expect((await listCod({ ...s.owner, lineCompanyIds: [s.coA.id] }, { tab: "all" }, NOW)).total).toBe(5);
    expect((await listCod(s.owner, { tab: "all", q: transit.order.number }, NOW)).rows[0]?.bucket).toBe(
      "in_transit",
    );
    const restricted = { ...s.owner, role: "OPERATOR" as const, companyScope: [s.coB.id] };
    expect((await listCod(restricted, { tab: "all" }, NOW)).total).toBe(2);
    await expect(listCod({ ...s.owner, role: "WAREHOUSE" }, {}, NOW)).rejects.toBeInstanceOf(ForbiddenError);

    // Tasks: one per mismatch, not twice, resolved when the warehouse data matches.
    expect(await sweepCodMismatches(a, NOW)).toEqual({ raised: 3, resolved: 0 });
    expect(await sweepCodMismatches(a, NOW)).toEqual({ raised: 0, resolved: 0 });
    const db = accountDb(a);
    const tasks = await db.alert.findMany({
      where: { status: { not: "RESOLVED" } },
      orderBy: { kind: "asc" },
    });
    expect(tasks.map((t) => [t.kind, t.entityId, t.isTask])).toEqual([
      ["cod_amount_mismatch", wrongAmount.id, true],
      ["cod_missing", missing.id, true],
      ["cod_unexpected", prepaid.id, true],
    ]);
    await systemDb().fhbCodMirror.update({
      where: { connectionId_externalId: { connectionId: s.fhb.id, externalId: wrongAmount.externalId } },
      data: { cod: 30 },
    });
    expect(await sweepCodMismatches(a, NOW)).toEqual({ raised: 0, resolved: 1 });
    // A longer "missing" threshold makes the missing task go away too.
    await updateReturnsCodSettings(s.owner, {
      returnOverdueDays: 14,
      codMissingDays: 60,
      notifySupport: true,
    });
    expect(await sweepCodMismatches(a, NOW)).toEqual({ raised: 0, resolved: 1 });
  });

  it("CSV export has every filtered row, no customer data, and respects scope; other groups see nothing", async () => {
    const s = await setup();
    const f = await s.ship(s.fhb.id, s.coA.id, { cod: 25.5, currency: "EUR", delivered: 3 });
    await s.fhbCod(f, 25.5, "received");
    await s.ship(s.eu.id, s.coB.id, { cod: 40, currency: "EUR", delivered: 2 });
    const rows = await exportCodCsv(s.owner, { tab: "all" }, NOW);
    expect(rows[0]).toContain("expected_cod");
    expect(rows).toHaveLength(3);
    const line = rows.find((r) => r[1] === f.externalId)!;
    expect(line).toEqual(expect.arrayContaining(["Фирма А", "FHB А", "d0_7", "25.50", "EUR", "received"]));
    expect(
      (await exportCodCsv({ ...s.owner, role: "OPERATOR", companyScope: [s.coB.id] }, {}, NOW)).length,
    ).toBe(2);
    const other = await setup();
    expect((await listCod(other.owner, { tab: "all" }, NOW)).total).toBe(0);
    await expect(exportCodCsv({ ...s.owner, role: "VIEWER" }, {}, NOW)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
