// Synthetic data for „Блокирани в склад“ (tests/e2e/stuck-warehouse.spec.ts). Its own group and OWNER, so other specs'
// counts stay unchanged. No vendor call, no email leaves the machine (the CRM only assembles the texts).
//   #S-8101  sent 30 h ago, "Awaiting pickup"        → level 1
//   #S-8102  sent 80 h ago, "Information received"   → level 3 (decision)
//   one held unit of SYN-SC-2 at the warehouse (a no-stock cancel of an earlier shipment) → "SKU под наблюдение"
import { bootstrapOwner } from "@/server/auth/users";
import { systemDb, withAccountTransaction } from "@/server/db/client";
import { recordInitialStatus } from "@/server/pipeline";
import { syncWarehouseCases } from "@/server/warehouse-cases/cases";
import { recordSkuIncident } from "@/server/warehouse-cases/sku";

export const STUCK_PASSWORD = "e2e-stuck-password-not-secret";
export const STUCK_GROUP = "Тест група Блокирани";

export async function seedStuck() {
  const owner = await bootstrapOwner({
    email: "e2e-stuck@example.com",
    name: "E2E Блокирани",
    accountName: STUCK_GROUP,
    password: STUCK_PASSWORD,
  });
  const sys = systemDb();
  const accountId = owner.account.id;
  const company = await sys.company.findFirstOrThrow({ where: { accountId } });
  await sys.companyEscalationSettings.create({
    data: {
      accountId,
      companyId: company.id,
      senderEmail: "synthetic-company@example.com",
      warehouseTo: ["warehouse-support@example.com"],
      warehouseCc: [],
      escalationTo: ["warehouse-manager@example.com"],
      // Calendar hours: the spec must not depend on the weekday it runs on.
      workDaysOnly: false,
      discountPercent: 15,
    },
  });
  const store = await sys.store.create({
    data: {
      accountId,
      companyId: company.id,
      domain: "e2e-stuck.myshopify.com",
      code: "SC",
      name: "Блокирани магазин",
      currency: "EUR",
    },
  });
  const conn = await sys.fulfillmentConnection.create({
    data: {
      accountId,
      companyId: company.id,
      type: "EUSHIPMENTS",
      name: "euShipments Склад",
      vendorIds: { companyId: 5301 },
      liveMode: "DRY_RUN",
    },
  });
  const products = await Promise.all(
    [1, 2].map((i) =>
      sys.product.create({
        data: {
          accountId,
          sku: `SYN-SC-${i}`,
          name: `Синтетичен парфюм ${i}`,
          weightGrams: 300,
          lengthMm: 90,
          widthMm: 60,
          heightMm: 120,
        },
      }),
    ),
  );
  const seeded: [string, number, string, number][] = [
    ["#S-8101", 30, "Awaiting pickup", 0],
    ["#S-8102", 80, "Information received", 1],
    ["#S-8100", 200, "Deleted", 1],
  ];
  for (const [i, [number, hours, raw, p]] of seeded.entries()) {
    const product = products[p]!;
    const address = {
      name: `Синтетичен Клиент ${i + 1}`,
      address1: `Примерна улица ${i + 30}`,
      city: "Sofia",
      zip: "1000",
      province: null,
      countryCode: "BG",
      phone: `0888 900 81${i}`,
    };
    const cancelled = raw === "Deleted";
    await withAccountTransaction(accountId, async (tx) => {
      const o = await tx.order.create({
        data: {
          accountId,
          companyId: company.id,
          source: "SHOPIFY",
          storeId: store.id,
          number,
          status: cancelled ? "BLOCKED" : "ACCEPTED",
          customerName: address.name,
          email: `stuck-buyer-${i + 1}@example.com`,
          phone: address.phone,
          shippingAddressOriginal: address,
          shippingAddress: address,
          currency: "EUR",
          subtotal: "40.00",
          total: "40.00",
          paymentMethod: "COD",
          codAmount: "40.00",
          codLocalAmount: "40.00",
          codLocalCurrency: "EUR",
          countryCode: "BG",
          placedAt: new Date(Date.now() - (hours + 1) * 3600_000),
          lines: {
            create: [
              {
                productId: product.id,
                sku: product.sku,
                title: product.name,
                quantity: 1,
                unitPrice: "40.00",
              },
            ],
          },
        },
        include: { lines: true },
      });
      await recordInitialStatus(tx, {
        accountId,
        orderId: o.id,
        status: o.status,
        actor: { kind: "system" },
        source: "e2e.seed",
      });
      const f = await tx.fulfillment.create({
        data: {
          accountId,
          orderId: o.id,
          connectionId: conn.id,
          externalId: `SC${number.replace("#", "")}`,
          status: cancelled ? "CANCELLED" : "ACCEPTED",
          rawStatus: raw,
          trackingNumbers: [`SYNAWB${8100 + i}`],
          submittedAt: new Date(Date.now() - hours * 3600_000),
          lines: { create: [{ orderLineId: o.lines[0]!.id, quantity: 1 }] },
        },
      });
      if (cancelled) await recordSkuIncident(tx, { accountId, fulfillmentId: f.id });
    });
  }
  await syncWarehouseCases(accountId);
  return { email: owner.user.email, password: STUCK_PASSWORD, totp: owner.totpSecret };
}
