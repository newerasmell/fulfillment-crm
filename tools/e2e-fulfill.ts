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
