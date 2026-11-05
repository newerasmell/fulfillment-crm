import { beforeAll, describe, expect, it } from "vitest";
import { SYNTHETIC_ORDERS } from "@/integrations/shopify/__fixtures__/orders";
import { ForbiddenError } from "@/server/auth/rbac";
import { euTestGroup } from "@/server/eushipments/test-fixtures";
import { importShopifyOrder } from "@/server/shopify/orders";
import { reclassifyStorePayments } from "@/server/shopify/payment";
import { clearOrderCod, setOrderCod } from "./index";

// Synthetic data only; nothing calls Shopify or a warehouse.

describe("manual COD for one order (database)", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  beforeAll(async () => {
    g = await euTestGroup("cod-edit");
    await g.db.countrySetting.create({ data: { accountId: g.accountId, country: "BG", currency: "EUR" } });
  });

  it("set → re-checked, kept by a Shopify re-import; 0 = prepaid; restore → Shopify's payment again", async () => {
    const store = await g.db.store.findUniqueOrThrow({ where: { id: g.store.id } });
    const base = SYNTHETIC_ORDERS[0]!; // COD gateway, 45.00 owed
    const { orderId } = await importShopifyOrder(g.accountId, store, base);
    await g.db.order.update({ where: { id: orderId }, data: { status: "NEEDS_REVIEW" } });
    expect((await g.db.order.findUniqueOrThrow({ where: { id: orderId } })).codAmount?.toString()).toBe("45");

    await expect(
      setOrderCod({ ...g.owner, role: "VIEWER" }, { orderId, amount: "60" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Only a plain decimal: an empty field is never read as 0 (that would silently drop the COD).
    for (const bad of ["-1", "", " ", "0x10", "1e2", "12.345", "abc"])
      await expect(setOrderCod(g.owner, { orderId, amount: bad })).rejects.toThrow();
    await expect(setOrderCod(g.owner, { orderId, amount: null as never })).rejects.toThrow();

    await setOrderCod(g.owner, { orderId, amount: "60.50", note: "product swapped" });
    let o = await g.db.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { codOverride: true, check: true },
    });
    expect(o.paymentMethod).toBe("COD");
    expect(o.codAmount?.toString()).toBe("60.5");
    expect(o.codOverride).toMatchObject({
      note: "product swapped",
      previous: { paymentMethod: "COD", codAmount: "45", shopifyOwed: 45 },
    });
    expect(await g.db.auditLog.count({ where: { action: "order.cod_changed", entityId: orderId } })).toBe(1);

    // A Shopify update keeps the person's COD.
    await importShopifyOrder(g.accountId, store, {
      ...base,
      updatedAt: new Date(Date.parse(base.updatedAt) + 60_000).toISOString(),
    });
    o = await g.db.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { codOverride: true, check: true },
    });
    expect(o.codAmount?.toString()).toBe("60.5");

    // 0 = prepaid while Shopify shows money owed: only with a reason; then no "money owed" block, a soft note.
    await expect(setOrderCod(g.owner, { orderId, amount: 0 })).rejects.toMatchObject({
      code: "cod_zero_needs_reason",
    });
    await setOrderCod(g.owner, { orderId, amount: "0", note: "paid in cash at the office" });
    o = await g.db.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { codOverride: true, check: true },
    });
    expect(o.paymentMethod).toBe("PREPAID");
    expect(o.codAmount).toBeNull();
    const codes = (o.check?.findings as { code: string }[]).map((f) => f.code);
    expect(codes).not.toContain("order.payment_unclear");
    expect(codes).toContain("order.cod_manual_differs");

    // Restore: Shopify's payment (COD 45.00) again.
    await clearOrderCod(g.owner, orderId);
    o = await g.db.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { codOverride: true, check: true },
    });
    expect(o.codOverride).toBeNull();
    expect(o.paymentMethod).toBe("COD");
    expect(o.codAmount?.toString()).toBe("45");
    expect(await clearOrderCod(g.owner, orderId)).toBeNull();
  });

  it("refused once the order left review, and for another company's member", async () => {
    const store = await g.db.store.findUniqueOrThrow({ where: { id: g.store.id } });
    const { orderId } = await importShopifyOrder(g.accountId, store, SYNTHETIC_ORDERS[1]!);
    for (const status of ["APPROVED", "QUEUED", "ACCEPTED"] as const) {
      await g.db.order.update({ where: { id: orderId }, data: { status } });
      await expect(setOrderCod(g.owner, { orderId, amount: "10" })).rejects.toMatchObject({
        code: "not_editable",
      });
    }
    await g.db.order.update({ where: { id: orderId }, data: { status: "NEEDS_REVIEW" } });
    await expect(
      setOrderCod(
        { ...g.owner, role: "OPERATOR", companyScope: ["other-company"] },
        { orderId, amount: "10" },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    const other = await euTestGroup("cod-edit-other");
    await expect(setOrderCod(other.owner, { orderId, amount: "10" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("a COD in the order currency to a country with another local currency is refused", async () => {
    const store = await g.db.store.findUniqueOrThrow({ where: { id: g.store.id } });
    const { orderId } = await importShopifyOrder(g.accountId, store, SYNTHETIC_ORDERS[2]!);
    await g.db.order.update({
      where: { id: orderId },
      data: { status: "NEEDS_REVIEW", countryCode: "RO", shippingAddress: { countryCode: "RO" } },
    });
    await expect(setOrderCod(g.owner, { orderId, amount: "10" })).rejects.toMatchObject({
      code: "cod_currency_mismatch",
    });
  });

  it("a manual COD is never re-classified by a COD-list change", async () => {
    const store = await g.db.store.findUniqueOrThrow({ where: { id: g.store.id } });
    const { orderId } = await importShopifyOrder(g.accountId, store, {
      ...SYNTHETIC_ORDERS[0]!,
      id: "gid://shopify/Order/990077",
      name: "#C-9977",
    });
    await g.db.order.update({ where: { id: orderId }, data: { status: "NEEDS_REVIEW" } });
    await setOrderCod(g.owner, { orderId, amount: "12.00" });
    await g.db.store.update({ where: { id: g.store.id }, data: { codGateways: [] } });
    expect(await reclassifyStorePayments(g.accountId, g.store.id, g.owner.userId)).not.toContain(orderId);
    expect((await g.db.order.findUniqueOrThrow({ where: { id: orderId } })).codAmount?.toString()).toBe("12");
  });
});
