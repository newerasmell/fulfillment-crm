// Synthetic data for the reports e2e (tests/e2e/reports.spec.ts). A separate group with its own OWNER, so other
// specs' counts never change and these counts are exact. No vendor call: shipments, COD and stock are rows as the
// warehouse read syncs would leave them.
//   Фирма Справки А — store "Магазин Справки", FHB "FHB Справки" (carrier gls → "GLS")
//   Фирма Справки Б — euShipments "euShipments Справки"
import { bootstrapOwner } from "@/server/auth/users";
import { systemDb } from "@/server/db/client";

export const REPORTS_PASSWORD = "e2e-reports-password-not-secret";
const H = 3_600_000;
const DAY = 24 * H;
const ago = (ms: number) => new Date(Date.now() - ms);

export async function seedReports() {
  const owner = await bootstrapOwner({
    email: "e2e-reports@example.com",
    name: "E2E Reports",
    accountName: "Тест група Справки",
    password: REPORTS_PASSWORD,
  });
  const sys = systemDb();
  const accountId = owner.account.id;
  const first = await sys.company.findFirstOrThrow({ where: { accountId } });
  const coA = await sys.company.update({ where: { id: first.id }, data: { name: "Фирма Справки А" } });
  const coB = await sys.company.create({ data: { accountId, name: "Фирма Справки Б" } });
  const store = await sys.store.create({
    data: {
      accountId,
      companyId: coA.id,
      domain: "e2e-reports.myshopify.com",
      code: "SP",
      name: "Магазин Справки",
      currency: "EUR",
    },
  });
  const fhb = await sys.fulfillmentConnection.create({
    data: { accountId, companyId: coA.id, name: "FHB Справки", type: "FHB_V3", liveMode: "READ_ONLY" },
  });
  const eu = await sys.fulfillmentConnection.create({
    data: {
      accountId,
      companyId: coB.id,
      name: "euShipments Справки",
      type: "EUSHIPMENTS",
      liveMode: "READ_ONLY",
    },
  });
  await sys.fhbCarrier.create({
    data: { accountId, connectionId: fhb.id, code: "gls", name: "GLS", lastSyncAt: new Date() },
  });

  let k = 0;
  const order = (o: {
    company: string;
    daysAgo: number;
    currency?: string;
    total: number;
    cod?: boolean;
    status: "IMPORTED" | "ON_HOLD" | "BLOCKED" | "SHIPPED" | "DELIVERED" | "RETURNING" | "CANCELLED";
    store?: boolean;
  }) => {
    const placed = ago(o.daysAgo * DAY);
    return sys.order.create({
      data: {
        accountId,
        companyId: o.company,
        storeId: o.store === false ? null : store.id,
        source: o.store === false ? "MANUAL" : "SHOPIFY",
        number: `#SP-${1000 + ++k}`,
        currency: o.currency ?? "EUR",
        subtotal: o.total,
        total: o.total,
        paymentMethod: o.cod ? "COD" : "PREPAID",
        codAmount: o.cod ? o.total : null,
        codLocalAmount: o.cod ? o.total : null,
        codLocalCurrency: o.cod ? (o.currency ?? "EUR") : null,
        placedAt: placed,
        createdAt: new Date(placed.getTime() + 0.5 * H),
        status: o.status,
      },
    });
  };
  const event = (orderId: string, toStatus: "APPROVED", at: Date) =>
    sys.orderEvent.create({
      data: {
        accountId,
        orderId,
        toStatus,
        cause: "approve",
        actorType: "user",
        source: "e2e",
        createdAt: at,
      },
    });
  const ship = (
    o: { id: string; createdAt: Date },
    connectionId: string,
    status: "SHIPPED" | "DELIVERED" | "RETURNING" | "CANCELLED",
    carrier: string | null,
  ) => {
    const submitted = new Date(o.createdAt.getTime() + 3 * H);
    const shipped = status === "CANCELLED" ? null : new Date(submitted.getTime() + 20 * H);
    return sys.fulfillment.create({
      data: {
        accountId,
        orderId: o.id,
        connectionId,
        externalId: `SP-${++k}`,
        status,
        carrier,
        createdAt: submitted,
        submittedAt: submitted,
        shippedAt: shipped,
        deliveredAt: status === "DELIVERED" && shipped ? new Date(shipped.getTime() + 48 * H) : null,
        trackingNumbers: [`TSP${k}`],
      },
    });
  };

  // FHB / company A: 4 shipped COD orders in EUR (2 delivered, 1 returned, 1 on the way) + 1 cancelled shipment.
  const fhbOrders = [];
  for (const [i, status] of (
    ["DELIVERED", "DELIVERED", "RETURNING", "SHIPPED", "CANCELLED"] as const
  ).entries()) {
    const o = await order({
      company: coA.id,
      daysAgo: 10 - i,
      total: 20 + i * 10,
      cod: true,
      status: status === "CANCELLED" ? "CANCELLED" : status,
    });
    await event(o.id, "APPROVED", new Date(o.createdAt.getTime() + 2 * H));
    fhbOrders.push(await ship(o, fhb.id, status, "gls"));
  }
  // euShipments / company B: 1 delivered prepaid order in HUF, no courier on the shipment.
  const huf = await order({
    company: coB.id,
    daysAgo: 4,
    currency: "HUF",
    total: 9000,
    status: "DELIVERED",
    store: false,
  });
  await event(huf.id, "APPROVED", new Date(huf.createdAt.getTime() + 1 * H));
  await ship(huf, eu.id, "DELIVERED", null);
  // Waiting in the CRM: on hold, blocked (with checks and review decisions).
  const held = await order({ company: coA.id, daysAgo: 2, total: 15, status: "ON_HOLD" });
  const blocked = await order({ company: coB.id, daysAgo: 1, total: 12, status: "BLOCKED" });
  for (const o of [held, blocked])
    await sys.orderCheck.create({
      data: {
        accountId,
        orderId: o.id,
        routing: {},
        findings: [
          {
            code: "phone_invalid",
            severity: "hard",
            source: "order",
            message_bg: "Невалиден телефон",
            message_en: "Invalid phone",
          },
        ],
        hardCount: 1,
      },
    });
  await sys.review.create({
    data: {
      accountId,
      orderId: held.id,
      decision: "HOLD",
      reasonCode: "customer_contact",
      timeSpentMs: 30_000,
      decidedAt: ago(DAY),
    },
  });

  // FHB COD: the first delivered one is paid out by the warehouse (cod/list mirror), the second still waiting.
  await sys.fhbSyncState.create({
    data: { accountId, connectionId: fhb.id, resource: "cod", lastRunAt: new Date(), lastOkAt: new Date() },
  });
  await sys.fhbCodMirror.create({
    data: {
      accountId,
      connectionId: fhb.id,
      externalId: fhbOrders[0]!.externalId,
      cod: 20,
      status: "paid",
      raw: {},
      paidAt: ago(DAY),
      lastSyncAt: new Date(),
    },
  });
  await sys.fhbCodMirror.create({
    data: {
      accountId,
      connectionId: fhb.id,
      externalId: fhbOrders[1]!.externalId,
      cod: 30,
      status: "waiting",
      raw: {},
      lastSyncAt: new Date(),
    },
  });

  // Stock: "Крем Справки" has nothing at the warehouse but an open order asks for 2; "Серум Справки" sells fast.
  const product = (sku: string, name: string, physical: number) =>
    sys.product.create({ data: { accountId, sku, name } }).then(async (p) => {
      const vp = await sys.vendorProduct.create({
        data: { accountId, connectionId: fhb.id, productId: p.id, vendorId: `SP-${sku}` },
      });
      await sys.stockLevel.create({
        data: {
          accountId,
          vendorProductId: vp.id,
          physical,
          free: physical,
          snapshotAt: new Date(),
          source: "POLL",
        },
      });
      return p;
    });
  const cream = await product("SP-CREAM", "Крем Справки", 0);
  const serum = await product("SP-SERUM", "Серум Справки", 10);
  const open = await order({ company: coA.id, daysAgo: 0, total: 8, status: "IMPORTED" });
  await sys.orderLine.create({
    data: {
      accountId,
      orderId: open.id,
      productId: cream.id,
      sku: "SP-CREAM",
      title: "Крем Справки",
      quantity: 2,
      unitPrice: 4,
    },
  });
  // 60 sold in the last 30 days on an already delivered order → 10 sellable last 5 days.
  await sys.orderLine.create({
    data: {
      accountId,
      orderId: fhbOrders[0]!.orderId,
      productId: serum.id,
      sku: "SP-SERUM",
      title: "Серум Справки",
      quantity: 60,
      unitPrice: 1,
    },
  });
  return { email: owner.user.email, password: REPORTS_PASSWORD, totp: owner.totpSecret };
}
