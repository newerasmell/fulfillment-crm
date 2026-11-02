import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/auth/rbac";
import { checkOrder } from "@/server/checks";
import { euTestGroup, euTestOrder } from "@/server/eushipments/test-fixtures";
import { transitionOrder } from "@/server/pipeline";
import {
  canaryView,
  confirmFulfillCanary,
  createFulfillBatch,
  fulfillOrder,
  getFulfillBatch,
  retryFulfillItem,
  runFulfillBatch,
} from "./index";

// Synthetic data only; nothing is sent to a vendor (the outbox sender is not run here).

describe("Fulfill (P4-06)", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  let n = 5000;

  const setMode = (liveMode: "READ_ONLY" | "DRY_RUN" | "CANARY" | "LIVE") =>
    g.db.fulfillmentConnection.update({ where: { id: g.connection.id }, data: { liveMode } });

  /** A checked, approved order ready to be fulfilled at the test euShipments connection. */
  async function approved() {
    const { order, product } = await euTestOrder(g, { number: `#${++n}` });
    const vp = await g.db.vendorProduct.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        productId: product.id,
        vendorId: `REF-${n}`,
      },
    });
    await g.db.stockLevel.create({
      data: {
        accountId: g.accountId,
        vendorProductId: vp.id,
        physical: 100,
        free: 100,
        sellable: 100,
        snapshotAt: new Date(),
        source: "POLL",
      },
    });
    await g.db.order.update({ where: { id: order.id }, data: { status: "IMPORTED" } });
    const c = await checkOrder(g.accountId, order.id, {
      actor: { kind: "system" },
      connectionId: g.connection.id,
    });
    expect(c.findings.filter((f) => f.severity === "hard")).toEqual([]);
    await transitionOrder(g.accountId, {
      orderId: order.id,
      to: "APPROVED",
      cause: "approve",
      actor: { kind: "user", userId: g.owner.userId },
      meta: { connectionId: g.connection.id },
    });
    return order;
  }
  const counts = async (orderId: string) => ({
    fulfillments: await g.db.fulfillment.count({ where: { orderId } }),
    requests: await g.db.outboundRequest.count({ where: { fulfillment: { orderId } } }),
  });

  beforeAll(async () => {
    g = await euTestGroup("fulfill");
    await g.db.countrySetting.create({ data: { accountId: g.accountId, country: "BG", currency: "EUR" } });
  });

  it("queues an approved order through the vendor queue function and the pipeline", async () => {
    const order = await approved();
    const r = await fulfillOrder(g.owner, order.id);
    expect(r).toMatchObject({ status: "QUEUED", connectionId: g.connection.id, liveMode: "LIVE" });
    expect(await counts(order.id)).toEqual({ fulfillments: 1, requests: 1 });
    const o = await g.db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(o.status).toBe("QUEUED");
    const ev = await g.db.orderEvent.findFirst({ where: { orderId: order.id, cause: "queue" } });
    expect(ev).toMatchObject({ fromStatus: "APPROVED", toStatus: "QUEUED", userId: g.owner.userId });
    // A second click later: nothing new.
    expect(await fulfillOrder(g.owner, order.id)).toMatchObject({
      status: "SKIPPED",
      code: "already_submitted",
    });
    expect(await counts(order.id)).toEqual({ fulfillments: 1, requests: 1 });
  });

  it("double click / two operators at the same moment: one shipment, one request", async () => {
    const order = await approved();
    const other = { ...g.owner, userId: g.owner.userId, role: "OPERATOR" as const };
    const rs = await Promise.all([
      fulfillOrder(g.owner, order.id),
      fulfillOrder(other, order.id),
      fulfillOrder(g.owner, order.id),
    ]);
    expect(rs.filter((r) => r.status === "QUEUED")).toHaveLength(1);
    expect(rs.filter((r) => r.status !== "QUEUED").every((r) => r.status === "SKIPPED")).toBe(true);
    expect(await counts(order.id)).toEqual({ fulfillments: 1, requests: 1 });
  });

  it("bulk and single on the same order at once: one shipment, one request", async () => {
    const order = await approved();
    const batch = await createFulfillBatch(g.owner, [order.id]);
    const [single] = await Promise.all([fulfillOrder(g.owner, order.id), runFulfillBatch(g.owner, batch.id)]);
    const view = await getFulfillBatch(g.owner, batch.id);
    const statuses = [single.status, view.rows[0]!.status].sort();
    expect(statuses).toEqual(["QUEUED", "SKIPPED"]);
    expect(await counts(order.id)).toEqual({ fulfillments: 1, requests: 1 });
  });

  it("refuses what is not approved, stale, read-only or out of scope — nothing is written", async () => {
    const { order: raw } = await euTestOrder(g, { number: `#${++n}` });
    await g.db.order.update({ where: { id: raw.id }, data: { status: "NEEDS_REVIEW" } });
    expect(await fulfillOrder(g.owner, raw.id)).toMatchObject({
      status: "SKIPPED",
      code: "status_needs_review",
    });

    const stale = await approved();
    await g.db.order.update({ where: { id: stale.id }, data: { customerName: "Changed After Approval" } });
    expect(await fulfillOrder(g.owner, stale.id)).toMatchObject({ status: "BLOCKED", code: "check_stale" });

    const ro = await approved();
    await setMode("READ_ONLY");
    try {
      expect(await fulfillOrder(g.owner, ro.id)).toMatchObject({
        status: "BLOCKED",
        code: "connection_read_only",
      });
    } finally {
      await setMode("LIVE");
    }
    expect(
      await fulfillOrder({ ...g.owner, role: "OPERATOR", companyScope: ["another-company"] }, ro.id),
    ).toMatchObject({ status: "FAILED", code: "not_found" });
    await expect(fulfillOrder({ ...g.owner, role: "VIEWER" }, ro.id)).rejects.toBeInstanceOf(ForbiddenError);
    for (const o of [raw, stale, ro]) expect(await counts(o.id)).toEqual({ fulfillments: 0, requests: 0 });
    expect((await g.db.order.findUniqueOrThrow({ where: { id: ro.id } })).status).toBe("APPROVED");
  });

  it("blocks on a hard finding found at send time (stock gone since approval)", async () => {
    const order = await approved();
    await g.db.stockLevel.updateMany({
      where: {
        vendorProduct: {
          productId: {
            in: (await g.db.orderLine.findMany({ where: { orderId: order.id } })).map((l) => l.productId!),
          },
        },
      },
      data: { free: 0, sellable: 0 },
    });
    const r = await fulfillOrder(g.owner, order.id);
    expect(r.status).toBe("BLOCKED");
    expect(r.findings.length).toBeGreaterThan(0);
    expect(await counts(order.id)).toEqual({ fulfillments: 0, requests: 0 });
  });

  it("CANARY: the dialog shows the exact payload and the remaining cap; one click confirms one request", async () => {
    const order = await approved();
    await setMode("CANARY");
    try {
      const r = await fulfillOrder(g.owner, order.id);
      expect(r).toMatchObject({ status: "QUEUED", liveMode: "CANARY" });
      const view = await canaryView(g.owner, r.requestId!);
      const stored = await g.db.outboundRequest.findUniqueOrThrow({ where: { id: r.requestId! } });
      expect(view).toMatchObject({ cap: 10, usedToday: 0, remaining: 10, confirmed: false });
      expect(view.payload).toEqual(stored.payload);
      await expect(canaryView({ ...g.owner, role: "VIEWER" }, r.requestId!)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await confirmFulfillCanary(g.owner, r.requestId!);
      const after = await g.db.outboundRequest.findUniqueOrThrow({ where: { id: r.requestId! } });
      expect(after).toMatchObject({ status: "PENDING", confirmedById: g.owner.userId });
      expect(after.confirmedAt).not.toBeNull();
      await expect(confirmFulfillCanary(g.owner, r.requestId!)).rejects.toMatchObject({
        code: "not_confirmable",
      });
    } finally {
      await setMode("LIVE");
    }
    // Outside CANARY a confirmation is refused.
    const other = await approved();
    const r2 = await fulfillOrder(g.owner, other.id);
    await expect(confirmFulfillCanary(g.owner, r2.requestId!)).rejects.toMatchObject({
      code: "not_confirmable",
    });
  });

  it("a batch keeps a visible result per order and can be resumed / retried", async () => {
    const a = await approved();
    const b = await approved();
    const { order: c } = await euTestOrder(g, { number: `#${++n}` });
    await g.db.order.update({ where: { id: c.id }, data: { status: "ON_HOLD" } });
    const batch = await createFulfillBatch(g.owner, [a.id, b.id, c.id, a.id, "missing-order"]);
    expect(batch.total).toBe(3);
    expect(await runFulfillBatch(g.owner, batch.id, 2)).toEqual({ waiting: 1 });
    expect(await runFulfillBatch(g.owner, batch.id, 5)).toEqual({ waiting: 0 });
    const view = await getFulfillBatch(g.owner, batch.id);
    expect(view.rows.map((r) => r.status)).toEqual(["QUEUED", "QUEUED", "SKIPPED"]);
    expect(view.rows[0]!.request).toMatchObject({ status: "PENDING" });
    expect(view.finishedAt).not.toBeNull();
    expect(view.counts).toEqual({ QUEUED: 2, SKIPPED: 1 });
    // A SKIPPED item is final; a blocked one can be retried once the block is gone.
    await expect(retryFulfillItem(g.owner, view.rows[2]!.id)).rejects.toMatchObject({
      code: "not_retryable",
    });
    // Restricted members see only their companies' rows.
    const restricted = await getFulfillBatch({ ...g.owner, role: "OPERATOR", companyScope: ["x"] }, batch.id);
    expect(restricted.rows).toEqual([]);
    await expect(createFulfillBatch(g.owner, [])).rejects.toMatchObject({ code: "empty_selection" });
  });
});
