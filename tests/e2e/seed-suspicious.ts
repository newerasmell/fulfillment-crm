// Synthetic data for the "Съмнителни връзки" e2e (tests/e2e/suspicious.spec.ts). Its own group and OWNER.
// Invented names only. The owner's case (2026-11-03): SKU 5900000000007 was reused, so the store variant
// "Gamma Rose EDP 15ml" is linked by SKU to the warehouse product / master "Decant Beta Noir EDP 15ml".
// No vendor or Shopify call: mirror rows as the read syncs would leave them.
import { bootstrapOwner } from "@/server/auth/users";
import { systemDb } from "@/server/db/client";
import { ALL_LINKS, refreshSuspiciousLinks } from "@/server/products/suspicious";

export const SUSPICIOUS_PASSWORD = "e2e-suspicious-password-not-secret";
const LOC = "gid://shopify/Location/77001";

export async function seedSuspicious() {
  const owner = await bootstrapOwner({
    email: "e2e-suspicious@example.com",
    name: "E2E Suspicious",
    accountName: "Тест група Връзки",
    password: SUSPICIOUS_PASSWORD,
  });
  const sys = systemDb();
  const accountId = owner.account.id;
  const line = await sys.productLine.create({ data: { accountId, name: "Парфюми" } });
  const first = await sys.company.findFirstOrThrow({ where: { accountId } });
  const company = await sys.company.update({
    where: { id: first.id },
    data: { name: "Фирма Връзки", lineId: line.id },
  });
  const fhb = await sys.fulfillmentConnection.create({
    data: { accountId, companyId: company.id, type: "FHB_V3", name: "FHB Връзки", liveMode: "READ_ONLY" },
  });
  const store = await sys.store.create({
    data: {
      accountId,
      companyId: company.id,
      domain: "e2e-suspicious.myshopify.com",
      code: "SV",
      name: "Магазин Връзки",
      currency: "EUR",
      skuPrefix: "",
      connectionStatus: { ok: true },
    },
  });
  await sys.storeLocation.create({
    data: {
      accountId,
      storeId: store.id,
      shopifyLocationGid: LOC,
      name: "Склад",
      connectionId: fhb.id,
      fetchedAt: new Date(),
    },
  });
  const pair = async (n: number, sku: string, master: string, variant: string) => {
    const product = await sys.product.create({ data: { accountId, sku, name: master, lineId: line.id } });
    await sys.vendorProduct.create({
      data: {
        accountId,
        connectionId: fhb.id,
        productId: product.id,
        vendorId: `SK${sku}`,
        lastSyncAt: new Date(),
        raw: { name: master },
        stockLevel: { create: { physical: 5, free: 5, sellable: 5, snapshotAt: new Date(), source: "POLL" } },
      },
    });
    const link = await sys.storeVariantLink.create({
      data: {
        accountId,
        storeId: store.id,
        shopifyVariantGid: `gid://shopify/ProductVariant/77${n}`,
        shopifyProductGid: `gid://shopify/Product/77${n}`,
        sku,
        title: variant,
        productId: product.id,
        matchMethod: "sku",
      },
    });
    await sys.shopifyInventoryLevel.create({
      data: {
        accountId,
        storeId: store.id,
        variantLinkId: link.id,
        locationGid: LOC,
        inventoryItemGid: `gid://shopify/InventoryItem/77${n}`,
        available: 1,
        fetchedAt: new Date(),
      },
    });
  };
  await pair(
    1,
    "5900000000001",
    "Decant Alpha Bloom EDP 15ml",
    "Alpha Bloom Eau de Parfum 15 ml - Default Title",
  );
  await pair(2, "5900000000007", "Decant Beta Noir EDP 15ml", "Gamma Rose EDP 15ml - Default Title");
  // What the product sync's refresh would have stored.
  await refreshSuspiciousLinks(accountId, ALL_LINKS);
  return {
    email: owner.user.email,
    password: SUSPICIOUS_PASSWORD,
    totp: owner.totpSecret,
    storeId: store.id,
  };
}
