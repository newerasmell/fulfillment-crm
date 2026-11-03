// Synthetic data for the directory + invoices e2e (tests/e2e/directory.spec.ts). Its own group and OWNER, so other
// specs' counts never change. No vendor call: mirror rows as the euShipments / FHB read syncs would leave them.
//   Фирма Справочник А — euShipments "euShipments Справочник" (65 offices + 2 lockers, couriers, cities, companies)
//   Фирма Справочник Б — FHB "FHB Справочник" (one carrier, two PUDO points, three orders with invoice fields)
import { bootstrapOwner } from "@/server/auth/users";
import { systemDb } from "@/server/db/client";
import { createEuConnection } from "@/server/eushipments/connections";
import { createFhbConnection } from "@/server/fhb/connection";

export const DIRECTORY_PASSWORD = "e2e-directory-password-not-secret";

export async function seedDirectory() {
  const owner = await bootstrapOwner({
    email: "e2e-directory@example.com",
    name: "E2E Directory",
    accountName: "Тест група Справочник",
    password: DIRECTORY_PASSWORD,
  });
  const sys = systemDb();
  const accountId = owner.account.id;
  const now = new Date();
  const first = await sys.company.findFirstOrThrow({ where: { accountId } });
  const coA = await sys.company.update({ where: { id: first.id }, data: { name: "Фирма Справочник А" } });
  const coB = await sys.company.create({ data: { accountId, name: "Фирма Справочник Б" } });
  const actor = { userId: owner.user.id, accountId, role: "OWNER" as const, companyScope: null };
  const eu = await createEuConnection(actor, {
    companyId: coA.id,
    name: "euShipments Справочник",
    token: "e2e-directory-token-not-real-0000000000",
    vendorCompanyId: 990001,
  });
  const fhb = await createFhbConnection(actor, {
    companyId: coB.id,
    name: "FHB Справочник",
    appId: "e2e-directory-app",
    secret: "e2e-directory-secret-not-real",
  });
  const euId = eu.id;
  await sys.eushipmentsSync.createMany({
    data: [
      { accountId, connectionId: euId, kind: "connection", lastStartedAt: now, lastOkAt: now },
      { accountId, connectionId: euId, kind: "reference", lastStartedAt: now, lastOkAt: now },
      { accountId, connectionId: euId, kind: "cities", lastStartedAt: now, lastOkAt: now },
    ],
  });
  await sys.fhbSyncState.create({
    data: { accountId, connectionId: fhb.id, resource: "carriers", lastRunAt: now, lastOkAt: now },
  });
  await sys.eushipmentsCountry.createMany({
    data: [
      { accountId, connectionId: euId, countryId: 1, name: "Bulgaria", isoCode: "BG", syncedAt: now },
      { accountId, connectionId: euId, countryId: 7, name: "Hungary", isoCode: "HU", syncedAt: now },
    ],
  });
  await sys.eushipmentsCourier.createMany({
    data: [
      {
        accountId,
        connectionId: euId,
        courierId: 915,
        name: "Синт Куриер БГ",
        country: "Bulgaria",
        currency: "EUR",
        toOffice: true,
        toAddress: true,
        syncedAt: now,
      },
      {
        accountId,
        connectionId: euId,
        courierId: 922,
        name: "Synth Courier HU",
        country: "Hungary",
        currency: "HUF",
        toOffice: true,
        syncedAt: now,
      },
    ],
  });
  await sys.eushipmentsOffice.createMany({
    data: [
      ...Array.from({ length: 65 }, (_, i) => ({
        accountId,
        connectionId: euId,
        officeId: 70000 + i,
        courierId: 915,
        name: `Синт офис ${String(i).padStart(2, "0")}`,
        code: `SO${i}`,
        cityName: "София",
        cityId: 68134,
        address: `бул. Тестов ${i}`,
        postCode: "1000",
        region: "София-град",
        codSupport: true,
        latitude: "42.69",
        longitude: "23.32",
        workHours: { weekday: ["09:00", "18:00"], saturday: ["10:00", "14:00"] },
        syncedAt: now,
      })),
      {
        accountId,
        connectionId: euId,
        officeId: 80001,
        courierId: 922,
        name: "Synth Locker Budapest",
        code: "HU-L1",
        cityName: "Budapest",
        address: "Teszt utca 1",
        postCode: "1011",
        isStation: true,
        syncedAt: now,
      },
      {
        accountId,
        connectionId: euId,
        officeId: 80002,
        courierId: 922,
        name: "Synth Locker Szeged",
        cityName: "Szeged",
        isStation: true,
        syncedAt: now,
      },
    ],
  });
  await sys.eushipmentsCity.createMany({
    data: [
      {
        accountId,
        connectionId: euId,
        countryId: 1,
        cityId: 68134,
        nameLocal: "София",
        nameEn: "Sofia",
        postalCode: "1000",
        county: "София-град",
        syncedAt: now,
      },
      {
        accountId,
        connectionId: euId,
        countryId: 7,
        cityId: 91011,
        nameLocal: "Budapest",
        postalCode: "1011",
        syncedAt: now,
      },
    ],
  });
  await sys.eushipmentsVendorCompany.createMany({
    data: [
      { accountId, connectionId: euId, vendorCompanyId: 990001, name: "Синт Подател ЕООД", syncedAt: now },
      { accountId, connectionId: euId, vendorCompanyId: 990002, name: "Синт Друга ООД", syncedAt: now },
    ],
  });
  await sys.eushipmentsWarehouse.create({
    data: {
      accountId,
      connectionId: euId,
      warehouseId: 31,
      name: "Синт склад",
      countryIso: "BG",
      syncedAt: now,
    },
  });
  await sys.fhbCarrier.create({
    data: { accountId, connectionId: fhb.id, code: "syn_pudo", name: "Synth PUDO", lastSyncAt: now },
  });
  await sys.fhbPickupPoint.createMany({
    data: [
      {
        accountId,
        connectionId: fhb.id,
        service: "syn_pudo",
        queryCountry: "HU",
        vendorId: "3190001",
        externalCode: "X-1",
        name: "Synth PUDO Debrecen",
        street: "Próba tér 2",
        city: "Debrecen",
        zip: "4024",
        country: "HU",
        lastSyncAt: now,
      },
      {
        accountId,
        connectionId: fhb.id,
        service: "syn_pudo",
        queryCountry: "HU",
        vendorId: "3190002",
        name: "Synth PUDO Győr",
        city: "Győr",
        zip: "9021",
        country: "HU",
        lastSyncAt: now,
      },
    ],
  });
  // Our order for one of the FHB orders (same deterministic external id), so the invoice row links to it.
  const order = await sys.order.create({
    data: {
      accountId,
      companyId: coB.id,
      source: "MANUAL",
      number: "#DIR-1001",
      currency: "EUR",
      subtotal: 10,
      total: 10,
      paymentMethod: "PREPAID",
      placedAt: now,
      status: "SHIPPED",
    },
  });
  await sys.fulfillment.create({
    data: {
      accountId,
      orderId: order.id,
      connectionId: fhb.id,
      externalId: "DIR-1001",
      status: "SHIPPED",
      trackingNumbers: [],
    },
  });
  const mirror = (externalId: string, raw: Record<string, unknown>, daysAgo: number) =>
    sys.fhbOrderMirror.create({
      data: {
        accountId,
        connectionId: fhb.id,
        externalId,
        rawStatus: "sent",
        status: "SHIPPED",
        country: "HU",
        trackingNumbers: [],
        vendorCreatedAt: new Date(now.getTime() - daysAgo * 86_400_000),
        raw: raw as never,
        lastSyncAt: now,
      },
    });
  await mirror(
    "DIR-1001",
    {
      invoice: "https://example.test/invoices/syn-1001.pdf",
      invoice_number: "SYN-INV-1001",
      invoice_date: "2026-10-30",
    },
    1,
  );
  await mirror("DIR-1002", { invoice: "", invoice_number: "SYN-INV-1002", invoice_date: "2026-10-31" }, 2);
  await mirror("DIR-1003", { invoice: "", invoice_number: "" }, 3);
  return { email: owner.user.email, password: DIRECTORY_PASSWORD, totp: owner.totpSecret };
}
