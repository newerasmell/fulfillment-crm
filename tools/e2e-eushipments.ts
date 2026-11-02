// e2e seed for the euShipments screens (synthetic data only, the vendor is MOCKED — no network).
// Called from tools/e2e.ts. The real read side runs against a fake fetch fed with the reference-shaped
// fixtures, so the screens show what the pollers would store; one DRY_RUN create-order goes through the
// real outbox gate with testMode: true answered by the fake.
import products from "@/integrations/eushipments/__fixtures__/get-products.json";
import RD from "@/integrations/eushipments/__fixtures__/read.json";
import { EU_OPS } from "@/integrations/eushipments/adapter";
import type { ScopedActor } from "@/server/stores";

export const E2E_EU_TOKEN = "e2e-eu-token-not-real-0001";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function fakeFetch(url: string, init?: RequestInit) {
  const u = new URL(url);
  const p = u.pathname.replace("/api/v1", "");
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  if (p === "/get-user-companies") return json(RD.userCompanies);
  if (p.startsWith("/couriers/")) return json(RD.couriers);
  if (p === "/fulfilment/warehouses") return json(RD.warehouses);
  if (p === "/get-countries") return json(RD.countries);
  if (p.startsWith("/offices-by-courier/"))
    return json(u.searchParams.get("page") === "2" ? RD.officesPage2 : RD.officesPage1);
  if (p.startsWith("/fulfilment/get-products")) return json(products);
  if (p === "/fulfilment/get-prod-avails") return json(RD.prodAvails);
  if (p === "/fulfilment/orders-history")
    return json(
      (body.orders as { refNum: string }[]).map(({ refNum }) => ({
        refNum,
        awb: "E2E-AWB-0001",
        error: null,
        statusesHistory: [
          { ID: 1, STATUS: "Information received", DATE: "2026-11-02 08:00:00" },
          { ID: 2, STATUS: "In transit", DATE: "2026-11-02 12:00:00" },
        ],
      })),
    );
  if (p === "/fulfilment/create-order") {
    // Only the validate-only call is expected here.
    if (body.testMode !== true) throw new Error("e2e seed: a real create-order was attempted");
    return json({ orderId: null, error: false, code: 200 });
  }
  throw new Error(`e2e seed: unexpected euShipments call ${p}`);
}

export async function seedEuShipments(owner: ScopedActor, companyId: string) {
  const { systemDb } = await import("@/server/db/client");
  const { createEuConnection } = await import("@/server/eushipments/connections");
  const read = await import("@/server/eushipments/read");
  const { enqueueOutbound, processOutbound } = await import("@/server/outbox/outbox");
  const { euShipmentsTransportFor } = await import("@/server/eushipments/transport");
  const db = systemDb();
  const deps = { clientOptions: { fetchImpl: fakeFetch, sleep: async () => {} } };

  const conn = await createEuConnection(owner, {
    companyId,
    name: "euShipments Демо",
    token: E2E_EU_TOKEN,
    vendorCompanyId: 333,
    skuPrefix: "ref-",
  });
  const a = owner.accountId;
  // Masters: one matches automatically by SKU (prefix stripped), one waits for an operator link.
  await db.product.create({ data: { accountId: a, sku: "TEST-54202", name: "Демо парфюм 50 мл" } });
  await db.product.create({ data: { accountId: a, sku: "DEMO-54201", name: "Демо парфюм 100 мл" } });

  await read.testEuConnection(a, conn.id, deps);
  await read.syncEuReference(a, conn.id, deps);
  await read.syncEuProducts(a, conn.id, deps);
  await read.syncEuStock(a, conn.id, deps);

  const order = await db.order.create({
    data: {
      accountId: a,
      companyId,
      source: "MANUAL",
      number: "E2E-2001",
      status: "ACCEPTED",
      customerName: "Test Buyer EU",
      currency: "EUR",
      subtotal: "20.00",
      total: "20.00",
      paymentMethod: "COD",
      countryCode: "BG",
      placedAt: new Date("2026-11-01T10:00:00Z"),
    },
  });
  await db.fulfillment.create({
    data: {
      accountId: a,
      orderId: order.id,
      connectionId: conn.id,
      externalId: "M-E2E-2001",
      status: "ACCEPTED",
    },
  });
  await read.pollEuOrders(a, conn.id, deps);

  // DRY_RUN: one create-order validated by the (fake) vendor with testMode: true, through the real gate.
  await db.fulfillmentConnection.update({ where: { id: conn.id }, data: { liveMode: "DRY_RUN" } });
  const { request } = await enqueueOutbound({
    accountId: a,
    connectionId: conn.id,
    operation: EU_OPS.createOrder,
    idempotencyKey: "order:M-E2E-3001",
    payload: {
      body: {
        senderId: 333,
        waybillAvailableDate: "2026-11-02",
        recipient: {
          name: "Test Buyer EU",
          countryIsoCode: "BG",
          cityName: "Sofia",
          zipCode: "1000",
          streetName: "Example Street",
          buildingNumber: "12",
          phoneNumber: "0888000000",
        },
        awb: { parcels: 1, envelopes: 0, totalWeight: 0.4, bankRepayment: 20, referenceNumber: "M-E2E-3001" },
        products: [{ refNumber: "ref-test-54202", qty: 1, price: 20 }],
      },
      ctx: { referenceNumber: "M-E2E-3001" },
    },
    createdById: owner.userId,
  });
  await processOutbound(request.id, (c) => euShipmentsTransportFor(c, deps.clientOptions));
  await db.fulfillmentConnection.update({ where: { id: conn.id }, data: { liveMode: "READ_ONLY" } });
  return conn;
}
