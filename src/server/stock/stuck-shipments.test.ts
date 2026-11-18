import { beforeAll, describe, expect, it } from "vitest";
import { systemDb } from "@/server/db/client";
import { euTestGroup, euTestOrder } from "@/server/eushipments/test-fixtures";
import { NO_STOCK_TASK, shipmentsWithoutStock, sweepShipmentsWithoutStock } from "./stuck-shipments";

// Accepted shipments the warehouse cannot fill (owner request 2026-11-18). Synthetic data only.
describe("shipments without stock at their warehouse", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  let fhb: { id: string };
  let second: { id: string };
  let n = 0;
  const db = () => systemDb();
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

  beforeAll(async () => {
    g = await euTestGroup("nostock");
    const conn = (name: string) =>
      db().fulfillmentConnection.create({
        data: { accountId: g.accountId, companyId: g.company.id, type: "FHB_V3", name, liveMode: "LIVE" },
      });
    fhb = await conn("FHB warehouse");
    second = await conn("Second warehouse");
  });

  async function level(connectionId: string, productId: string, physical: number, at = new Date()) {
    const vp = await db().vendorProduct.upsert({
      where: { connectionId_vendorId: { connectionId, vendorId: `ref-${productId}` } },
      create: { accountId: g.accountId, connectionId, productId, vendorId: `ref-${productId}`, raw: {} },
      update: {},
    });
    await db().stockLevel.upsert({
      where: { vendorProductId: vp.id },
      create: {
        accountId: g.accountId,
        vendorProductId: vp.id,
        physical,
        free: physical,
        sellable: physical,
        snapshotAt: at,
        source: "POLL",
      },
      update: { physical, free: physical, sellable: physical, snapshotAt: at },
    });
  }

  async function accepted(submittedAt = hoursAgo(8), connectionId?: string) {
    const { order, product } = await euTestOrder(g, { number: `#NS${++n}` });
    await db().order.update({ where: { id: order.id }, data: { status: "ACCEPTED" } });
    await db().fulfillment.create({
      data: {
        accountId: g.accountId,
        orderId: order.id,
        connectionId: connectionId ?? fhb.id,
        externalId: `NS-${n}`,
        status: "ACCEPTED",
        submittedAt,
      },
    });
    return { order, product };
  }
  const tasks = (orderId: string, status?: "RESOLVED") =>
    db().alert.findMany({
      where: {
        entityId: orderId,
        kind: NO_STOCK_TASK,
        ...(status ? { status } : { status: { not: "RESOLVED" } }),
      },
    });

  it("a fresh snapshot with not one unit: a task naming the warehouse that has the order; closes when stock is back", async () => {
    const { order, product } = await accepted();
    await level(fhb.id, product.id, 0);
    await level(second.id, product.id, 5);
    await sweepShipmentsWithoutStock();
    const [t] = await tasks(order.id);
    expect(t?.title).toMatch(/пренасочете към Second warehouse/);
    // Swept again: still one task.
    await sweepShipmentsWithoutStock();
    expect(await tasks(order.id)).toHaveLength(1);

    await level(fhb.id, product.id, 2);
    await sweepShipmentsWithoutStock();
    expect(await tasks(order.id)).toHaveLength(0);
    expect(await tasks(order.id, "RESOLVED")).toHaveLength(1);
  });

  it("nowhere in stock: the task says to cancel with „Няма наличност“", async () => {
    const { order, product } = await accepted();
    await level(fhb.id, product.id, 0);
    await level(second.id, product.id, 0);
    await sweepShipmentsWithoutStock();
    expect((await tasks(order.id))[0]?.title).toMatch(/откажете в склада с причина „Няма наличност“/);
  });

  it("euShipments (its number already leaves out accepted orders): only after a day without movement, as 'check the cabinet'", async () => {
    const day = await accepted(hoursAgo(30), g.connection.id);
    await level(g.connection.id, day.product.id, 0);
    await sweepShipmentsWithoutStock();
    expect((await tasks(day.order.id))[0]?.title).toMatch(/над ден без движение.*проверете в кабинета/);
  });

  it("left alone: just accepted, a stale snapshot, a unit still there, an order already moved on", async () => {
    const fresh = await accepted(new Date());
    await level(fhb.id, fresh.product.id, 0);
    const stale = await accepted();
    await level(fhb.id, stale.product.id, 0, hoursAgo(24 * 30));
    const has = await accepted();
    await level(fhb.id, has.product.id, 1);
    const quietNot = await accepted();
    await level(fhb.id, quietNot.product.id, 0);
    // A status of the shipment came in just now: it is moving, not stuck.
    const qf = await db().fulfillment.findFirstOrThrow({ where: { orderId: quietNot.order.id } });
    await db().fulfillmentEvent.create({
      data: {
        accountId: g.accountId,
        fulfillmentId: qf.id,
        occurredAt: new Date(),
        source: "fhb:test",
        rawStatus: "sent",
      },
    });
    const eu = await accepted(hoursAgo(8), g.connection.id); // euShipments under its 24h rule: not yet
    await level(g.connection.id, eu.product.id, 0);
    const shipped = await accepted();
    await level(fhb.id, shipped.product.id, 0);
    await db().order.update({ where: { id: shipped.order.id }, data: { status: "SHIPPED" } });
    const found = (await shipmentsWithoutStock(g.accountId)).map((f) => f.orderId);
    for (const o of [fresh, stale, has, quietNot, eu, shipped]) expect(found).not.toContain(o.order.id);
  });
});
