// Synthetic data for the warehouse choice / reroute e2e (tests/e2e/override.spec.ts, P4-09). Its own group and OWNER,
// so other specs' counts stay unchanged. No vendor or Shopify call: two euShipments connections in LIVE (nothing is
// sent — no worker runs during e2e; tools/e2e-override-worker.ts plays the sender with a mocked vendor), one product
// line with two companies, and one connection of another line that must never be offered.
//   #P-9001  checked, not approved, routed to "euShipments Основен" → chosen "euShipments Сестра" by hand
//   #P-9002  already sent to "euShipments Основен" (Information received) → rerouted after a confirmed cancel
import { bootstrapOwner } from "@/server/auth/users";
import { checkOrder } from "@/server/checks";
import { systemDb, withAccountTransaction } from "@/server/db/client";
import { fulfillOrder } from "@/server/fulfill";
import { decideOrder } from "@/server/review";
import { recordInitialStatus, transitionOrder } from "@/server/pipeline";

export const OVERRIDE_PASSWORD = "e2e-override-password-not-secret";
export const OVERRIDE_GROUP = "Тест група Пренасочване";

export async function seedOverride() {
  const owner = await bootstrapOwner({
    email: "e2e-override@example.com",
    name: "E2E Пренасочване",
    accountName: OVERRIDE_GROUP,
    password: OVERRIDE_PASSWORD,
  });
  const sys = systemDb();
  const accountId = owner.account.id;
  const actor = { userId: owner.user.id, accountId, role: "OWNER" as const, companyScope: null };
  const main = await sys.company.findFirstOrThrow({ where: { accountId } });
  const line = await sys.productLine.create({ data: { accountId, name: "Козметика" } });
  const otherLine = await sys.productLine.create({ data: { accountId, name: "Текстил" } });
  await sys.company.update({ where: { id: main.id }, data: { name: "Основна фирма", lineId: line.id } });
  const sister = await sys.company.create({ data: { accountId, name: "Сестринска фирма", lineId: line.id } });
  const textile = await sys.company.create({
    data: { accountId, name: "Текстилна фирма", lineId: otherLine.id },
  });
  const store = await sys.store.create({
    data: {
      accountId,
      companyId: main.id,
      domain: "e2e-override.myshopify.com",
      code: "PR",
      name: "Пренасочване магазин",
      currency: "EUR",
    },
  });
  await sys.countrySetting.create({ data: { accountId, country: "BG", currency: "EUR" } });
  const conn = (name: string, companyId: string, vendorCompanyId: number) =>
    sys.fulfillmentConnection.create({
      data: {
        accountId,
        companyId,
        type: "EUSHIPMENTS",
        name,
        vendorIds: { companyId: vendorCompanyId },
        liveMode: "LIVE",
      },
    });
  const a = await conn("euShipments Основен", main.id, 5101);
  const b = await conn("euShipments Сестра", sister.id, 5102);
  const c = await conn("euShipments Текстил", textile.id, 5103);
  const product = await sys.product.create({
    data: {
      accountId,
      sku: "SYN-PR-1",
      name: "Синтетичен крем 50 мл",
      weightGrams: 300,
      lengthMm: 90,
      widthMm: 60,
      heightMm: 120,
      lineId: line.id,
    },
  });
  for (const [cn, qty] of [
    [a, 3],
    [b, 40],
    [c, 40],
  ] as const) {
    const vp = await sys.vendorProduct.create({
      data: {
        accountId,
        connectionId: cn.id,
        productId: product.id,
        vendorId: `SYN-PR-REF-${cn.name.length}`,
      },
    });
    await sys.stockLevel.create({
      data: {
        accountId,
        vendorProductId: vp.id,
        physical: qty,
        free: qty,
        sellable: qty,
        snapshotAt: new Date(),
        source: "POLL",
      },
    });
  }

  const ids: Record<string, string> = {};
  for (const [i, number] of ["#P-9001", "#P-9002"].entries()) {
    const address = {
      name: `Синтетичен Клиент ${i + 1}`,
      address1: `Примерна улица ${i + 10}`,
      address2: "бл. 1",
      city: "Sofia",
      zip: "1000",
      province: null,
      countryCode: "BG",
      phone: `0888 900 90${i}`,
    };
    ids[number] = await withAccountTransaction(accountId, async (tx) => {
      const o = await tx.order.create({
        data: {
          accountId,
          companyId: main.id,
          source: "SHOPIFY",
          storeId: store.id,
          number,
          status: "IMPORTED",
          customerName: address.name,
          email: `override-buyer-${i + 1}@example.com`,
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
                quantity: 2,
                unitPrice: "20.00",
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
    await checkOrder(accountId, ids[number]!, { actor: { kind: "system" } });
  }

  // #P-9002: approved, queued and "sent" (as if the sender had sent it and euShipments answered).
  const sent = ids["#P-9002"]!;
  await decideOrder(actor, {
    orderId: sent,
    decision: "approve",
    reasonCode: null,
    reasonText: null,
    openedAt: null,
  });
  const r = await fulfillOrder(actor, sent);
  if (r.status !== "QUEUED") throw new Error(`seed: #P-9002 not queued (${r.status} ${r.code})`);
  await sys.outboundRequest.update({
    where: { id: r.requestId! },
    data: { status: "SENT", sentAt: new Date() },
  });
  await sys.fulfillment.updateMany({
    where: { orderId: sent },
    data: { status: "ACCEPTED", rawStatus: "Information received", submittedAt: new Date() },
  });
  await transitionOrder(accountId, {
    orderId: sent,
    to: "ACCEPTED",
    cause: "vendor",
    actor: { kind: "system" },
    source: "e2e.seed",
  });

  return { email: owner.user.email, password: OVERRIDE_PASSWORD, totp: owner.totpSecret };
}

/**
 * Plays the worker for the override group (e2e only): sends its queued cancels through the real outbox sender with
 * a MOCKED euShipments transport (nothing leaves the machine), then lets the reroute sweep confirm them by a mocked
 * read-back.
 */
export async function runOverrideWorker() {
  const { processOutbound } = await import("@/server/outbox/outbox");
  const { sweepReroutes } = await import("@/server/override");
  const account = await systemDb().account.findFirstOrThrow({ where: { name: OVERRIDE_GROUP } });
  const mock = () => ({
    send: async () => ({ outcome: "accepted" as const, response: { mocked: true } }),
    readBack: async () => ({ found: true, response: { mocked: true, deleted: true } }),
  });
  const pending = await systemDb().outboundRequest.findMany({
    where: { accountId: account.id, status: "PENDING", operation: "eushipments.deleteOrder" },
    select: { id: true },
  });
  for (const p of pending) await processOutbound(p.id, mock);
  return sweepReroutes(mock);
}
