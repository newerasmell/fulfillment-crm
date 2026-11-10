// e2e seed for the Fulfill / write-back / alerts screens (wave 2, fulfill track). Synthetic data only; no
// vendor or Shopify is called (no worker runs during e2e, so outbox rows stay where the web app puts them).
import { checkOrder } from "@/server/checks";
import { systemDb } from "@/server/db/client";
import { transitionOrder } from "@/server/pipeline";

export const E2E_SHIPPED_ORDER = "#93004";
export const E2E_FULFILL_ORDERS = { a: "#93001", b: "#93002", notApproved: "#93003" } as const;

export async function seedFulfill(owner: { userId: string; accountId: string }, companyId: string) {
  const db = systemDb();
  const { accountId } = owner;
  const store = await db.store.findFirstOrThrow({ where: { accountId, code: "DM" } });
  const connection = await db.fulfillmentConnection.create({
    data: {
      accountId,
      companyId,
      type: "EUSHIPMENTS",
      name: "euShipments Изпълнение",
      vendorIds: { companyId: 4242 },
      liveMode: "CANARY",
      canaryDailyCap: 10,
    },
  });
  await db.countrySetting.upsert({
    where: { accountId_country: { accountId, country: "BG" } },
    create: { accountId, country: "BG", currency: "EUR" },
    update: {},
  });
  const product = await db.product.create({
    data: {
      accountId,
      sku: "E2E-FUL-1",
      name: "Примерен парфюм 50ml",
      weightGrams: 400,
      lengthMm: 100,
      widthMm: 60,
      heightMm: 150,
    },
  });
  const vp = await db.vendorProduct.create({
    data: { accountId, connectionId: connection.id, productId: product.id, vendorId: "E2E-FUL-REF-1" },
  });
  await db.stockLevel.create({
    data: {
      accountId,
      vendorProductId: vp.id,
      physical: 50,
      free: 50,
      sellable: 50,
      snapshotAt: new Date(),
      source: "POLL",
    },
  });
  const orders: Record<string, string> = {};
  let i = 0;
  for (const [key, number] of Object.entries(E2E_FULFILL_ORDERS)) {
    const phone = `0888 123 45${i}`;
    i++;
    const order = await db.order.create({
      data: {
        accountId,
        companyId,
        source: "SHOPIFY",
        storeId: store.id,
        number,
        status: "IMPORTED",
        customerName: "Тест Купувач",
        email: `buyer${i}@example.com`,
        phone,
        shippingAddress: {
          name: "Тест Купувач",
          address1: "ул. Примерна 12",
          city: "София",
          zip: "1000",
          countryCode: "BG",
          phone,
        },
        currency: "EUR",
        subtotal: "40.00",
        total: "40.00",
        paymentMethod: "COD",
        codAmount: "40.00",
        codLocalAmount: "40.00",
        codLocalCurrency: "EUR",
        countryCode: "BG",
        placedAt: new Date(),
        lines: {
          create: [
            { productId: product.id, sku: product.sku, title: "Примерен", quantity: 1, unitPrice: "40.00" },
          ],
        },
      },
    });
    orders[key] = order.id;
    await checkOrder(accountId, order.id, { actor: { kind: "system" }, connectionId: connection.id });
    if (key !== "notApproved")
      await transitionOrder(accountId, {
        orderId: order.id,
        to: "APPROVED",
        cause: "approve",
        actor: { kind: "user", userId: owner.userId },
        meta: { connectionId: connection.id },
      });
  }
  // A shipped shipment whose Shopify write-back was recorded in DRY_RUN (what the worker stores).
  const shipped = await db.order.create({
    data: {
      accountId,
      companyId,
      source: "SHOPIFY",
      storeId: store.id,
      shopifyOrderGid: "gid://shopify/Order/93004",
      number: E2E_SHIPPED_ORDER,
      status: "SHIPPED",
      customerName: "Тест Получател",
      currency: "EUR",
      subtotal: "20.00",
      total: "20.00",
      paymentMethod: "PREPAID",
      countryCode: "BG",
      placedAt: new Date(),
    },
  });
  const f = await db.fulfillment.create({
    data: {
      accountId,
      orderId: shipped.id,
      connectionId: connection.id,
      externalId: "DM-93004",
      status: "SHIPPED",
      trackingNumbers: ["E2E-TRK-93004"],
      shippedAt: new Date(),
    },
  });
  await db.shopifyWriteBack.create({
    data: {
      accountId,
      storeId: store.id,
      orderId: shipped.id,
      fulfillmentId: f.id,
      trackingNumber: "E2E-TRK-93004",
      status: "DRY_RUN_RECORDED",
      evaluatedMode: "DRY_RUN",
      request: {
        mutation: "mutation FulfillmentWriteBack(...)",
        variables: {
          fulfillment: {
            lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: "gid://shopify/FulfillmentOrder/93004" }],
            notifyCustomer: true,
            trackingInfo: { number: "E2E-TRK-93004" },
          },
        },
      },
    },
  });
  // The status that follows (lifecycle): an "in transit" fulfillment event, recorded in DRY_RUN.
  await db.shopifyWriteBack.create({
    data: {
      accountId,
      storeId: store.id,
      orderId: shipped.id,
      fulfillmentId: f.id,
      kind: "EVENT",
      value: "IN_TRANSIT",
      status: "DRY_RUN_RECORDED",
      evaluatedMode: "DRY_RUN",
      request: {
        mutation: "mutation FulfillmentEventWriteBack(...)",
        variables: {
          fulfillmentEvent: {
            fulfillmentId: "<the Shopify fulfillment created by the FULFIL write-back>",
            status: "IN_TRANSIT",
          },
        },
      },
    },
  });
  // A shipped shipment whose courier Shopify does not know: its write-back is held for a person to pick one.
  const held = await db.order.create({
    data: {
      accountId,
      companyId,
      source: "SHOPIFY",
      storeId: store.id,
      shopifyOrderGid: "gid://shopify/Order/93005",
      number: "#93005",
      status: "SHIPPED",
      customerName: "Тест Получател",
      currency: "EUR",
      subtotal: "20.00",
      total: "20.00",
      paymentMethod: "PREPAID",
      countryCode: "GR",
      placedAt: new Date(),
    },
  });
  const hf = await db.fulfillment.create({
    data: {
      accountId,
      orderId: held.id,
      connectionId: connection.id,
      externalId: "DM-93005",
      status: "SHIPPED",
      carrier: "E2E Local Courier",
      trackingNumbers: ["E2E-TRK-93005"],
      shippedAt: new Date(),
    },
  });
  await db.shopifyWriteBack.create({
    data: {
      accountId,
      storeId: store.id,
      orderId: held.id,
      fulfillmentId: hf.id,
      trackingNumber: "E2E-TRK-93005",
      status: "AWAITING_CONFIRMATION",
      evaluatedMode: "LIVE",
      lastError: "carrier_unknown",
    },
  });
  await db.alert.create({
    data: {
      accountId,
      kind: "shopify_carrier_unknown",
      isTask: true,
      title: "Изберете куриер за Shopify",
      entityType: "Order",
      entityId: held.id,
    },
  });
  // Противосаботаж: an order held for its quantity (20 of one product), waiting for a person.
  await db.order.create({
    data: {
      accountId,
      companyId,
      source: "SHOPIFY",
      storeId: store.id,
      shopifyOrderGid: "gid://shopify/Order/93006",
      number: "#93006",
      status: "QTY_HOLD",
      customerName: "Тест Получател",
      currency: "EUR",
      subtotal: "200.00",
      total: "200.00",
      paymentMethod: "PREPAID",
      countryCode: "BG",
      placedAt: new Date(),
      lines: { create: [{ title: "Синтетична тениска", quantity: 20, unitPrice: "10.00" }] },
    },
  });
  // "Липсващи артикули": a store that records Shopify writes as a test (DRY_RUN), one order still out of stock
  // (its item expected in an open inbound request) and one whose items are back (to confirm).
  const msStore = await db.store.create({
    data: {
      accountId,
      companyId,
      domain: "e2e-missing-stock.myshopify.com",
      code: "MS",
      name: "Липси Магазин",
      currency: "EUR",
      writeBackMode: "DRY_RUN",
      connectionStatus: { ok: true, scopes: ["read_orders", "write_orders"] },
    },
  });
  const waitLine = (lineId: string, available: boolean, wasMissing: boolean | null) => ({
    lineId,
    title: "Синтетична тениска черна M",
    sku: "E2E-TEE-M",
    quantity: 1,
    unlinked: false,
    available,
    wasMissing,
    expected: available
      ? []
      : [{ connectionId: connection.id, remaining: 5, expectedAt: null, inboundId: "e2e-inbound" }],
  });
  for (const [n, state, tag] of [
    ["#93101", "OUT_OF_STOCK", "out_of_stock"],
    ["#93102", "READY", "waiting_for_stock"],
  ] as const) {
    const o = await db.order.create({
      data: {
        accountId,
        companyId,
        source: "SHOPIFY",
        storeId: msStore.id,
        shopifyOrderGid: `gid://shopify/Order/${n.slice(1)}`,
        number: n,
        status: "AWAITING_TAG",
        customerName: "Тест Получател",
        currency: "EUR",
        subtotal: "20.00",
        total: "20.00",
        paymentMethod: "COD",
        countryCode: "BG",
        placedAt: new Date(),
        tags: [tag],
        raw: { tags: [tag] },
        lines: {
          create: [
            { productId: product.id, title: "Синтетична тениска черна M", quantity: 1, unitPrice: "20.00" },
          ],
        },
      },
      include: { lines: true },
    });
    const ready = state === "READY";
    await db.orderStockWait.create({
      data: {
        accountId,
        orderId: o.id,
        stage: tag,
        state,
        expected: !ready,
        readyConnectionId: ready ? connection.id : null,
        missingLineIds: ready ? [o.lines[0]!.id] : [],
        detail: {
          connectionId: connection.id,
          lines: [waitLine(o.lines[0]!.id, ready, ready ? true : null)],
        },
        evaluatedAt: new Date(),
      },
    });
  }
  // An open task of the kind the Shopify import raises after approval (alerts screen, P4-08).
  await db.alert.create({
    data: {
      accountId,
      kind: "shopify_cancelled_after_approval",
      isTask: true,
      severity: "CRITICAL",
      title: "E2E: поръчка отказана в Shopify след одобрение",
      entityType: "Order",
      entityId: orders.b!,
    },
  });
  return { connectionId: connection.id, orders, shippedOrderId: shipped.id };
}
