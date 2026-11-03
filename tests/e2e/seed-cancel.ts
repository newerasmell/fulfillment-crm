// Synthetic data for "Откажи в склада" / "Откажи поръчката" (tests/e2e/cancel-at-warehouse.spec.ts). Its own group and
// OWNER, so other specs' counts stay unchanged. No vendor or Shopify call: one euShipments connection in DRY_RUN (the
// sender only records) — no worker runs during e2e; tools/e2e-cancel-worker.ts plays the sender and then the vendor's
// confirmed delete (the real euShipments orderDeleted effect, nothing leaves the machine).
//   #K-9101  sent, "Information received" → cancelled at the warehouse from the CRM → BLOCKED → Изпрати отново
//   #K-9102  BLOCKED, its shipment already cancelled → Откажи поръчката
//   #K-9103  sent, already "Packed" → cannot be cancelled from here
import { bootstrapOwner } from "@/server/auth/users";
import { systemDb, withAccountTransaction } from "@/server/db/client";
import { recordInitialStatus } from "@/server/pipeline";

export const CANCEL_PASSWORD = "e2e-cancel-password-not-secret";
export const CANCEL_GROUP = "Тест група Отказ в склада";

export async function seedCancel() {
  const owner = await bootstrapOwner({
    email: "e2e-cancel@example.com",
    name: "E2E Отказ",
    accountName: CANCEL_GROUP,
    password: CANCEL_PASSWORD,
  });
  const sys = systemDb();
  const accountId = owner.account.id;
  const company = await sys.company.findFirstOrThrow({ where: { accountId } });
  const store = await sys.store.create({
    data: {
      accountId,
      companyId: company.id,
      domain: "e2e-cancel.myshopify.com",
      code: "KC",
      name: "Отказ магазин",
      currency: "EUR",
    },
  });
  await sys.countrySetting.create({ data: { accountId, country: "BG", currency: "EUR" } });
  const conn = await sys.fulfillmentConnection.create({
    data: {
      accountId,
      companyId: company.id,
      type: "EUSHIPMENTS",
      name: "euShipments Склад",
      vendorIds: { companyId: 5201 },
      liveMode: "DRY_RUN",
    },
  });
  const product = await sys.product.create({
    data: {
      accountId,
      sku: "SYN-KC-1",
      name: "Синтетичен лосион 100 мл",
      weightGrams: 300,
      lengthMm: 90,
      widthMm: 60,
      heightMm: 120,
    },
  });
  const seeded: [string, "ACCEPTED" | "BLOCKED", "ACCEPTED" | "CANCELLED", string][] = [
    ["#K-9101", "ACCEPTED", "ACCEPTED", "Information received"],
    ["#K-9102", "BLOCKED", "CANCELLED", "Deleted"],
    ["#K-9103", "ACCEPTED", "ACCEPTED", "Packed"],
  ];
  for (const [i, [number, status, shipStatus, raw]] of seeded.entries()) {
    const address = {
      name: `Синтетичен Клиент ${i + 1}`,
      address1: `Примерна улица ${i + 20}`,
      address2: "бл. 2",
      city: "Sofia",
      zip: "1000",
      province: null,
      countryCode: "BG",
      phone: `0888 900 91${i}`,
    };
    await withAccountTransaction(accountId, async (tx) => {
      const o = await tx.order.create({
        data: {
          accountId,
          companyId: company.id,
          source: "SHOPIFY",
          storeId: store.id,
          number,
          status,
          customerName: address.name,
          email: `cancel-buyer-${i + 1}@example.com`,
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
          placedAt: new Date(Date.now() - (i + 1) * 3600_000),
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
      });
      await recordInitialStatus(tx, {
        accountId,
        orderId: o.id,
        status,
        actor: { kind: "system" },
        source: "e2e.seed",
      });
      await tx.fulfillment.create({
        data: {
          accountId,
          orderId: o.id,
          connectionId: conn.id,
          externalId: `KC${number.replace("#", "")}`,
          status: shipStatus,
          rawStatus: raw,
          submittedAt: new Date(),
        },
      });
    });
  }
  return { email: owner.user.email, password: CANCEL_PASSWORD, totp: owner.totpSecret };
}

/**
 * Plays the worker for the cancel group (e2e only).
 *   "send":    the REAL outbox sender processes the group's pending cancels (DRY_RUN: only recorded, no transport);
 *   "confirm": simulates euShipments confirming each recorded cancel — the request is marked SENT and the REAL
 *              euShipments orderDeleted effect runs (shipment CANCELLED, order BLOCKED). Nothing leaves the machine.
 */
export async function runCancelWorker(step: "send" | "confirm") {
  const { processOutbound } = await import("@/server/outbox/outbox");
  const { euEffects } = await import("@/server/eushipments/effects");
  const sys = systemDb();
  const account = await sys.account.findFirstOrThrow({ where: { name: CANCEL_GROUP } });
  // DRY_RUN never calls send; if it ever did, nothing would leave the machine.
  const never = () => ({
    send: async (): Promise<never> => {
      throw new Error("e2e: no vendor transport");
    },
  });
  if (step === "send") {
    const pending = await sys.outboundRequest.findMany({
      where: { accountId: account.id, status: "PENDING", operation: "eushipments.deleteOrder" },
      select: { id: true },
    });
    const out: string[] = [];
    for (const p of pending) out.push(await processOutbound(p.id, never));
    return out;
  }
  const recorded = await sys.outboundRequest.findMany({
    where: { accountId: account.id, status: "DRY_RUN_RECORDED", operation: "eushipments.deleteOrder" },
  });
  for (const r of recorded) {
    await sys.outboundRequest.update({ where: { id: r.id }, data: { status: "SENT", sentAt: new Date() } });
    const ctx = (r.payload as { ctx?: Record<string, unknown> }).ctx ?? {};
    await euEffects(async () => account.id, r.connectionId).orderDeleted(ctx);
  }
  return recorded.map((r) => r.id);
}
