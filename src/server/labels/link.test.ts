import { describe, expect, it } from "vitest";
import { systemDb } from "@/server/db/client";
import { euTestGroup, euTestOrder } from "@/server/eushipments/test-fixtures";
import { attachedTo, findShopifyOrdersToLink, linkManualToShopifyOrder } from "./link";

// „Прикачи към поръчка от Shopify“ (owner request 2026-11-24). Synthetic data only.
describe("attach a manual shipment to its Shopify order", () => {
  async function setup(label: string) {
    const g = await euTestGroup(label);
    const db = systemDb();
    // The Shopify order: refused at a warehouse (its shipment cancelled), a task open.
    const { order, product } = await euTestOrder(g, { number: `1-SYN${Math.floor(Math.random() * 1e6)}` });
    await db.order.update({ where: { id: order.id }, data: { status: "BLOCKED" } });
    const refused = await db.fulfillment.create({
      data: {
        accountId: g.accountId,
        orderId: order.id,
        connectionId: g.connection.id,
        externalId: `X-${order.number}`,
        status: "CANCELLED",
      },
    });
    // The warehouse's own task on that old shipment (cancelled in ZOE): answered by the attached shipment too.
    const zoe = await db.alert.create({
      data: {
        accountId: g.accountId,
        kind: "fhb_order_cancelled_in_zoe",
        isTask: true,
        severity: "CRITICAL",
        title: "Synthetic ZOE",
        entityType: "Fulfillment",
        entityId: refused.id,
      },
    });
    const task = await db.alert.create({
      data: {
        accountId: g.accountId,
        kind: "order_blocked",
        isTask: true,
        severity: "CRITICAL",
        title: "Synthetic",
        entityType: "Order",
        entityId: order.id,
      },
    });
    // A task the attached shipment does not answer (a Shopify write-back to check): stays open.
    const unrelated = await db.alert.create({
      data: {
        accountId: g.accountId,
        kind: "shopify_payment_check",
        isTask: true,
        severity: "WARNING",
        title: "Synthetic other",
        entityType: "Order",
        entityId: order.id,
      },
    });
    // The manual order sent instead: same product, 2 units, accepted at the warehouse.
    const manual = await db.order.create({
      data: {
        accountId: g.accountId,
        companyId: g.company.id,
        source: "MANUAL",
        number: `M${Math.floor(Math.random() * 1e6)}`,
        status: "ACCEPTED",
        currency: "EUR",
        subtotal: "40.00",
        total: "40.00",
        paymentMethod: "COD",
        codAmount: "40.00",
        placedAt: new Date(),
        tags: [`shopify:${order.number}`],
        lines: {
          create: [
            { productId: product.id, sku: product.sku, title: "Sample", quantity: 2, unitPrice: "20.00" },
          ],
        },
      },
      include: { lines: true },
    });
    const f = await db.fulfillment.create({
      data: {
        accountId: g.accountId,
        orderId: manual.id,
        connectionId: g.connection.id,
        externalId: `M-${manual.number}`,
        status: "SHIPPED",
        trackingNumbers: ["SYN-AWB-1"],
      },
    });
    await db.fulfillmentLine.create({
      data: { accountId: g.accountId, fulfillmentId: f.id, orderLineId: manual.lines[0]!.id, quantity: 2 },
    });
    await db.manualShipment.create({
      data: {
        accountId: g.accountId,
        orderId: manual.id,
        kind: "WAREHOUSE",
        connectionId: g.connection.id,
        fulfillmentId: f.id,
      },
    });
    return { g, db, order, manual, f, task, unrelated, product, zoe };
  }

  it("the Shopify order takes over the shipment, follows it, its tasks close; the manual record is closed", async () => {
    const { g, db, order, manual, f, task, unrelated, zoe } = await setup("link");
    expect(
      (await findShopifyOrdersToLink(g.owner, manual.id, order.number.slice(2))).map((o) => o.id),
    ).toEqual([order.id]);
    const r = await linkManualToShopifyOrder(g.owner, { manualOrderId: manual.id, shopifyOrderId: order.id });
    expect(r).toMatchObject({ orderId: order.id, closedTasks: 2 });
    const shipment = await db.fulfillment.findUniqueOrThrow({
      where: { id: f.id },
      include: { lines: { include: { orderLine: true } } },
    });
    expect(shipment.orderId).toBe(order.id);
    expect(shipment.lines.map((l) => [l.orderLine.orderId, l.quantity])).toEqual([[order.id, 2]]);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("SHIPPED");
    expect((await db.order.findUniqueOrThrow({ where: { id: manual.id } })).status).toBe("CANCELLED");
    expect((await db.alert.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("RESOLVED");
    expect((await db.alert.findUniqueOrThrow({ where: { id: unrelated.id } })).status).not.toBe("RESOLVED");
    expect((await db.alert.findUniqueOrThrow({ where: { id: zoe.id } })).status).toBe("RESOLVED");
    expect(await attachedTo(g.accountId, manual.id)).toMatchObject({ id: order.id, number: order.number });
    expect(
      await db.auditLog.count({
        where: { accountId: g.accountId, action: "manual.link", entityId: order.id },
      }),
    ).toBe(1);
    // Again: refused (the manual no longer has its shipment; the order has a live one now).
    await expect(
      linkManualToShopifyOrder(g.owner, { manualOrderId: manual.id, shopifyOrderId: order.id }),
    ).rejects.toMatchObject({ code: "manual_not_shipped" });
  });

  it("never two shipments; lines must match; scope and role apply", async () => {
    const { g, db, order, manual, product } = await setup("link-guards");
    const args = { manualOrderId: manual.id, shopifyOrderId: order.id };
    // A live shipment of the Shopify order: refused.
    const live = await db.fulfillment.create({
      data: {
        accountId: g.accountId,
        orderId: order.id,
        connectionId: g.connection.id,
        externalId: `L-${order.number}`,
        status: "ACCEPTED",
      },
    });
    await expect(linkManualToShopifyOrder(g.owner, args)).rejects.toMatchObject({
      code: "order_has_shipment",
    });
    await db.fulfillment.update({ where: { id: live.id }, data: { status: "CANCELLED" } });
    // A warehouse write on its way: refused.
    const req = await db.outboundRequest.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        operation: "eushipments.createOrder",
        idempotencyKey: `k-${order.id}`,
        payload: {},
        status: "UNCERTAIN",
        fulfillmentId: live.id,
      },
    });
    await expect(linkManualToShopifyOrder(g.owner, args)).rejects.toMatchObject({
      code: "order_write_pending",
    });
    await db.outboundRequest.update({ where: { id: req.id }, data: { status: "FAILED" } });
    // The order has only 1 unit of the product: the 2 shipped do not fit.
    await db.orderLine.updateMany({
      where: { orderId: order.id, productId: product.id },
      data: { quantity: 1 },
    });
    await expect(linkManualToShopifyOrder(g.owner, args)).rejects.toMatchObject({
      code: "lines_do_not_match",
    });
    await db.orderLine.updateMany({
      where: { orderId: order.id, productId: product.id },
      data: { quantity: 2 },
    });
    // The order has 3 units: the 2 shipped do not cover it (a partial parcel is not attached).
    await db.orderLine.updateMany({
      where: { orderId: order.id, productId: product.id },
      data: { quantity: 3 },
    });
    await expect(linkManualToShopifyOrder(g.owner, args)).rejects.toMatchObject({
      code: "lines_do_not_match",
    });
    await db.orderLine.updateMany({
      where: { orderId: order.id, productId: product.id },
      data: { quantity: 2 },
    });
    // A write of the manual shipment itself on its way (a cancel / void): refused.
    const mf = await db.fulfillment.findFirstOrThrow({ where: { orderId: manual.id } });
    const own = await db.outboundRequest.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        operation: "eushipments.deleteOrder",
        idempotencyKey: `d-${mf.id}`,
        payload: {},
        status: "PENDING",
        fulfillmentId: mf.id,
      },
    });
    await expect(linkManualToShopifyOrder(g.owner, args)).rejects.toMatchObject({
      code: "manual_write_pending",
    });
    await db.outboundRequest.update({ where: { id: own.id }, data: { status: "FAILED" } });
    // Cash on delivery differs: refused unless acknowledged; then attached with a task to check it.
    await db.order.update({ where: { id: order.id }, data: { codAmount: "55.00", codLocalAmount: "55.00" } });
    await expect(linkManualToShopifyOrder(g.owner, args)).rejects.toMatchObject({ code: "cod_differs" });
    await db.order.update({ where: { id: order.id }, data: { codAmount: "40.00", codLocalAmount: "40.00" } });
    // Cancelled in Shopify: refused.
    await db.order.update({ where: { id: order.id }, data: { cancelledAt: new Date() } });
    await expect(linkManualToShopifyOrder(g.owner, args)).rejects.toMatchObject({
      code: "order_cancelled_in_shopify",
    });
    await db.order.update({ where: { id: order.id }, data: { cancelledAt: null } });
    // A member of this group whose companies do not include it.
    const elsewhere = await db.company.create({ data: { accountId: g.accountId, name: "Elsewhere 2" } });
    await expect(
      linkManualToShopifyOrder({ ...g.owner, role: "OPERATOR", companyScope: [elsewhere.id] }, args),
    ).rejects.toMatchObject({ code: "not_found" });
    // Role, another group, another company.
    await expect(linkManualToShopifyOrder({ ...g.owner, role: "WAREHOUSE" }, args)).rejects.toThrow();
    const stranger = await euTestGroup("link-guards-other");
    await expect(linkManualToShopifyOrder(stranger.owner, args)).rejects.toMatchObject({ code: "not_found" });
    const other = await db.company.create({ data: { accountId: g.accountId, name: "Elsewhere" } });
    await db.order.update({ where: { id: order.id }, data: { companyId: other.id } });
    await expect(linkManualToShopifyOrder(g.owner, args)).rejects.toMatchObject({ code: "other_company" });
    // Nothing moved.
    expect((await db.order.findUniqueOrThrow({ where: { id: manual.id } })).status).toBe("ACCEPTED");
  });

  it("different COD attached on purpose opens a task; a parcel in trouble is not attached", async () => {
    const { g, db, order, manual, f } = await setup("link-cod");
    await db.order.update({ where: { id: order.id }, data: { codAmount: "55.00", codLocalAmount: "55.00" } });
    await linkManualToShopifyOrder(g.owner, {
      manualOrderId: manual.id,
      shopifyOrderId: order.id,
      acknowledgeCod: true,
    });
    expect(
      await db.alert.count({
        where: { entityId: order.id, kind: "manual_link_cod_differs", status: { not: "RESOLVED" } },
      }),
    ).toBe(1);
    expect((await db.fulfillment.findUniqueOrThrow({ where: { id: f.id } })).orderId).toBe(order.id);

    const other = await setup("link-exception");
    await db.fulfillment.update({ where: { id: other.f.id }, data: { status: "EXCEPTION" } });
    await expect(
      linkManualToShopifyOrder(other.g.owner, {
        manualOrderId: other.manual.id,
        shopifyOrderId: other.order.id,
      }),
    ).rejects.toMatchObject({ code: "manual_not_shipped" });
  });
});
