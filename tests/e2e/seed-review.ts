// Synthetic data for the review e2e (tests/e2e/review.spec.ts). A separate group with its own OWNER, so these
// orders never change the counts other specs assert. No vendor or Shopify call: an FHB connection in DRY_RUN
// with one product and stock, a store, and three orders checked by the real validator engine.
//   #R-7001  BG, prepaid, no postal code (Shopify sent none) → hard finding, fixed in the address editor
//   #R-7002  BG, prepaid, valid                              → held with a reason
//   #R-7003  BG, prepaid, valid                              → blocked with a reason
import { bootstrapOwner } from "@/server/auth/users";
import { checkOrder } from "@/server/checks";
import { systemDb, withAccountTransaction } from "@/server/db/client";
import { createFhbConnection } from "@/server/fhb/connection";
import { recordInitialStatus } from "@/server/pipeline";
import { createStore } from "@/server/stores";

export const REVIEW_PASSWORD = "e2e-review-password-not-secret";

export async function seedReview() {
  const owner = await bootstrapOwner({
    email: "e2e-review@example.com",
    name: "E2E Reviewer",
    accountName: "Тест група Преглед",
    password: REVIEW_PASSWORD,
  });
  const sys = systemDb();
  const accountId = owner.account.id;
  const actor = { userId: owner.user.id, accountId, role: "OWNER" as const, companyScope: null };
  const company = await sys.company.findFirstOrThrow({ where: { accountId } });
  const store = await createStore(actor, {
    companyId: company.id,
    name: "Преглед магазин",
    domain: "e2e-review.myshopify.com",
    code: "RV",
    currency: "EUR",
    countries: ["BG"],
    clientId: "e2e-review-client-id",
    clientSecret: "e2e-review-client-secret-not-real",
  });
  const c = await createFhbConnection(actor, {
    companyId: company.id,
    name: "FHB Преглед",
    appId: "e2e-review-app-id",
    secret: "e2e-review-fhb-secret-not-real",
    skuPrefix: "R",
  });
  await sys.fulfillmentConnection.update({ where: { id: c.id }, data: { liveMode: "DRY_RUN" } });
  const product = await sys.product.create({
    data: { accountId, sku: "SYN-RV-EDP-50", name: "Синтетичен парфюм за преглед 50 мл" },
  });
  const vp = await sys.vendorProduct.create({
    data: {
      accountId,
      connectionId: c.id,
      productId: product.id,
      vendorId: "RSYN-RV-EDP-50",
      vendorCode: "RTM0901",
      lastSyncAt: new Date(),
      raw: { id: "RSYN-RV-EDP-50", name: "Synthetic review EDP 50", type: "single" },
    },
  });
  await sys.stockLevel.create({
    data: {
      accountId,
      vendorProductId: vp.id,
      physical: 7,
      free: 6,
      sellable: 6,
      snapshotAt: new Date(),
      source: "PUSH",
    },
  });

  for (const [i, number] of ["#R-7001", "#R-7002", "#R-7003"].entries()) {
    const address = {
      name: `Review Buyer ${i + 1}`,
      company: null,
      address1: `Synthetic Street ${i + 1}`,
      address2: null,
      city: "Sofia",
      province: null,
      provinceCode: null,
      zip: i === 0 ? null : "1000",
      country: "Bulgaria",
      countryCode: "BG",
      phone: `+35988800070${i + 1}`,
    };
    const id = await withAccountTransaction(accountId, async (tx) => {
      const o = await tx.order.create({
        data: {
          accountId,
          companyId: company.id,
          source: "SHOPIFY",
          storeId: store.id,
          shopifyOrderGid: `gid://shopify/Order/97000${i + 1}`,
          number,
          status: "IMPORTED",
          customerName: address.name,
          email: `review-buyer-${i + 1}@example.com`,
          phone: address.phone,
          shippingAddressOriginal: { ...address, countryCodeV2: "BG" },
          shippingAddress: address,
          currency: "EUR",
          subtotal: "30.00",
          total: "30.00",
          paymentMethod: "PREPAID",
          countryCode: "BG",
          tags: [],
          placedAt: new Date(Date.now() - (i + 1) * 3600_000),
          lines: {
            create: [
              {
                productId: product.id,
                sku: product.sku,
                title: product.name,
                quantity: 1,
                unitPrice: "30.00",
              },
            ],
          },
        },
      });
      await recordInitialStatus(tx, {
        accountId,
        orderId: o.id,
        status: "IMPORTED",
        actor: { kind: "system" },
        source: "e2e.seed",
      });
      return o.id;
    });
    await checkOrder(accountId, id, { actor: { kind: "system" } });
  }
  return { email: owner.user.email, password: REVIEW_PASSWORD, totp: owner.totpSecret };
}
