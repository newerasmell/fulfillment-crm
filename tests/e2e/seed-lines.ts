// Synthetic data for the product-lines e2e (tests/e2e/lines.spec.ts). A separate group with its own OWNER, so the
// line filter and line colours never change what other specs see. No vendor or Shopify call: warehouse
// catalogues are mirror rows (VendorProduct) as the read syncs would leave them.
//   Козметика А  — FHB "FHB Козметика А" (prefix KA-, 4 products), store "Козметика магазин" (prefix SH-)
//   Козметика Б  — euShipments "euShipments Козметика Б" (prefix EB-, 3 products, one only by name)
//   Текстил Т    — FHB "FHB Текстил" (prefix TT-, 2 products)
// Order #L-8001 of Козметика А is routed to Козметика Б's warehouse (↔ склад на друга фирма).
import { bootstrapOwner } from "@/server/auth/users";
import { systemDb, withAccountTransaction } from "@/server/db/client";
import { recordInitialStatus } from "@/server/pipeline";

export const LINES_PASSWORD = "e2e-lines-password-not-secret";

export async function seedLines() {
  const owner = await bootstrapOwner({
    email: "e2e-lines@example.com",
    name: "E2E Lines",
    accountName: "Тест група Линии",
    password: LINES_PASSWORD,
  });
  const sys = systemDb();
  const accountId = owner.account.id;
  const first = await sys.company.findFirstOrThrow({ where: { accountId } });
  const coA = await sys.company.update({ where: { id: first.id }, data: { name: "Козметика А" } });
  const coB = await sys.company.create({ data: { accountId, name: "Козметика Б" } });
  const coT = await sys.company.create({ data: { accountId, name: "Текстил Т" } });
  const conn = (name: string, type: "FHB_V3" | "EUSHIPMENTS", companyId: string, prefix: string) =>
    sys.fulfillmentConnection.create({
      data: { accountId, name, type, companyId, skuPrefixRule: { prefix }, liveMode: "READ_ONLY" },
    });
  const fhbA = await conn("FHB Козметика А", "FHB_V3", coA.id, "KA-");
  const euB = await conn("euShipments Козметика Б", "EUSHIPMENTS", coB.id, "EB-");
  const fhbT = await conn("FHB Текстил", "FHB_V3", coT.id, "TT-");
  const vp = (connectionId: string, vendorId: string, name: string) =>
    sys.vendorProduct.create({
      data: { accountId, connectionId, vendorId, lastSyncAt: new Date(), raw: { name, type: "single" } },
    });
  await vp(fhbA.id, "KA-SYN-CR-50", "Синтетичен крем 50 мл");
  await vp(fhbA.id, "KA-SYN-CR-100", "Синтетичен крем 100 мл");
  await vp(fhbA.id, "KA-SYN-SH-250", "Синтетичен шампоан 250 мл");
  await vp(fhbA.id, "KA-SYN-SO-90", "Синтетичен сапун 90 г");
  await vp(euB.id, "EB-SYN-CR-50", "Синтетичен крем 50 мл");
  await vp(euB.id, "EB-SYN-SH-250", "Синтетичен шампоан 250 мл");
  await vp(euB.id, "EB-9001", "Синтетичен сапун 90г");
  await vp(fhbT.id, "TT-SYN-TS-M", "Синтетична тениска M");
  await vp(fhbT.id, "TT-SYN-CR-50", "Синтетичен текстил със същото SKU");
  const store = await sys.store.create({
    data: {
      accountId,
      companyId: coA.id,
      domain: "e2e-lines.myshopify.com",
      code: "LN",
      name: "Козметика магазин",
      currency: "EUR",
      countries: ["BG"],
      skuPrefix: "SH-",
    },
  });
  for (const [i, sku, title] of [
    [1, "SH-SYN-CR-50", "Синтетичен крем 50 мл"],
    [2, "SH-SYN-SO-90", "Синтетичен сапун 90 г"],
  ] as const) {
    await sys.storeVariantLink.create({
      data: {
        accountId,
        storeId: store.id,
        shopifyVariantGid: `gid://shopify/ProductVariant/880${i}`,
        shopifyProductGid: `gid://shopify/Product/88${i}`,
        sku,
        title,
      },
    });
  }
  await withAccountTransaction(accountId, async (tx) => {
    const o = await tx.order.create({
      data: {
        accountId,
        companyId: coA.id,
        source: "SHOPIFY",
        storeId: store.id,
        shopifyOrderGid: "gid://shopify/Order/9880001",
        number: "#L-8001",
        status: "IMPORTED",
        customerName: "Lines Buyer",
        currency: "EUR",
        subtotal: "12.00",
        total: "12.00",
        paymentMethod: "PREPAID",
        countryCode: "BG",
        tags: [],
        placedAt: new Date(Date.now() - 3600_000),
      },
    });
    await recordInitialStatus(tx, {
      accountId,
      orderId: o.id,
      status: "IMPORTED",
      actor: { kind: "system" },
      source: "e2e.seed",
    });
    // As the check would store it: the stock fallback picked the other company's warehouse of the line.
    await tx.orderCheck.create({
      data: { accountId, orderId: o.id, connectionId: euB.id, routing: { via: "stock_fallback" } },
    });
  });
  return { email: owner.user.email, password: LINES_PASSWORD, totp: owner.totpSecret };
}

/** Stands in for the worker during e2e (no worker runs there): processes waiting master catalogue runs. */
export async function runQueuedCatalogueRuns() {
  const { processCatalogueRun } = await import("@/server/lines/catalogue");
  const runs = await systemDb().masterCatalogueRun.findMany({
    where: { status: { in: ["QUEUED", "RUNNING"] } },
    select: { id: true, accountId: true },
    orderBy: { createdAt: "asc" },
  });
  for (const r of runs) await processCatalogueRun(r.accountId, r.id);
  return runs.length;
}
