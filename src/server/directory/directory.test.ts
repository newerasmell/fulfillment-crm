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
    await expect(listInvoices({ ...s.owner, role: "WAREHOUSE" }, {})).rejects.toBeInstanceOf(ForbiddenError);
    expect(safeInvoiceUrl("ftp://x/y")).toBeNull();
  });
});
