import { bootstrapOwner } from "@/server/auth/users";
import { accountDb, systemDb } from "@/server/db/client";
import { saveCredential } from "@/server/security/credentials";
import type { ScopedActor } from "@/server/stores";

/** Test-only setup (synthetic data): a group with an euShipments connection, a store and an order. */
export async function euTestGroup(label: string) {
  const r = await bootstrapOwner({
    email: `eu-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    name: "O",
    accountName: `euShipments test ${label}`,
    password: "correct horse battery staple",
  });
  const accountId = r.account.id;
  const owner: ScopedActor = { userId: r.user.id, accountId, role: "OWNER", companyScope: null };
  const company = await systemDb().company.findFirstOrThrow({ where: { accountId } });
  const db = accountDb(accountId);
  const cred = await saveCredential(db, accountId, { label: "eu", secret: "test-token-not-real-0001" });
  const connection = await db.fulfillmentConnection.create({
    data: {
      accountId,
      companyId: company.id,
      type: "EUSHIPMENTS",
      name: "euShipments test",
      credentialId: cred.id,
      vendorIds: { companyId: 333 },
      liveMode: "LIVE",
    },
  });
  const store = await db.store.create({
    data: {
      accountId,
      companyId: company.id,
      domain: `${label}-${Date.now()}.example`,
      code: "TST",
      name: "S",
      currency: "EUR",
    },
  });
  return { accountId, owner, company, connection, store, db };
}

export async function euTestOrder(
  g: Awaited<ReturnType<typeof euTestGroup>>,
  over: { number?: string; country?: string; phone?: string; cod?: string | null } = {},
) {
  const country = over.country ?? "BG";
  const product = await g.db.product.create({
    data: {
      accountId: g.accountId,
      sku: `SKU-${Math.random().toString(36).slice(2, 8)}`,
      name: "Sample Perfume 50ml",
      weightGrams: 400,
      lengthMm: 100,
      widthMm: 60,
      heightMm: 150,
    },
  });
  await g.db.productEan.create({
    data: { accountId: g.accountId, productId: product.id, ean: "0000000000017" },
  });
  const order = await g.db.order.create({
    data: {
      accountId: g.accountId,
      companyId: g.company.id,
      source: "SHOPIFY",
      storeId: g.store.id,
      number: over.number ?? "#1001",
      status: "APPROVED",
      customerName: "Test Buyer",
      phone: over.phone ?? "0888 123 456",
      shippingAddress: {
        name: "Test Buyer",
        address1: "Example Street 12",
        address2: "bl. 1 ent. A",
        city: "Sofia",
        zip: "1000",
        province: null,
        countryCode: country,
        phone: over.phone ?? "0888 123 456",
      },
      currency: "EUR",
      subtotal: "40.00",
      total: "40.00",
      paymentMethod: over.cod === null ? "PREPAID" : "COD",
      codAmount: over.cod === null ? null : (over.cod ?? "40.00"),
      codLocalAmount: over.cod === null ? null : (over.cod ?? "40.00"),
      codLocalCurrency: over.cod === null ? null : "EUR",
      countryCode: country,
      placedAt: new Date("2026-11-01T10:00:00Z"),
      lines: {
        create: [
          { productId: product.id, sku: product.sku, title: "Sample", quantity: 2, unitPrice: "20.00" },
        ],
      },
    },
  });
  return { order, product };
}
