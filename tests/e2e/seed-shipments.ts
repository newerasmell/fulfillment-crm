// Synthetic data for the shipments + warehouse tickets e2e (tests/e2e/shipments.spec.ts). A separate group with its
// own OWNER, so other specs' counts never change. No vendor call: shipments are rows as the FHB / euShipments read
// syncs would leave them; one FHB ticket notification is stored the way the callback worker stores it.
//   Фирма Пратки А (line "Козметика") — FHB "FHB Пратки" + FHB Joy "Joy Пратки"
//   Фирма Пратки Б (line "Текстил")   — euShipments "euShipments Пратки"
import { bootstrapOwner } from "@/server/auth/users";
import { systemDb } from "@/server/db/client";
import { createFhbConnection } from "@/server/fhb/connection";

export const SHIPMENTS_PASSWORD = "e2e-shipments-password-not-secret";
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);

export async function seedShipments() {
  const owner = await bootstrapOwner({
    email: "e2e-shipments@example.com",
    name: "E2E Shipments",
    accountName: "Тест група Товарителници",
    password: SHIPMENTS_PASSWORD,
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
    data: { name: "Фирма Пратки А", lineId: lineA.id },
  });
  const coB = await sys.company.create({ data: { accountId, name: "Фирма Пратки Б", lineId: lineB.id } });
  const fhb = await createFhbConnection(
    { userId: owner.user.id, accountId, role: "OWNER" },
    {
      companyId: coA.id,
      name: "FHB Пратки",
      appId: "e2e-shipments-app",
      secret: "e2e-shipments-secret-not-real",
      skuPrefix: "SH",
    },
  );
  const joy = await sys.fulfillmentConnection.create({
    data: { accountId, companyId: coA.id, name: "Joy Пратки", type: "FHB_JOY", liveMode: "READ_ONLY" },
  });
  const eu = await sys.fulfillmentConnection.create({
    data: {
      accountId,
      companyId: coB.id,
      name: "euShipments Пратки",
      type: "EUSHIPMENTS",
      liveMode: "READ_ONLY",
    },
  });
  await sys.fhbCarrier.create({
    data: { accountId, connectionId: fhb.id, code: "gls-ro", name: "GLS Romania", lastSyncAt: new Date() },
  });
  await sys.eushipmentsCourier.create({
    data: { accountId, connectionId: eu.id, courierId: 41, name: "Speedy", syncedAt: new Date() },
  });

  let k = 0;
  const shipment = async (o: {
    number: string;
    companyId: string;
    connectionId: string;
    status: "QUEUED" | "ACCEPTED" | "SHIPPED" | "DELIVERED" | "RETURNING" | "UNKNOWN" | "CANCELLED";
    rawStatus?: string;
    carrier?: string;
    tracking?: string[];
    urls?: string[];
    createdDaysAgo: number;
    shippedDaysAgo?: number;
    deliveredDaysAgo?: number;
    customer?: string;
    phone?: string;
    cod?: { amount: number; currency: string };
    externalId?: string;
  }) => {
    k++;
    const order = await sys.order.create({
      data: {
        accountId,
        companyId: o.companyId,
        source: "MANUAL",
        number: o.number,
        status: o.status,
        customerName: o.customer ?? "Синтетичен клиент",
        phone: o.phone ?? null,
        currency: "EUR",
        subtotal: "20.00",
        total: "20.00",
        paymentMethod: o.cod ? "COD" : "PREPAID",
        codAmount: o.cod ? "20.00" : null,
        codLocalAmount: o.cod?.amount,
        codLocalCurrency: o.cod?.currency,
        countryCode: o.cod?.currency === "RON" ? "RO" : "BG",
        tags: [],
        placedAt: ago(o.createdDaysAgo),
      },
    });
    return sys.fulfillment.create({
      data: {
        accountId,
        orderId: order.id,
        connectionId: o.connectionId,
        externalId: o.externalId ?? `SH-E2E-${k}`,
        status: o.status,
        rawStatus: o.rawStatus ?? null,
        carrier: o.carrier ?? null,
        trackingNumbers: o.tracking ?? [],
        trackingUrls: o.urls ?? [],
        createdAt: ago(o.createdDaysAgo),
        submittedAt: ago(o.createdDaysAgo),
        shippedAt: o.shippedDaysAgo == null ? null : ago(o.shippedDaysAgo),
        deliveredAt: o.deliveredDaysAgo == null ? null : ago(o.deliveredDaysAgo),
      },
    });
  };

  // ── the rows the spec looks at ──
  const fresh = await shipment({
    number: "#SH-1001",
    companyId: coA.id,
    connectionId: fhb.id,
    status: "SHIPPED",
    rawStatus: "sent",
    carrier: "gls-ro",
    tracking: ["GLSRO000111"],
    urls: ["https://tracking.example.test/GLSRO000111"],
    createdDaysAgo: 2,
    shippedDaysAgo: 1,
    customer: "Мария Синтетична",
    phone: "+40700000111",
    cod: { amount: 99.5, currency: "RON" },
  });
  await shipment({
    number: "#SH-1002",
    companyId: coB.id,
    connectionId: eu.id,
    status: "SHIPPED",
    rawStatus: "Information received",
    carrier: "41",
    tracking: ["SPD000222"],
    createdDaysAgo: 15,
    shippedDaysAgo: 12,
  });
  await shipment({
    number: "#SH-1003",
    companyId: coA.id,
    connectionId: fhb.id,
    status: "ACCEPTED",
    rawStatus: "confirmed",
    createdDaysAgo: 0,
  });
  await shipment({
    number: "#SH-1004",
    companyId: coA.id,
    connectionId: fhb.id,
    status: "RETURNING",
    rawStatus: "returned",
    tracking: ["GLSRO000444"],
    createdDaysAgo: 20,
    shippedDaysAgo: 18,
  });
  await shipment({
    number: "#SH-1005",
    companyId: coA.id,
    connectionId: fhb.id,
    status: "UNKNOWN",
    rawStatus: "teleported",
    createdDaysAgo: 3,
  });
  await shipment({
    number: "#SH-1006",
    companyId: coA.id,
    connectionId: fhb.id,
    status: "CANCELLED",
    rawStatus: "cancelled",
    createdDaysAgo: 4,
  });
  // A Joy label (manual shipment): its Fulfillment row + the ManualShipment that created it.
  const joyShip = await shipment({
    number: "M1001",
    companyId: coA.id,
    connectionId: joy.id,
    status: "SHIPPED",
    rawStatus: "In transit",
    carrier: "packeta",
    tracking: ["JOY000333"],
    createdDaysAgo: 1,
    shippedDaysAgo: 1,
  });
  await sys.manualShipment.create({
    data: {
      accountId,
      orderId: joyShip.orderId,
      kind: "JOY_LABEL",
      connectionId: joy.id,
      fulfillmentId: joyShip.id,
    },
  });
  // 50 delivered euShipments shipments: the list needs a second page.
  for (let i = 0; i < 50; i++)
    await shipment({
      number: `#SH-2${String(i).padStart(3, "0")}`,
      companyId: coB.id,
      connectionId: eu.id,
      status: "DELIVERED",
      rawStatus: "Delivered",
      carrier: "41",
      tracking: [`SPD9${String(i).padStart(5, "0")}`],
      createdDaysAgo: 30 + i,
      shippedDaysAgo: 29 + i,
      deliveredDaysAgo: 27 + i,
    });

  // ── one FHB ticket, stored the way the callback worker stores it (ticket_created → alert) ──
  const { recordFhbTicketEvent } = await import("@/server/tickets");
  const ev = await sys.webhookEvent.create({
    data: {
      accountId,
      source: "FHB",
      dedupeKey: `e2e-ticket-${fresh.id}`,
      topic: "order.ticket_created",
      headers: { connectionId: fhb.id },
      payload: { fulfillmentId: fresh.id },
      status: "PROCESSED",
      receivedAt: ago(1),
    },
  });
  await recordFhbTicketEvent(accountId, {
    fulfillmentId: fresh.id,
    webhookEventId: ev.id,
    event: "ticket_created",
    receivedAt: ago(1),
  });
  return { email: owner.user.email, password: SHIPMENTS_PASSWORD, totp: owner.totpSecret };
}
