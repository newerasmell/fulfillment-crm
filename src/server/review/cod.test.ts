import { beforeAll, describe, expect, it } from "vitest";
import { SYNTHETIC_ORDERS } from "@/integrations/shopify/__fixtures__/orders";
import { ForbiddenError } from "@/server/auth/rbac";
import { euTestGroup } from "@/server/eushipments/test-fixtures";
import { importShopifyOrder } from "@/server/shopify/orders";
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
    await expect(setOrderCod(g.owner, { orderId, amount: "-1" })).rejects.toThrow();

    await setOrderCod(g.owner, { orderId, amount: "60.50", note: "product swapped" });
    let o = await g.db.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { codOverride: true, check: true },
    });
    expect(o.paymentMethod).toBe("COD");
    expect(o.codAmount?.toString()).toBe("60.5");
    expect(o.codOverride).toMatchObject({
      note: "product swapped",
      previous: { paymentMethod: "COD", codAmount: "45" },
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

    // 0 = prepaid: no "money still owed" block, because a person decided it.
    await setOrderCod(g.owner, { orderId, amount: 0 });
    o = await g.db.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { codOverride: true, check: true },
    });
    expect(o.paymentMethod).toBe("PREPAID");
    expect(o.codAmount).toBeNull();
    expect((o.check?.findings as { code: string }[]).map((f) => f.code)).not.toContain(
      "order.payment_unclear",
    );

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
});
