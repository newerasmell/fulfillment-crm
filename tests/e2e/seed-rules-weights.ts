// Synthetic data for tests/e2e/rules-weights.spec.ts: its own group and OWNER. One Cyprus (CY) order at an
// euShipments connection that is blocked by the two source problems: no phone rule for CY (the euShipments
// guideline does not document CY) and a product without a weight. The warehouse mirror knows a weight (0.45 kg)
// and the store's "Тегло към Shopify" is DRY_RUN. No vendor or Shopify call anywhere.
import { bootstrapOwner } from "@/server/auth/users";
import { checkOrder } from "@/server/checks";
import { systemDb } from "@/server/db/client";

export const RULES_WEIGHTS_PASSWORD = "e2e-rules-weights-password-not-secret";
export const RW_ORDER_NUMBER = "#RW1001";

export async function seedRulesWeights() {
  const owner = await bootstrapOwner({
    email: "e2e-rules-weights@example.com",
    name: "E2E Rules Weights",
    accountName: "Тест група Правила и тегла",
    password: RULES_WEIGHTS_PASSWORD,
  });
  const sys = systemDb();
  const accountId = owner.account.id;
  const company = await sys.company.findFirstOrThrow({ where: { accountId } });
  const store = await sys.store.create({
    data: {
      accountId,
      companyId: company.id,
      domain: "e2e-rules-weights.myshopify.com",
      code: "RW",
      name: "Магазин Тегла",
      currency: "EUR",
      countries: ["CY"],
      weightWriteMode: "DRY_RUN",
    },
  });
  const eu = await sys.fulfillmentConnection.create({
    data: {
      accountId,
      companyId: company.id,
      name: "euShipments Тегла",
      type: "EUSHIPMENTS",
      liveMode: "READ_ONLY",
      vendorIds: { companyId: 4242 },
    },
  });
  await sys.routingRule.create({
    data: { accountId, priority: 1, name: "CY", connectionId: eu.id, match: { countries: ["CY"] } },
  });
  const product = await sys.product.create({
    data: {
      accountId,
      sku: "RW-PERF-50",
      name: "Примерен парфюм 50 мл",
      lengthMm: 100,
      widthMm: 60,
      heightMm: 150,
    },
  });
  const vp = await sys.vendorProduct.create({
    data: {
      accountId,
      connectionId: eu.id,
      productId: product.id,
      vendorId: "RW-PERF-50",
      lastSyncAt: new Date(),
      raw: { name: "Примерен парфюм", weight: "0.45" },
    },
  });
  await sys.stockLevel.create({
    data: {
      accountId,
      vendorProductId: vp.id,
      physical: 20,
      free: 20,
      sellable: 20,
      snapshotAt: new Date(),
      source: "POLL",
    },
  });
  const link = await sys.storeVariantLink.create({
    data: {
      accountId,
      storeId: store.id,
      shopifyVariantGid: "gid://shopify/ProductVariant/8800001",
      shopifyProductGid: "gid://shopify/Product/8810001",
      sku: "RW-PERF-50",
      title: "Примерен парфюм 50 мл",
      productId: product.id,
      matchMethod: "sku",
      matchedAt: new Date(),
    },
  });
  const address = {
    name: "Test Buyer",
    address1: "Example Street 1",
    address2: null,
    city: "Nicosia",
    zip: "1010",
    province: null,
    countryCode: "CY",
    phone: "+357 99 123456",
  };
  const order = await sys.order.create({
    data: {
      accountId,
      companyId: company.id,
      storeId: store.id,
      source: "SHOPIFY",
      number: RW_ORDER_NUMBER,
      status: "IMPORTED",
      customerName: "Test Buyer",
      email: "buyer@example.com",
      phone: "+357 99 123456",
      shippingAddress: address,
      shippingAddressOriginal: address,
      currency: "EUR",
      subtotal: "40.00",
      total: "40.00",
      paymentMethod: "PREPAID",
      countryCode: "CY",
      placedAt: new Date(),
      lines: {
        create: [
          {
            productId: product.id,
            variantLinkId: link.id,
            sku: "RW-PERF-50",
            title: "Примерен парфюм 50 мл",
            quantity: 1,
            unitPrice: "40.00",
          },
        ],
      },
    },
  });
  await checkOrder(accountId, order.id, { actor: { kind: "system" } });
  return { email: owner.user.email, password: RULES_WEIGHTS_PASSWORD, totp: owner.totpSecret };
}
