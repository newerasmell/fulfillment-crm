// Synthetic data for the store edit / archive / delete e2e (tests/e2e/stores-edit.spec.ts). A separate group with
// its own OWNER, so other specs' counts never change. No Shopify call: stores are rows, never connected.
//   Фирма Магазини А — "Магазин с поръчки" (MP, one order: code + domain locked), "Магазин за архив" (MA, one
//                      order not yet sent), "Празен магазин" (PM, nothing: can be deleted)
//   Фирма Магазини Б — the company a store can be moved to
import { bootstrapOwner } from "@/server/auth/users";
import { systemDb } from "@/server/db/client";

export const STORES_EDIT_PASSWORD = "e2e-stores-edit-password-not-secret";

export async function seedStoresEdit() {
  const owner = await bootstrapOwner({
    email: "e2e-stores-edit@example.com",
    name: "E2E Stores",
    accountName: "Тест група Магазини",
    password: STORES_EDIT_PASSWORD,
  });
  const sys = systemDb();
  const accountId = owner.account.id;
  const first = await sys.company.findFirstOrThrow({ where: { accountId } });
  const coA = await sys.company.update({ where: { id: first.id }, data: { name: "Фирма Магазини А" } });
  await sys.company.create({ data: { accountId, name: "Фирма Магазини Б" } });
  const store = (domain: string, code: string, name: string) =>
    sys.store.create({
      data: { accountId, companyId: coA.id, domain, code, name, currency: "EUR", countries: ["BG"] },
    });
  const order = (storeId: string, number: string, status: "DELIVERED" | "READY", tags: string[] = []) =>
    sys.order.create({
      data: {
        accountId,
        storeId,
        companyId: coA.id,
        source: "SHOPIFY",
        number,
        currency: "EUR",
        subtotal: 10,
        total: 10,
        paymentMethod: "COD",
        placedAt: new Date(),
        status,
        tags,
        raw: { tags },
        customerName: "Тест Купувач",
      },
    });
  const withOrders = await store("e2e-se-orders.myshopify.com", "MP", "Магазин с поръчки");
  await order(withOrders.id, "#MP-1", "DELIVERED");
  // "Само поръчки с таг": one open order without the tag, one with it (another case).
  await order(withOrders.id, "#MP-2", "READY");
  await order(withOrders.id, "#MP-3", "READY", ["CONFIRMED"]);
  const toArchive = await store("e2e-se-archive.myshopify.com", "MA", "Магазин за архив");
  await order(toArchive.id, "#MA-1", "READY");
  await store("e2e-se-empty.myshopify.com", "PM", "Празен магазин");
  return { email: owner.user.email, password: STORES_EDIT_PASSWORD, totp: owner.totpSecret };
}
