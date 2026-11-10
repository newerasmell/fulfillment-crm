import { beforeAll, describe, expect, it } from "vitest";
import { SYNTHETIC_ORDERS } from "@/integrations/shopify/__fixtures__/orders";
import type { ShopifyOrder } from "@/integrations/shopify/orders";
import { ForbiddenError } from "@/server/auth/rbac";
import { euTestGroup } from "@/server/eushipments/test-fixtures";
import { checkOrder } from "@/server/checks";
import { listOrders } from "@/server/orders";
import { importShopifyOrder } from "@/server/shopify/orders";
import { saveLineGuard } from "@/server/stock/guard";
import { approveQtyHold, rejectQtyHold } from "./qty-hold";

// Synthetic data only; nothing calls Shopify or a warehouse.

describe("Противосаботаж: quantity hold (database)", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  let n = 0;
  const base = SYNTHETIC_ORDERS[1]!;
  const order = (qty: number): ShopifyOrder => {
    const i = ++n;
    return {
      ...base,
      id: `gid://shopify/Order/88${i}`,
      name: `#Q-${i}`,
      lineItems: {
        ...base.lineItems,
        nodes: base.lineItems.nodes.map((l) => ({ ...l, quantity: qty, currentQuantity: qty })),
      },
    };
  };
  const imp = async (o: ShopifyOrder) => {
    const store = await g.db.store.findUniqueOrThrow({ where: { id: g.store.id } });
    return (await importShopifyOrder(g.accountId, store, o)).orderId;
  };
  const status = async (id: string) => (await g.db.order.findUniqueOrThrow({ where: { id } })).status;

  beforeAll(async () => {
    g = await euTestGroup("qty-hold");
    const line = await g.db.productLine.create({ data: { accountId: g.accountId, name: "Textiles" } });
    await g.db.company.update({ where: { id: g.company.id }, data: { lineId: line.id } });
    await expect(
      saveLineGuard(
        { ...g.owner, role: "OPERATOR" },
        { lineId: line.id, enabled: true, maxPerProduct: 5, maxPerOrder: null },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      saveLineGuard(g.owner, { lineId: line.id, enabled: true, maxPerProduct: null, maxPerOrder: null }),
    ).rejects.toThrow();
    await saveLineGuard(g.owner, { lineId: line.id, enabled: true, maxPerProduct: "5", maxPerOrder: null });
  });

  it("below the limit enters as usual; above it is held, listed under Подозрителни, with a task", async () => {
    const small = await imp(order(5));
    expect(await status(small)).toBe("IMPORTED");
    const big = await imp(order(6));
    expect(await status(big)).toBe("QTY_HOLD");
    const ctx = { accountId: g.accountId, companyScope: null, activeCompanyId: null };
    expect((await listOrders(ctx, { tab: "qtyHold" })).rows.map((r) => r.id)).toContain(big);
    expect(await g.db.alert.count({ where: { kind: "order_qty_hold", entityId: big, status: "OPEN" } })).toBe(
      1,
    );
  });

  it("approve → review (reserves from now on), task resolved; reject → cancelled; only orders.review", async () => {
    const a = await imp(order(9));
    const b = await imp(order(9));
    await expect(approveQtyHold({ ...g.owner, role: "VIEWER" }, a)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await approveQtyHold(g.owner, a)).status).toBe("IMPORTED");
    expect(["IMPORTED", "CHECKING", "NEEDS_REVIEW", "READY"]).toContain(await status(a));
    expect(
      await g.db.alert.count({ where: { kind: "order_qty_hold", entityId: a, status: "RESOLVED" } }),
    ).toBe(1);
    await expect(approveQtyHold(g.owner, a)).rejects.toMatchObject({ code: "not_qty_hold" });
    await rejectQtyHold(g.owner, b, "fake order");
    expect(await status(b)).toBe("CANCELLED");
    const other = await euTestGroup("qty-hold-other");
    await expect(rejectQtyHold(other.owner, a)).rejects.toMatchObject({ code: "not_found" });
  });

  it("cancelled in Shopify while held: cancelled here, its task resolved; a held order is never checked", async () => {
    const o = order(7);
    const id = await imp(o);
    await expect(checkOrder(g.accountId, id, { actor: { kind: "system" } })).rejects.toMatchObject({
      code: "qty_hold",
    });
    await imp({
      ...o,
      cancelledAt: new Date().toISOString(),
      updatedAt: new Date(Date.parse(o.updatedAt) + 60_000).toISOString(),
    });
    expect(await status(id)).toBe("CANCELLED");
    expect(await g.db.alert.count({ where: { kind: "order_qty_hold", entityId: id, status: "OPEN" } })).toBe(
      0,
    );
  });

  it("turned off: nothing is held", async () => {
    const line = await g.db.company.findUniqueOrThrow({
      where: { id: g.company.id },
      select: { lineId: true },
    });
    await saveLineGuard(g.owner, {
      lineId: line.lineId!,
      enabled: false,
      maxPerProduct: 5,
      maxPerOrder: null,
    });
    expect(await status(await imp(order(50)))).toBe("IMPORTED");
  });
});
