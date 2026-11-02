// Synthetic data for the stock / inbound / inventory push e2e (tests/e2e/stock.spec.ts). Its own group and OWNER,
// so other specs' counts never change. No vendor or Shopify call: mirrors (VendorProduct + StockLevel,
// ShopifyInventoryLevel, StoreLocation) are rows as the read syncs would leave them.
//   FHB "FHB Склад С" (DRY_RUN) and euShipments "euShipments Склад С" (DRY_RUN, warehouse "Склад София")
//   STK-ORIG (+ tester STK-TEST), STK-ZERO (nothing on stock), STK-FAST (sells fast: runs out within 7 days)
//   Store "Магазин С" (push DRY_RUN, buffer 1), its location "Склад FHB" mapped to the FHB connection; Shopify
//   shows 50 of STK-ORIG (more than the CRM can sell → "Разминаване със Shopify").
import { bootstrapOwner } from "@/server/auth/users";
import { systemDb } from "@/server/db/client";

export const STOCK_PASSWORD = "e2e-stock-password-not-secret";

export async function seedStock() {
  const owner = await bootstrapOwner({
    email: "e2e-stock@example.com",
    name: "E2E Stock",
    accountName: "Тест група Склад",
    password: STOCK_PASSWORD,
  });
  const sys = systemDb();
  const accountId = owner.account.id;
  const company = await sys.company.findFirstOrThrow({ where: { accountId } });
  const now = new Date();
  const fhb = await sys.fulfillmentConnection.create({
    data: { accountId, companyId: company.id, type: "FHB_V3", name: "FHB Склад С", liveMode: "DRY_RUN" },
  });
  const eu = await sys.fulfillmentConnection.create({
    data: {
      accountId,
      companyId: company.id,
      type: "EUSHIPMENTS",
      name: "euShipments Склад С",
      liveMode: "DRY_RUN",
      vendorIds: { companyId: 333 },
    },
  });
  await sys.eushipmentsWarehouse.create({
    data: { accountId, connectionId: eu.id, warehouseId: 7, name: "Склад София", syncedAt: now },
  });
  const product = (sku: string, name: string, extra: { isTester?: boolean; parentProductId?: string } = {}) =>
    sys.product.create({ data: { accountId, sku, name, ...extra } });
  const orig = await product("STK-ORIG", "Синтетичен парфюм 50 мл");
  const tester = await product("STK-TEST", "Синтетичен парфюм 50 мл тестер", {
    isTester: true,
    parentProductId: orig.id,
  });
  const zero = await product("STK-ZERO", "Синтетичен крем 30 мл");
  const fast = await product("STK-FAST", "Синтетичен лосион 200 мл");
  await sys.productEan.create({
    data: { accountId, productId: orig.id, ean: "0000000000031", note: "партида 1", source: "e2e" },
  });
  const vp = (connectionId: string, productId: string, vendorId: string, physical: number, free: number) =>
    sys.vendorProduct.create({
      data: {
        accountId,
        connectionId,
        productId,
        vendorId,
        vendorCode: connectionId === fhb.id ? `RTM${vendorId.slice(-4)}` : null,
        lastSyncAt: now,
        raw: { type: "single" },
        stockLevel: {
          create: {
            physical,
            free,
            sellable: free,
            snapshotAt: now,
            source: connectionId === fhb.id ? "PUSH" : "POLL",
          },
        },
      },
    });
  const vOrig = await vp(fhb.id, orig.id, "RSK-STK-ORIG", 12, 10);
  await vp(eu.id, orig.id, "EU-STK-ORIG", 5, 5);
  await vp(fhb.id, tester.id, "RSK-STK-TEST", 2, 2);
  await vp(fhb.id, zero.id, "RSK-STK-ZERO", 0, 0);
  await vp(fhb.id, fast.id, "RSK-STK-FAST", 6, 6);
  await sys.stockMovement.create({
    data: {
      accountId,
      connectionId: fhb.id,
      vendorProductId: vOrig.id,
      externalId: "e2e-mv-1",
      kind: "in",
      quantity: 12,
      occurredAt: new Date(now.getTime() - 86_400_000),
      raw: { quantity: 12, reason: "Receipt", order: null, stock_receipt: "IN-E2E-0001" },
    },
  });
  const store = await sys.store.create({
    data: {
      accountId,
      companyId: company.id,
      domain: "e2e-stock.myshopify.com",
      code: "SC",
      name: "Магазин С",
      currency: "EUR",
      countries: ["BG"],
      connectionStatus: { ok: true, at: now.toISOString() },
      inventoryPushMode: "DRY_RUN",
      inventoryBuffer: 1,
    },
  });
  const location = await sys.storeLocation.create({
    data: {
      accountId,
      storeId: store.id,
      shopifyLocationGid: "gid://shopify/Location/9901",
      name: "Склад FHB",
      connectionId: fhb.id,
      fetchedAt: now,
    },
  });
  await sys.storeLocation.create({
    data: {
      accountId,
      storeId: store.id,
      shopifyLocationGid: "gid://shopify/Location/9902",
      name: "Офис",
      fetchedAt: now,
    },
  });
  const links: Record<string, string> = {};
  for (const [i, p, available] of [
    [1, orig, 50],
    [2, fast, 6],
    [3, zero, 0],
  ] as const) {
    const link = await sys.storeVariantLink.create({
      data: {
        accountId,
        storeId: store.id,
        shopifyVariantGid: `gid://shopify/ProductVariant/990${i}`,
        shopifyProductGid: `gid://shopify/Product/99${i}`,
        sku: `SC-${p.sku}`,
        title: p.name,
        productId: p.id,
      },
    });
    links[p.sku] = link.id;
    await sys.shopifyInventoryLevel.create({
      data: {
        accountId,
        storeId: store.id,
        variantLinkId: link.id,
        locationGid: location.shopifyLocationGid,
        inventoryItemGid: `gid://shopify/InventoryItem/880${i}`,
        available,
        onHand: available,
        fetchedAt: now,
      },
    });
  }
  // Sales of the last 30 days: 30 × STK-FAST → 1 a day, 6 sellable → runs out within 7 days.
  await sys.order.create({
    data: {
      accountId,
      companyId: company.id,
      source: "SHOPIFY",
      storeId: store.id,
      number: "#S-7001",
      status: "DELIVERED",
      currency: "EUR",
      subtotal: 30,
      total: 30,
      paymentMethod: "PREPAID",
      placedAt: new Date(now.getTime() - 5 * 86_400_000),
      lines: {
        create: [
          {
            productId: fast.id,
            variantLinkId: links["STK-FAST"],
            title: fast.name,
            quantity: 30,
            unitPrice: 1,
          },
        ],
      },
    },
  });
  return { email: owner.user.email, password: STOCK_PASSWORD, totp: owner.totpSecret };
}
