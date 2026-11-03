import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { ForbiddenError } from "@/server/auth/rbac";
import { systemDb } from "@/server/db/client";
import { QUEUES } from "@/server/jobs/queues";
import {
  DIRECTORY_PAGE_SIZE,
  getOffice,
  listCities,
  listCouriers,
  listOffices,
  listSenders,
  refreshDirectory,
  type DirectoryCtx,
} from "./directory";
import { listInvoices, safeInvoiceUrl } from "./invoices";

// Synthetic data only: mirror rows as the euShipments / FHB read syncs would leave them. No vendor call.

const NOW = new Date("2026-11-03T08:00:00Z");
let seq = 0;

async function setup() {
  const n = ++seq;
  const sys = systemDb();
  const account = await sys.account.create({ data: { name: `Directory ${n}` } });
  const accountId = account.id;
  const coA = await sys.company.create({ data: { accountId, name: "Фирма А" } });
  const coB = await sys.company.create({ data: { accountId, name: "Фирма Б" } });
  const cred = await sys.credential.create({
    data: { accountId, label: "t", hint: "••••", ciphertext: "x", iv: "x", authTag: "x" },
  });
  const eu = await sys.fulfillmentConnection.create({
    data: {
      accountId,
      companyId: coA.id,
      name: "euShipments А",
      type: "EUSHIPMENTS",
      vendorIds: { companyId: 9001 },
      credentialId: cred.id,
    },
  });
  const fhb = await sys.fulfillmentConnection.create({
    data: { accountId, companyId: coB.id, name: "FHB Б", type: "FHB_V3", credentialId: cred.id },
  });
  await sys.eushipmentsCountry.createMany({
    data: [
      { accountId, connectionId: eu.id, countryId: 1, name: "Bulgaria", isoCode: "BG", syncedAt: NOW },
      { accountId, connectionId: eu.id, countryId: 7, name: "Hungary", isoCode: "HU", syncedAt: NOW },
    ],
  });
  await sys.eushipmentsCourier.createMany({
    data: [
      {
        accountId,
        connectionId: eu.id,
        courierId: 15,
        name: "Синт куриер BG",
        country: "Bulgaria",
        toOffice: true,
        syncedAt: NOW,
      },
      {
        accountId,
        connectionId: eu.id,
        courierId: 22,
        name: "Синт куриер HU",
        country: "Hungary",
        toOffice: true,
        toAddress: true,
        syncedAt: NOW,
      },
    ],
  });
  // 60 Bulgarian offices + 2 Hungarian lockers: more than one page.
  await sys.eushipmentsOffice.createMany({
    data: [
      ...Array.from({ length: 60 }, (_, i) => ({
        accountId,
        connectionId: eu.id,
        officeId: 1000 + i,
        courierId: 15,
        name: `Офис ${String(i).padStart(2, "0")}`,
        code: `C${i}`,
        cityName: "София",
        address: `ул. Синтетична ${i}`,
        postCode: "1000",
        codSupport: true,
        workHours: { weekday: ["09:00", "18:00"], saturday: [null, null] },
        syncedAt: NOW,
      })),
      {
        accountId,
        connectionId: eu.id,
        officeId: 5001,
        courierId: 22,
        name: "Locker Budapest 1",
        cityName: "Budapest",
        isStation: true,
        syncedAt: NOW,
      },
      {
        accountId,
        connectionId: eu.id,
        officeId: 5002,
        courierId: 22,
        name: "Locker Szeged",
        cityName: "Szeged",
        isStation: true,
        syncedAt: NOW,
      },
    ],
  });
  await sys.fhbCarrier.createMany({
    data: [{ accountId, connectionId: fhb.id, code: "syn_pudo", name: "Синт PUDO", lastSyncAt: NOW }],
  });
  await sys.fhbPickupPoint.createMany({
    data: [
      {
        accountId,
        connectionId: fhb.id,
        service: "syn_pudo",
        queryCountry: "HU",
        vendorId: "31000001",
        externalCode: "X1",
        name: "PUDO Budapest",
        city: "Budapest",
        country: "HU",
        lastSyncAt: NOW,
      },
      {
        accountId,
        connectionId: fhb.id,
        service: "syn_pudo",
        queryCountry: "HU",
        vendorId: "31000002",
        name: "PUDO Debrecen",
        city: "Debrecen",
        country: "HU",
        lastSyncAt: NOW,
      },
    ],
  });
  await sys.eushipmentsCity.createMany({
    data: [
      {
        accountId,
        connectionId: eu.id,
        countryId: 1,
        cityId: 68134,
        nameLocal: "София",
        nameEn: "Sofia",
        postalCode: "1000",
        syncedAt: NOW,
      },
      {
        accountId,
        connectionId: eu.id,
        countryId: 7,
        cityId: 9001,
        nameLocal: "Budapest",
        postalCode: "1011",
        syncedAt: NOW,
      },
    ],
  });
  await sys.eushipmentsVendorCompany.createMany({
    data: [
      { accountId, connectionId: eu.id, vendorCompanyId: 9001, name: "Синт подател", syncedAt: NOW },
      { accountId, connectionId: eu.id, vendorCompanyId: 9002, name: "Друга синт фирма", syncedAt: NOW },
    ],
  });
  await sys.eushipmentsWarehouse.create({
    data: {
      accountId,
      connectionId: eu.id,
      warehouseId: 3,
      name: "Синт склад",
      countryIso: "BG",
      syncedAt: NOW,
    },
  });
  const owner: DirectoryCtx = { userId: "u", accountId, role: "OWNER", companyScope: null };
  return { accountId, coA, coB, eu, fhb, owner };
}

describe("directory: offices and pick-up points", () => {
  it("pages both vendors as one list, filters server-side, and respects company scope", async () => {
    const s = await setup();
    const all = await listOffices(s.owner, {});
    expect(all.total).toBe(64);
    expect(all.totals).toEqual({ eu: 62, fhb: 2 });
    expect(all.rows).toHaveLength(DIRECTORY_PAGE_SIZE);
    expect(all.pages).toBe(2);
    const p2 = await listOffices(s.owner, { page: "2" });
    expect(p2.rows).toHaveLength(14);
    expect(p2.rows.slice(-2).map((r) => r.vendor)).toEqual(["fhb", "fhb"]);
    const keys = new Set([...all.rows, ...p2.rows].map((r) => r.key));
    expect(keys.size).toBe(64);

    const hu = await listOffices(s.owner, { country: "hu" });
    expect(hu.total).toBe(4);
    expect(hu.rows.find((r) => r.vendor === "eu")?.country).toBe("HU");
    expect((await listOffices(s.owner, { type: "locker" })).total).toBe(2);
    expect((await listOffices(s.owner, { type: "pudo" })).total).toBe(2);
    expect((await listOffices(s.owner, { vendor: "fhb", city: "debre" })).rows[0]?.code).toBe("31000002");
    expect((await listOffices(s.owner, { courier: "eu:22" })).total).toBe(2);
    expect((await listOffices(s.owner, { courier: "fhb:syn_pudo" })).total).toBe(2);
    expect((await listOffices(s.owner, { q: "1005" })).rows[0]?.name).toBe("Офис 05");
    expect((await listOffices(s.owner, { q: "синтетична 42" })).total).toBe(1);
    // Malformed URL values are ignored, never thrown.
    expect((await listOffices(s.owner, { courier: "x'; drop", country: "BGR", page: "-3" })).total).toBe(64);
    // Header scope: euShipments only.
    expect((await listOffices(s.owner, {}, ["EUSHIPMENTS"])).total).toBe(62);
    expect(all.options.countries).toEqual(["BG", "HU"]);

    // A restricted operator of company B sees only the FHB connection's points.
    const opB: DirectoryCtx = {
      userId: "o",
      accountId: s.accountId,
      role: "OPERATOR",
      companyScope: [s.coB.id],
    };
    const scoped = await listOffices(opB, {});
    expect(scoped.total).toBe(2);
    const euKey = all.rows.find((r) => r.name === "Офис 00")!.key;
    expect(await getOffice(opB, euKey)).toBeNull();
    const detail = await getOffice(s.owner, euKey);
    expect(detail?.vendor).toBe("eu");
    expect(detail && detail.vendor === "eu" && detail.workHours?.weekday).toEqual(["09:00", "18:00"]);
    expect(await getOffice(s.owner, "nonsense")).toBeNull();
  });

  it("never returns another account's rows", async () => {
    const a = await setup();
    const b = await setup();
    const fromA = await listOffices(a.owner, {});
    expect(fromA.rows.every((r) => r.connection.id === a.eu.id || r.connection.id === a.fhb.id)).toBe(true);
    const bKey = (await listOffices(b.owner, {})).rows[0]!.key;
    expect(await getOffice(a.owner, bKey)).toBeNull();
  });
});

describe("directory: FHB pick-up points loaded for several query countries", () => {
  it('counts a point stored under queryCountry "" and "SK" once (offices, totals, couriers)', async () => {
    const s = await setup();
    const sys = systemDb();
    const point = (queryCountry: string, vendorId: string, city: string) => ({
      accountId: s.accountId,
      connectionId: s.fhb.id,
      service: "syn_sk",
      queryCountry,
      vendorId,
      externalCode: `E${vendorId}`,
      name: `PUDO ${city}`,
      city,
      country: "SK",
      lastSyncAt: NOW,
    });
    await sys.fhbCarrier.create({
      data: {
        accountId: s.accountId,
        connectionId: s.fhb.id,
        code: "syn_sk",
        name: "Синт SK",
        lastSyncAt: NOW,
      },
    });
    await sys.fhbPickupPoint.createMany({
      data: [
        point("", "41000001", "Bratislava"),
        point("", "41000002", "Kosice"),
        point("SK", "41000001", "Bratislava"),
        point("SK", "41000002", "Kosice"),
      ],
    });
    const sk = await listOffices(s.owner, { courier: "fhb:syn_sk" });
    expect(sk.total).toBe(2);
    expect(sk.rows.map((r) => r.code).sort()).toEqual(["41000001", "41000002"]);
    const all = await listOffices(s.owner, {});
    expect(all.totals).toEqual({ eu: 62, fhb: 4 });
    const c = await listCouriers(s.owner);
    expect(c.fhb.find((x) => x.code === "syn_sk")?.points).toBe(2);
    // A service loaded ONLY per country (the HU list of syn_pudo) is still listed in full.
    expect(c.fhb.find((x) => x.code === "syn_pudo")?.points).toBe(2);
  });
});

describe("directory: couriers, cities, senders", () => {
  it("lists what is mirrored with counts", async () => {
    const s = await setup();
    const c = await listCouriers(s.owner);
    expect(c.eu.map((x) => [x.courierId, x.offices, x.iso])).toEqual([
      [15, 60, "BG"],
      [22, 2, "HU"],
    ]);
    expect(c.fhb).toMatchObject([{ code: "syn_pudo", points: 2 }]);
    const cities = await listCities(s.owner, { q: "sofia" });
    expect(cities.rows.map((r) => r.cityId)).toEqual([68134]);
    expect((await listCities(s.owner, { country: "HU" })).total).toBe(1);
    const senders = await listSenders(s.owner);
    expect(senders.eu[0]?.senderId).toBe(9001);
    expect(senders.eu[0]?.companies.find((x) => x.isSender)?.name).toBe("Синт подател");
    expect(senders.eu[0]?.warehouses).toHaveLength(1);
    expect(senders.fhb[0]?.connection.name).toBe("FHB Б");
    // The FHB credential itself is never selected, only its masked hint.
    expect(JSON.stringify(senders)).not.toContain("ciphertext");
  });
});

describe("directory: Обнови queues the existing read jobs", () => {
  it("offices → euShipments reference + FHB carriers; cities → loaded countries; senders → test", async () => {
    const s = await setup();
    const send = vi.fn(async () => "job-id" as string | null);
    const boss = { send } as unknown as PgBoss;
    expect(await refreshDirectory(s.owner, "offices", boss)).toEqual({ queued: 2, already: 0 });
    expect(send.mock.calls.map((c) => (c as unknown[])[0]).sort()).toEqual(
      [QUEUES.eushipmentsSyncReference.name, QUEUES.fhbSync.name].sort(),
    );
    send.mockClear();
    await refreshDirectory(s.owner, "cities", boss);
    expect(
      send.mock.calls.map((c) => ((c as unknown[])[1] as { countryId: number }).countryId).sort(),
    ).toEqual([1, 7]);
    send.mockClear();
    await refreshDirectory(s.owner, "senders", boss);
    expect(send.mock.calls.map((c) => (c as unknown[])[0])).toEqual([QUEUES.eushipmentsTestConnection.name]);
    const viewer: DirectoryCtx = { ...s.owner, role: "VIEWER" };
    await expect(refreshDirectory(viewer, "offices", boss)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("invoices", () => {
  it("lists the documented FHB per-order invoice fields from the mirror, scoped", async () => {
    const s = await setup();
    const sys = systemDb();
    const mirror = (externalId: string, raw: Record<string, unknown>) =>
      sys.fhbOrderMirror.create({
        data: {
          accountId: s.accountId,
          connectionId: s.fhb.id,
          externalId,
          status: "SHIPPED",
          rawStatus: "sent",
          trackingNumbers: [],
          raw: raw as never,
          lastSyncAt: NOW,
        },
      });
    await mirror("SYN-1", {
      invoice: "https://example.test/inv/1.pdf",
      invoice_number: "INV-1",
      invoice_date: "2026-10-01",
    });
    await mirror("SYN-2", { invoice: "", invoice_number: "INV-2", invoice_date: null });
    await mirror("SYN-3", { invoice: "", invoice_number: "" });
    await mirror("SYN-4", { invoice: "javascript:alert(1)", invoice_number: "INV-4" });
    await mirror("SYN-5", {});
    const r = await listInvoices(s.owner, {});
    expect(r.counts).toEqual({ all: 3, pdf: 1, number: 2 });
    const one = r.rows.find((x) => x.externalId === "SYN-1");
    expect(one).toMatchObject({ invoiceUrl: "https://example.test/inv/1.pdf", invoiceNumber: "INV-1" });
    expect(r.rows.find((x) => x.externalId === "SYN-4")?.invoiceUrl).toBeNull();
    expect((await listInvoices(s.owner, { tab: "pdf" })).rows.map((x) => x.externalId)).toEqual(["SYN-1"]);
    expect((await listInvoices(s.owner, { q: "INV-2" })).total).toBe(1);
    const opA: DirectoryCtx = {
      userId: "o",
      accountId: s.accountId,
      role: "OPERATOR",
      companyScope: [s.coA.id],
    };
    expect((await listInvoices(opA, {})).total).toBe(0);
    // Counts and rows agree: "http" inside a non-URL is not a PDF; a numeric invoice_number is not a number
    // (the reference types it as a string), so neither is rendered nor counted.
    await mirror("SYN-6", { invoice: "javascript:alert('http')", invoice_number: 77 });
    await mirror("SYN-7", { invoice: "see http://example.test/x", invoice_number: "" });
    const r2 = await listInvoices(s.owner, {});
    expect(r2.counts).toEqual({ all: 3, pdf: 1, number: 2 });
    expect(r2.rows.map((x) => x.externalId).sort()).toEqual(["SYN-1", "SYN-2", "SYN-4"]);
    await expect(listInvoices({ ...s.owner, role: "WAREHOUSE" }, {})).rejects.toBeInstanceOf(ForbiddenError);
    expect(safeInvoiceUrl("ftp://x/y")).toBeNull();
  });
});

describe("invoices: scope is the order's company, not the warehouse's", () => {
  it("a shared-line FHB warehouse of coA carrying coB's order is visible to coB members only", async () => {
    const s = await setup();
    const sys = systemDb();
    // FHB warehouse owned by coA; it ships one order of coA, one of coB, and has one row the CRM did not create.
    const fhbA = await sys.fulfillmentConnection.create({
      data: {
        accountId: s.accountId,
        companyId: s.coA.id,
        name: "FHB А",
        type: "FHB_V3",
        credentialId: (await sys.credential.findFirstOrThrow({ where: { accountId: s.accountId } })).id,
      },
    });
    const ship = async (companyId: string, externalId: string) => {
      const order = await sys.order.create({
        data: {
          accountId: s.accountId,
          companyId,
          source: "MANUAL",
          number: `#INV-${externalId}`,
          currency: "EUR",
          subtotal: 10,
          total: 10,
          paymentMethod: "PREPAID",
          placedAt: NOW,
          status: "SHIPPED",
        },
      });
      await sys.fulfillment.create({
        data: {
          accountId: s.accountId,
          orderId: order.id,
          connectionId: fhbA.id,
          externalId,
          status: "SHIPPED",
          trackingNumbers: [],
        },
      });
      return order;
    };
    const mirror = (externalId: string) =>
      sys.fhbOrderMirror.create({
        data: {
          accountId: s.accountId,
          connectionId: fhbA.id,
          externalId,
          status: "SHIPPED",
          rawStatus: "sent",
          trackingNumbers: [],
          raw: { invoice_number: `N-${externalId}` },
          lastSyncAt: NOW,
        },
      });
    await ship(s.coA.id, "SA-1");
    const orderB = await ship(s.coB.id, "SB-1");
    await mirror("SA-1");
    await mirror("SB-1");
    await mirror("SX-1"); // not created by the CRM → the connection's company (coA)
    const op = (companyId: string): DirectoryCtx => ({
      userId: "o",
      accountId: s.accountId,
      role: "OPERATOR",
      companyScope: [companyId],
    });
    const ids = async (ctx: DirectoryCtx) =>
      (await listInvoices(ctx, {})).rows.map((r) => r.externalId).sort();
    expect(await ids(op(s.coA.id))).toEqual(["SA-1", "SX-1"]);
    const forB = await listInvoices(op(s.coB.id), {});
    expect(forB.rows.map((r) => r.externalId)).toEqual(["SB-1"]);
    expect(forB.counts.all).toBe(1);
    expect(forB.rows[0]?.order).toEqual({ id: orderB.id, number: orderB.number });
    expect(forB.rows[0]?.connection.name).toBe("FHB А");
    expect((await listInvoices(op(s.coB.id), { q: "SA-1" })).total).toBe(0);
    // No `invoice` key at all (these rows) still lands in the "number" tab, and its count matches its rows.
    const numA = await listInvoices(op(s.coA.id), { tab: "number" });
    expect([numA.counts.number, numA.rows.length]).toEqual([2, 2]);
    expect(await ids(s.owner)).toEqual(["SA-1", "SB-1", "SX-1"]);
    // Sidebar company picked by the owner behaves the same way; header scope euShipments-only shows nothing.
    expect(await ids({ ...s.owner, activeCompanyId: s.coB.id })).toEqual(["SB-1"]);
    expect((await listInvoices(s.owner, {}, ["EUSHIPMENTS"])).total).toBe(0);
  });
});
