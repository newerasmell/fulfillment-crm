import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/auth/rbac";
import { systemDb } from "@/server/db/client";
import { euTestGroup, euTestOrder } from "@/server/eushipments/test-fixtures";
import { recheckOrderTasks } from "./order-tasks";

// "Провери задачите" (owner request 2026-11-13). Synthetic data only.
describe("re-check an order's tasks", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  let other: Awaited<ReturnType<typeof euTestGroup>>;
  let n = 0;
  const db = () => systemDb();
  const ago = (ms: number) => new Date(Date.now() - ms);

  beforeAll(async () => {
    g = await euTestGroup("tasks");
    other = await euTestGroup("tasks-other");
  });

  const shipment = (
    orderId: string,
    status: "ACCEPTED" | "CANCELLED" | "SUBMIT_FAILED",
    createdAt = new Date(),
    rawStatus: string | null = null,
  ) =>
    db().fulfillment.create({
      data: {
        accountId: g.accountId,
        orderId,
        connectionId: g.connection.id,
        externalId: `TK-${++n}`,
        status,
        rawStatus,
        createdAt,
      },
    });
  const task = (orderId: string, kind: string, accountId = g.accountId, createdAt = new Date()) =>
    db().alert.create({
      data: {
        createdAt,
        accountId,
        kind,
        severity: "WARNING",
        isTask: true,
        title: kind,
        entityType: "Order",
        entityId: orderId,
      },
    });
  /** What the CRM records when the warehouse refuses a cancel / a re-route's cancel. */
  const refusedCancel = (orderId: string, fulfillmentId: string) =>
    db().orderEvent.create({
      data: {
        accountId: g.accountId,
        orderId,
        fromStatus: "ACCEPTED",
        toStatus: "ACCEPTED",
        cause: "warehouse_cancel_refused",
        actorType: "system",
        meta: { fulfillmentId },
      },
    });
  const refusedReroute = (orderId: string, fulfillmentId: string) =>
    db().orderReroute.create({
      data: {
        accountId: g.accountId,
        orderId,
        fromFulfillmentId: fulfillmentId,
        fromConnectionId: g.connection.id,
        toConnectionId: g.connection.id,
        reasonCode: "other",
        status: "REFUSED",
      },
    });
  const statusOf = async (id: string) => (await db().alert.findUniqueOrThrow({ where: { id } })).status;

  it("'the warehouse refused the cancel' closes only once that shipment is cancelled by the warehouse's word", async () => {
    const { order } = await euTestOrder(g, { number: "#TK1" });
    const old = await shipment(order.id, "ACCEPTED", ago(60_000));
    await refusedCancel(order.id, old.id);
    await refusedReroute(order.id, old.id);
    const refused = await task(order.id, "warehouse_cancel_refused");
    const reroute = await task(order.id, "reroute_refused");
    const unknown = await task(order.id, "some_unknown_kind");

    let r = await recheckOrderTasks(g.owner, { orderId: order.id });
    expect(r.closed).toHaveLength(0);
    expect(r.kept.find((k) => k.id === refused.id)?.why).toBe("old_shipment_live");

    // Given up on euShipments "not found" only: no proof — stays.
    await db().fulfillment.update({
      where: { id: old.id },
      data: { status: "CANCELLED", rawStatus: "not found at euShipments" },
    });
    r = await recheckOrderTasks(g.owner, { orderId: order.id });
    expect(r.kept.find((k) => k.id === refused.id)?.why).toBe("old_shipment_unproven");

    // Cancelled in the warehouse's own system (rejected); a newer shipment no refusal is about does not count.
    await db().fulfillment.update({ where: { id: old.id }, data: { rawStatus: "rejected" } });
    await shipment(order.id, "ACCEPTED");
    r = await recheckOrderTasks(g.owner, { orderId: order.id });
    expect(r.closed.map((c) => c.id).sort()).toEqual([refused.id, reroute.id].sort());
    expect(await statusOf(unknown.id)).not.toBe("RESOLVED"); // no rule: never guessed
    expect(await db().alertNote.count({ where: { alertId: refused.id, action: "auto_resolve" } })).toBe(1);
    expect(
      await db().auditLog.count({ where: { entityId: refused.id, action: "alert.recheck_resolved" } }),
    ).toBe(1);
  });

  it("never closes: no earlier shipment, an unclear reroute, an order not moved to Блокирана", async () => {
    const { order } = await euTestOrder(g, { number: "#TK4" });
    const lonely = await task(order.id, "warehouse_cancel_refused", g.accountId, ago(120_000));
    await shipment(order.id, "CANCELLED", ago(60_000), "rejected");
    const unclear = await task(order.id, "reroute_uncertain");
    const notBlocked = await task(order.id, "warehouse_cancel_not_blocked");
    const r = await recheckOrderTasks(g.owner, { orderId: order.id });
    expect(r.closed).toEqual([]);
    expect(r.kept.find((k) => k.id === lonely.id)?.why).toBe("no_earlier_shipment");
    expect(r.kept.find((k) => k.id === unclear.id)?.why).toBeNull();
    expect(r.kept.find((k) => k.id === notBlocked.id)?.why).toBeNull();
  });

  it("a SUBMIT_FAILED earlier shipment counts as gone", async () => {
    const { order } = await euTestOrder(g, { number: "#TK5" });
    const f = await shipment(order.id, "SUBMIT_FAILED", ago(60_000));
    await refusedReroute(order.id, f.id);
    const refused = await task(order.id, "reroute_refused");
    expect((await recheckOrderTasks(g.owner, { orderId: order.id })).closed.map((c) => c.id)).toEqual([
      refused.id,
    ]);
  });

  it("one open task collects every refusal: a later refused shipment keeps it open", async () => {
    const { order } = await euTestOrder(g, { number: "#TK6" });
    const a = await shipment(order.id, "CANCELLED", ago(120_000), "rejected");
    await refusedCancel(order.id, a.id);
    const t = await task(order.id, "warehouse_cancel_refused", g.accountId, ago(100_000));
    const b = await shipment(order.id, "ACCEPTED");
    await refusedCancel(order.id, b.id); // folded into the same open task
    const r = await recheckOrderTasks(g.owner, { orderId: order.id });
    expect(r.kept.find((k) => k.id === t.id)?.why).toBe("old_shipment_live");
  });

  it("Shopify failed rows of a shipment not proven gone ('not found', a re-route still in flight) keep the task", async () => {
    const { order } = await euTestOrder(g, { number: "#TK7" });
    const lost = await shipment(order.id, "CANCELLED", ago(60_000), "not found at euShipments");
    await db().shopifyWriteBack.create({
      data: {
        accountId: g.accountId,
        storeId: g.store.id,
        orderId: order.id,
        fulfillmentId: lost.id,
        kind: "TRACKING",
        value: "T-7",
        status: "FAILED",
        lastError: "boom",
      },
    });
    const failed = await task(order.id, "shopify_writeback_failed");
    let r = await recheckOrderTasks(g.owner, { orderId: order.id });
    expect(r.kept.find((k) => k.id === failed.id)?.why).toBe("writeback_failed_left");

    const { order: o2 } = await euTestOrder(g, { number: "#TK8" });
    const moving = await shipment(o2.id, "ACCEPTED", ago(60_000));
    await db().orderReroute.create({
      data: {
        accountId: g.accountId,
        orderId: o2.id,
        fromFulfillmentId: moving.id,
        fromConnectionId: g.connection.id,
        toConnectionId: g.connection.id,
        reasonCode: "other",
      },
    });
    await db().shopifyWriteBack.create({
      data: {
        accountId: g.accountId,
        storeId: g.store.id,
        orderId: o2.id,
        fulfillmentId: moving.id,
        kind: "TRACKING",
        value: "T-8",
        status: "FAILED",
        lastError: "boom",
      },
    });
    const failed2 = await task(o2.id, "shopify_writeback_failed");
    const orphan = await task(o2.id, "shopify_writeback_orphaned"); // nothing flagged: no proof
    r = await recheckOrderTasks(g.owner, { orderId: o2.id });
    expect(r.closed).toEqual([]);
    expect(r.kept.find((k) => k.id === failed2.id)?.why).toBe("writeback_failed_left");
    expect(r.kept.find((k) => k.id === orphan.id)?.why).toBe("orphan_left");
  });

  it("Shopify write-backs: orphaned closes on a SENT take-over by a live shipment (not a dry run); failed FULFIL always counts", async () => {
    const { order } = await euTestOrder(g, { number: "#TK2" });
    const old = await shipment(order.id, "CANCELLED", ago(60_000), "rejected");
    const wb = (
      fulfillmentId: string,
      status: "SENT" | "FAILED" | "DRY_RUN_RECORDED" | "UNCERTAIN",
      lastError: string | null,
      kind: "FULFIL" | "TRACKING" = "FULFIL",
    ) =>
      db().shopifyWriteBack.create({
        data: {
          accountId: g.accountId,
          storeId: g.store.id,
          orderId: order.id,
          fulfillmentId,
          kind,
          value: kind === "FULFIL" ? "" : `v-${++n}`,
          status,
          lastError,
          shopifyFulfillmentGid: "gid://shopify/Fulfillment/1",
        },
      });
    await wb(old.id, "SENT", "shipment_cancelled_after_fulfil");
    const failedTracking = await wb(old.id, "FAILED", "boom", "TRACKING");
    const orphan = await task(order.id, "shopify_writeback_orphaned");
    const failed = await task(order.id, "shopify_writeback_failed");
    const unclear = await task(order.id, "shopify_writeback_uncertain");

    // A failed TRACKING row of a cancelled shipment does not count; no UNCERTAIN row.
    let r = await recheckOrderTasks(g.owner, { orderId: order.id });
    expect(r.closed.map((c) => c.id).sort()).toEqual([failed.id, unclear.id].sort());
    expect(await statusOf(orphan.id)).not.toBe("RESOLVED");
    expect(failedTracking.id).toBeTruthy();

    // A dry-run take-over changes nothing in Shopify: stays.
    const fresh = await shipment(order.id, "ACCEPTED");
    const dry = await wb(fresh.id, "DRY_RUN_RECORDED", "adopted_from_cancelled_shipment x");
    r = await recheckOrderTasks(g.owner, { orderId: order.id });
    expect(r.kept.find((k) => k.id === orphan.id)?.why).toBe("orphan_left");
    await db().shopifyWriteBack.update({ where: { id: dry.id }, data: { status: "SENT" } });
    r = await recheckOrderTasks(g.owner, { orderId: order.id });
    expect(r.closed.map((c) => c.id)).toEqual([orphan.id]);

    // A failed FULFIL row counts even for a cancelled shipment (it may have left something in Shopify).
    const failed2 = await task(order.id, "shopify_writeback_failed");
    const unclear2 = await task(order.id, "shopify_writeback_uncertain");
    const old2 = await shipment(order.id, "CANCELLED", ago(60_000), "rejected");
    await wb(old2.id, "FAILED", "several fulfillments match");
    await wb(fresh.id, "UNCERTAIN", "timeout", "TRACKING");
    r = await recheckOrderTasks(g.owner, { orderId: order.id });
    expect(r.closed).toEqual([]);
    expect(r.kept.find((k) => k.id === failed2.id)?.why).toBe("writeback_failed_left");
    expect(r.kept.find((k) => k.id === unclear2.id)?.why).toBe("writeback_uncertain_left");
  });

  it("needs orders.review, the order's company and the account; another account's tasks are untouched", async () => {
    const { order } = await euTestOrder(g, { number: "#TK3" });
    await expect(
      recheckOrderTasks({ ...g.owner, role: "VIEWER" as never }, { orderId: order.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      recheckOrderTasks({ ...g.owner, companyScope: ["other"] }, { orderId: order.id }),
    ).rejects.toMatchObject({ code: "not_found" });
    const theirs = await euTestOrder(other, { number: "#TK3X" });
    const theirTask = await task(theirs.order.id, "shopify_writeback_uncertain", other.accountId);
    await expect(recheckOrderTasks(g.owner, { orderId: theirs.order.id })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await statusOf(theirTask.id)).not.toBe("RESOLVED");
  });
});
