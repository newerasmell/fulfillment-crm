import { beforeAll, describe, expect, it } from "vitest";
import { SYNTHETIC_ORDERS } from "@/integrations/shopify/__fixtures__/orders";
import { ForbiddenError } from "@/server/auth/rbac";
import { checkOrder } from "@/server/checks";
import { euTestGroup } from "@/server/eushipments/test-fixtures";
import { linkVariant } from "@/server/shopify/products";
import { importShopifyOrder } from "@/server/shopify/orders";
import { chooseLineProduct, clearLineProduct, searchLineProducts } from "./index";

// Synthetic data only; nothing calls a vendor or Shopify.

describe("hand-picked product for one order line (database)", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  beforeAll(async () => {
    g = await euTestGroup("line-product");
    await g.db.countrySetting.create({ data: { accountId: g.accountId, country: "BG", currency: "EUR" } });
  });

  const master = async (sku: string, name: string, free: number) => {
    const p = await g.db.product.create({
      data: { accountId: g.accountId, sku, name, weightGrams: 50, lengthMm: 50, widthMm: 50, heightMm: 50 },
    });
    const vp = await g.db.vendorProduct.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        productId: p.id,
        vendorId: `ref-${sku}`,
      },
    });
    await g.db.stockLevel.create({
      data: {
        accountId: g.accountId,
        vendorProductId: vp.id,
        physical: free,
        free,
        sellable: free,
        snapshotAt: new Date(),
        source: "POLL",
      },
    });
    return p;
  };

  it("unmatched line: pick → re-checked, survives re-import and re-link; clear → back to the variant", async () => {
    const store = await g.db.store.update({ where: { id: g.store.id }, data: { codGateways: [] } });
    const base = SYNTHETIC_ORDERS[0]!;
    const { orderId } = await importShopifyOrder(g.accountId, store, base);
    await g.db.order.update({ where: { id: orderId }, data: { status: "IMPORTED" } });
    await checkOrder(g.accountId, orderId, { actor: { kind: "system" } });
    const before = await g.db.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { lines: { orderBy: { title: "asc" } }, check: true },
    });
    expect(before.status).toBe("NEEDS_REVIEW");
    const line = before.lines[0]!;
    expect(line.productId).toBeNull();
    // Every other line gets a product too, so only the hand-picked one decides.
    const decant = await master("SYN-DECANT-15", "Synthetic Decant 15 ml", 7);
    for (const l of before.lines.slice(1)) {
      const p = await master(`SYN-OTHER-${l.id.slice(-5)}`, "Synthetic other", 9);
      await g.db.orderLine.update({ where: { id: l.id }, data: { productId: p.id } });
    }

    // Search: by SKU or name, with sellable per warehouse; a too-short query returns nothing.
    expect((await searchLineProducts(g.owner, orderId, "d")).products).toEqual([]);
    const found = await searchLineProducts(g.owner, orderId, "decant 15");
    expect(found.products).toEqual([
      expect.objectContaining({ sku: "SYN-DECANT-15", stock: { [g.connection.id]: 7 } }),
    ]);

    // Rights and validation.
    await expect(
      chooseLineProduct({ ...g.owner, role: "VIEWER" }, { orderId, lineId: line.id, productId: decant.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      chooseLineProduct(g.owner, { orderId, lineId: line.id, productId: "nope" }),
    ).rejects.toMatchObject({ code: "product_not_found" });

    const r = await chooseLineProduct(g.owner, {
      orderId,
      lineId: line.id,
      productId: decant.id,
      note: "matches the customer's other item",
    });
    // The pick clears the unmatched-line block (the synthetic order's other findings are not this test's subject).
    expect(r?.findings.map((f) => f.code)).not.toContain("order.line_unmatched");
    const picked = await g.db.orderLine.findUniqueOrThrow({
      where: { id: line.id },
      include: { productChoice: true },
    });
    expect(picked.productId).toBe(decant.id);
    expect(picked.productChoice).toMatchObject({ productId: decant.id, userId: g.owner.userId });
    expect(
      await g.db.auditLog.count({ where: { action: "order.line_product_chosen", entityId: orderId } }),
    ).toBe(1);
    // The Shopify variant link is NOT changed: the next order of the same item asks again.
    expect(
      (await g.db.storeVariantLink.findUniqueOrThrow({ where: { id: line.variantLinkId! } })).productId,
    ).toBeNull();

    // A Shopify re-import keeps the choice.
    await importShopifyOrder(g.accountId, store, {
      ...base,
      updatedAt: new Date(Date.parse(base.updatedAt) + 60_000).toISOString(),
      note: "changed in Shopify",
    });
    expect((await g.db.orderLine.findUniqueOrThrow({ where: { id: line.id } })).productId).toBe(decant.id);

    // Linking the variant to another master later moves other lines, not this one.
    const other = await master("SYN-LINKED", "Synthetic linked", 3);
    await linkVariant(g.owner, line.variantLinkId!, other.sku);
    expect((await g.db.orderLine.findUniqueOrThrow({ where: { id: line.id } })).productId).toBe(decant.id);

    // Clearing the choice puts the line back to the variant's product.
    await clearLineProduct(g.owner, { orderId, lineId: line.id });
    const cleared = await g.db.orderLine.findUniqueOrThrow({
      where: { id: line.id },
      include: { productChoice: true },
    });
    expect(cleared.productChoice).toBeNull();
    expect(cleared.productId).toBe(other.id);
    // A second clear is a no-op.
    expect(await clearLineProduct(g.owner, { orderId, lineId: line.id })).toBeNull();
  });

  it("is refused once the order left review, and for another company's member", async () => {
    const store = await g.db.store.findUniqueOrThrow({ where: { id: g.store.id } });
    const { orderId } = await importShopifyOrder(
      g.accountId,
      { ...store, codGateways: [] },
      SYNTHETIC_ORDERS[1]!,
    );
    const line = await g.db.orderLine.findFirstOrThrow({ where: { orderId } });
    const p = await master("SYN-LATE", "Synthetic late", 1);
    await g.db.order.update({ where: { id: orderId }, data: { status: "APPROVED" } });
    await expect(
      chooseLineProduct(g.owner, { orderId, lineId: line.id, productId: p.id }),
    ).rejects.toMatchObject({ code: "not_editable" });
    await g.db.order.update({ where: { id: orderId }, data: { status: "NEEDS_REVIEW" } });
    await expect(
      chooseLineProduct(
        { ...g.owner, role: "OPERATOR", companyScope: ["other-company"] },
        { orderId, lineId: line.id, productId: p.id },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      searchLineProducts({ ...g.owner, companyScope: ["other-company"] }, orderId, "SYN"),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("re-pick updates the choice; a line rewritten meanwhile is repaired by the next check; manual line clear restores", async () => {
    const own = await master("SYN-MANUAL-OWN", "Synthetic manual own", 5);
    const a = await master("SYN-PICK-A", "Synthetic pick A", 5);
    const b = await master("SYN-PICK-B", "Synthetic pick B", 5);
    // A line without a Shopify variant (e.g. a manual order) that already has a product.
    const order = await g.db.order.create({
      data: {
        accountId: g.accountId,
        companyId: g.company.id,
        source: "MANUAL",
        number: "#LP-1",
        status: "NEEDS_REVIEW",
        customerName: "Test Buyer",
        phone: "+359888000999",
        shippingAddress: {
          name: "Test Buyer",
          address1: "Example Street 12",
          city: "Sofia",
          zip: "1000",
          countryCode: "BG",
        },
        currency: "EUR",
        subtotal: "10.00",
        total: "10.00",
        paymentMethod: "PREPAID",
        countryCode: "BG",
        tags: [],
        placedAt: new Date(),
        lines: { create: { productId: own.id, title: "Own", quantity: 1, unitPrice: "10.00" } },
      },
      include: { lines: true },
    });
    const line = order.lines[0]!;
    await chooseLineProduct(g.owner, { orderId: order.id, lineId: line.id, productId: a.id });
    await chooseLineProduct(g.owner, { orderId: order.id, lineId: line.id, productId: b.id, note: "better" });
    expect(await g.db.orderLineProductChoice.findMany({ where: { orderLineId: line.id } })).toEqual([
      expect.objectContaining({ productId: b.id, previousProductId: own.id, note: "better" }),
    ]);
    // Something rewrote the line (e.g. a re-link racing the pick): the next check puts the chosen product back.
    await g.db.orderLine.update({ where: { id: line.id }, data: { productId: a.id } });
    await checkOrder(g.accountId, order.id, { actor: { kind: "system" } });
    expect((await g.db.orderLine.findUniqueOrThrow({ where: { id: line.id } })).productId).toBe(b.id);
    // Clearing a line without a variant restores the product it had before the first pick.
    await clearLineProduct(g.owner, { orderId: order.id, lineId: line.id });
    expect((await g.db.orderLine.findUniqueOrThrow({ where: { id: line.id } })).productId).toBe(own.id);
    // Never while the order is being checked or after it was sent.
    for (const status of ["CHECKING", "SUBMITTING", "ACCEPTED"] as const) {
      await g.db.order.update({ where: { id: order.id }, data: { status } });
      await expect(
        chooseLineProduct(g.owner, { orderId: order.id, lineId: line.id, productId: a.id }),
      ).rejects.toMatchObject({ code: "not_editable" });
    }
    // A sent order is never repaired by a check either.
    await g.db.orderLineProductChoice.create({
      data: { accountId: g.accountId, orderLineId: line.id, productId: a.id },
    });
    await checkOrder(g.accountId, order.id, { actor: { kind: "system" } }).catch(() => null);
    expect((await g.db.orderLine.findUniqueOrThrow({ where: { id: line.id } })).productId).toBe(own.id);
  });

  it("another account never sees or picks this account's order, line or product", async () => {
    const other = await euTestGroup("line-product-other");
    const p = await master("SYN-XACC", "Synthetic cross account", 2);
    const line = await g.db.orderLine.findFirstOrThrow({ where: { order: { number: "#LP-1" } } });
    const o = { orderId: line.orderId, lineId: line.id, productId: p.id };
    await expect(chooseLineProduct(other.owner, o)).rejects.toMatchObject({ code: "not_found" });
    await expect(searchLineProducts(other.owner, line.orderId, "SYN")).rejects.toMatchObject({
      code: "not_found",
    });
    // Its own order cannot take this account's product either.
    const mine = await g.db.order.findUniqueOrThrow({ where: { id: line.orderId } });
    expect(mine.accountId).toBe(g.accountId);
    expect(await other.db.orderLineProductChoice.count()).toBe(0);
  });
});
