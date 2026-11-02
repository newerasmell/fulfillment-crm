// Synthetic data for the returns + COD e2e (tests/e2e/returns-cod.spec.ts). A separate group with its own OWNER,
// so other specs' counts never change. No vendor call: the warehouse data are mirror rows as the FHB / euShipments
// read syncs would leave them, then the returns and COD sweeps run once (as the worker would).
//   Фирма Връщания А (line "Козметика") — FHB "FHB Връщания"
//   Фирма Връщания Б (line "Текстил")   — euShipments "euShipments Връщания"
import { bootstrapOwner } from "@/server/auth/users";
import { systemDb } from "@/server/db/client";
import { createFhbConnection } from "@/server/fhb/connection";

export const RETURNS_PASSWORD = "e2e-returns-password-not-secret";
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);

export async function seedReturns() {
  const owner = await bootstrapOwner({
    email: "e2e-returns@example.com",
    name: "E2E Returns",
    accountName: "Тест група Връщания",
    password: RETURNS_PASSWORD,
  });
  const sys = systemDb();
  const accountId = owner.account.id;
  const first = await sys.company.findFirstOrThrow({ where: { accountId } });
  const lineA = await sys.productLine.create({
    data: { accountId, name: "Козметика", color: "rose", sortOrder: 0 },
  });
  const lineB = await sys.productLine.create({
    data: { accountId, name: "Текстил", color: "slate", sortOrder: 1 },
  });
  const coA = await sys.company.update({
    where: { id: first.id },
    data: { name: "Фирма Връщания А", lineId: lineA.id },
  });
  const coB = await sys.company.create({ data: { accountId, name: "Фирма Връщания Б", lineId: lineB.id } });
  const actor = { userId: owner.user.id, accountId, role: "OWNER" as const };
  const fhb = await createFhbConnection(actor, {
    companyId: coA.id,
    name: "FHB Връщания",
    appId: "e2e-returns-app",
    secret: "e2e-returns-secret-not-real",
    skuPrefix: "RT",
  });
  const eu = await sys.fulfillmentConnection.create({
    data: {
      accountId,
      companyId: coB.id,
      name: "euShipments Връщания",
      type: "EUSHIPMENTS",
      liveMode: "READ_ONLY",
    },
  });

  let k = 0;
  const shipment = async (o: {
    number: string;
    companyId: string;
    connectionId: string;
    status: "SHIPPED" | "DELIVERED" | "COD_PAID" | "RETURNING" | "RETURN_RECEIVED";
    cod?: { amount: number; currency: string };
    deliveredDaysAgo?: number;
    tracking?: string;
  }) => {
    k++;
    const order = await sys.order.create({
      data: {
        accountId,
        companyId: o.companyId,
        source: "MANUAL",
        number: o.number,
        status: o.status,
        customerName: "Синтетичен клиент",
        currency: "EUR",
        subtotal: "20.00",
        total: "20.00",
        paymentMethod: o.cod ? "COD" : "PREPAID",
        codAmount: o.cod?.amount,
        codLocalAmount: o.cod?.amount,
        codLocalCurrency: o.cod?.currency,
        countryCode: o.cod?.currency === "HUF" ? "HU" : "BG",
        tags: [],
        placedAt: ago(45),
      },
    });
    await sys.orderLine.create({
      data: {
        accountId,
        orderId: order.id,
        title: "Синтетичен крем 50 мл",
        sku: "RT-SYN-50",
        quantity: 1,
        unitPrice: "20.00",
      },
    });
    return sys.fulfillment.create({
      data: {
        accountId,
        orderId: order.id,
        connectionId: o.connectionId,
        externalId: `RT-E2E-${k}`,
        status: o.status,
        rawStatus:
          o.status === "RETURNING"
            ? "Returning"
            : o.status === "RETURN_RECEIVED"
              ? "Returned to Warehouse"
              : null,
        trackingNumbers: [o.tracking ?? `TRK-RT-${k}`],
        shippedAt: ago(30),
        deliveredAt: o.deliveredDaysAgo == null ? null : ago(o.deliveredDaysAgo),
      },
    });
  };

  // ── returns ──
  const rma = await shipment({
    number: "#RT-1001",
    companyId: coA.id,
    connectionId: fhb.id,
    status: "SHIPPED",
  });
  await sys.fhbOrderMirror.create({
    data: {
      accountId,
      connectionId: fhb.id,
      externalId: rma.externalId,
      rawStatus: "returned",
      status: "RETURN_RECEIVED",
      trackingNumbers: rma.trackingNumbers,
      returnedAt: ago(1),
      returnType: "return",
      inRma: true,
      raw: {},
      lastSyncAt: new Date(),
    },
  });
  await shipment({
    number: "#RT-1002",
    companyId: coA.id,
    connectionId: fhb.id,
    status: "SHIPPED",
    tracking: "PKG-RT-2",
  });
  await sys.fhbReturnMirror.create({
    data: {
      accountId,
      connectionId: fhb.id,
      uid: "AB00002",
      type: "complex",
      status: "stored",
      barcodes: ["PKG-RT-2"],
      items: [
        {
          id: 17,
          barcode: "RT-SYN-50",
          description: "Синтетичен крем 50 мл",
          condition: "Damaged box",
          quantity: 1,
          action: "stock_in",
        },
      ],
      photos: [{ id: 51, type: "package" }],
      vendorCreatedAt: ago(2),
      raw: {},
      lastSyncAt: new Date(),
    },
  });
  await sys.fhbOrderMirror.create({
    data: {
      accountId,
      connectionId: fhb.id,
      externalId: "ZOE-9001",
      rawStatus: "returned",
      status: "RETURN_RECEIVED",
      trackingNumbers: [],
      returnedAt: ago(3),
      inRma: true,
      raw: { items: [{ id: "RT-SYN-50", quantity: 2 }] },
      lastSyncAt: new Date(),
    },
  });
  const returning = await shipment({
    number: "#RT-2001",
    companyId: coB.id,
    connectionId: eu.id,
    status: "RETURNING",
  });
  await sys.fulfillmentEvent.create({
    data: {
      accountId,
      fulfillmentId: returning.id,
      occurredAt: ago(20),
      source: "eushipments.history",
      rawStatus: "Returning",
      status: "RETURNING",
    },
  });
  const back = await shipment({
    number: "#RT-2002",
    companyId: coB.id,
    connectionId: eu.id,
    status: "RETURN_RECEIVED",
  });
  await sys.fulfillmentEvent.create({
    data: {
      accountId,
      fulfillmentId: back.id,
      occurredAt: ago(9),
      source: "eushipments.history",
      rawStatus: "Returning",
      status: "RETURNING",
    },
  });
  await sys.fulfillmentEvent.create({
    data: {
      accountId,
      fulfillmentId: back.id,
      occurredAt: ago(6),
      source: "eushipments.history",
      rawStatus: "Returned to Warehouse",
      status: "RETURN_RECEIVED",
    },
  });

  // ── COD ──
  const cd1 = await shipment({
    number: "#CD-1",
    companyId: coA.id,
    connectionId: fhb.id,
    status: "DELIVERED",
    deliveredDaysAgo: 3,
    cod: { amount: 25.5, currency: "EUR" },
  });
  const cd2 = await shipment({
    number: "#CD-2",
    companyId: coA.id,
    connectionId: fhb.id,
    status: "DELIVERED",
    deliveredDaysAgo: 10,
    cod: { amount: 30, currency: "EUR" },
  });
  await shipment({
    number: "#CD-3",
    companyId: coA.id,
    connectionId: fhb.id,
    status: "DELIVERED",
    deliveredDaysAgo: 40,
    cod: { amount: 12500, currency: "HUF" },
  });
  const cd4 = await shipment({
    number: "#CD-4",
    companyId: coB.id,
    connectionId: eu.id,
    status: "COD_PAID",
    deliveredDaysAgo: 20,
    cod: { amount: 40, currency: "EUR" },
  });
  await shipment({
    number: "#CD-5",
    companyId: coB.id,
    connectionId: eu.id,
    status: "SHIPPED",
    cod: { amount: 15, currency: "EUR" },
  });
  const fhbCod = (externalId: string, cod: number, status: string) =>
    sys.fhbCodMirror.create({
      data: { accountId, connectionId: fhb.id, externalId, cod, status, raw: {}, lastSyncAt: new Date() },
    });
  await fhbCod(cd1.externalId, 25.5, "waiting");
  await fhbCod(cd2.externalId, 3, "received");
  await sys.eushipmentsTracking.create({
    data: {
      accountId,
      connectionId: eu.id,
      fulfillmentId: cd4.id,
      referenceNumber: cd4.externalId,
      codAmount: "40.00",
      codPaidNumber: "90001",
      codPaidAt: ago(5),
      codCheckedAt: ago(5),
    },
  });

  // What the worker's sweeps would do.
  const { syncReturnCases } = await import("@/server/returns/sweep");
  const { sweepCodMismatches } = await import("@/server/cod/board");
  await syncReturnCases(accountId);
  await sweepCodMismatches(accountId);
  return { email: owner.user.email, password: RETURNS_PASSWORD, totp: owner.totpSecret };
}

/** e2e stand-in for the returns.photos worker job: a mocked FHB answers with a 1×1 PNG (no network). */
export async function fetchQueuedPhotosWithMock() {
  const { fetchReturnPhotos } = await import("@/server/returns/photos");
  const pending = await systemDb().returnPhoto.findMany({
    where: { status: "PENDING" },
    select: { accountId: true, returnCaseId: true },
    distinct: ["returnCaseId"],
  });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const fetchImpl = async (u: string | URL) => {
    const url = new URL(u);
    if (url.pathname.endsWith("/login"))
      return new Response(JSON.stringify({ token: "t", expiration: "2099-01-01T00:00:00+0000" }), {
        status: 200,
      });
    if (/\/return\/[^/]+\/photo\/[^/]+$/.test(url.pathname))
      return new Response(new Uint8Array(png), { status: 200, headers: { "content-type": "image/png" } });
    return new Response("{}", { status: 404 });
  };
  let n = 0;
  for (const p of pending) {
    const r = await fetchReturnPhotos(p.accountId, p.returnCaseId, {
      fetchImpl,
      sleep: async () => {},
      random: () => 0,
    });
    n += r.fetched;
  }
  return n;
}
