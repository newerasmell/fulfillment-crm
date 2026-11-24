import { describe, expect, it } from "vitest";
import { cancelledByWarehouseTag } from "@/server/override/cancel-effects";
import { systemDb } from "@/server/db/client";
import { euTestGroup, euTestOrder } from "./test-fixtures";
import { checkProblemShipmentsByAwb } from "./awb-check";

// Owner report 2026-11-24: deleted in the cabinet, orders-history still "Awaiting pickup". Synthetic data only.
describe("problem shipments checked by their AWB", () => {
  it("a live shipment of an order with an open task whose AWB says canceled/deleted is cancelled; others stay", async () => {
    const g = await euTestGroup("awb-check");
    const db = systemDb();
    const make = async (n: string, awb: string, task: boolean) => {
      const { order } = await euTestOrder(g, { number: n });
      await db.order.update({ where: { id: order.id }, data: { status: "ACCEPTED" } });
      const f = await db.fulfillment.create({
        data: {
          accountId: g.accountId,
          orderId: order.id,
          connectionId: g.connection.id,
          externalId: `X${n}`,
          status: "ACCEPTED",
          trackingNumbers: [awb],
        },
      });
      if (task)
        await db.alert.create({
          data: {
            accountId: g.accountId,
            kind: "order_stuck",
            isTask: true,
            severity: "WARNING",
            title: "Synthetic",
            body: "status=ACCEPTED",
            entityType: "Order",
            entityId: order.id,
          },
        });
      return { order, f };
    };
    const gone = await make("#AWB-1", "SYNAWB0001", true);
    const alive = await make("#AWB-2", "SYNAWB0002", true);
    const quiet = await make("#AWB-3", "SYNAWB0003", false); // no task: not asked
    const asked: string[] = [];
    const client = {
      getAwbStatus: async (awb: string) => {
        asked.push(awb);
        return {
          status: awb === "SYNAWB0001" || awb === "SYNAWB0003" ? "canceled/deleted" : "Awaiting pickup",
        };
      },
    };
    const r = await checkProblemShipmentsByAwb(new Date(), {
      clientFor: async () => client,
      accountId: g.accountId,
    });
    expect(r.deleted).toBe(1);
    expect(asked.sort()).toEqual(["SYNAWB0001", "SYNAWB0002"]);
    expect((await db.fulfillment.findUniqueOrThrow({ where: { id: gone.f.id } })).status).toBe("CANCELLED");
    expect((await db.order.findUniqueOrThrow({ where: { id: gone.order.id } })).status).toBe("BLOCKED");
    expect(
      await db.alert.count({
        where: { entityId: gone.f.id, kind: "eushipments_cancelled_at_vendor", status: { not: "RESOLVED" } },
      }),
    ).toBe(1);
    expect((await db.fulfillment.findUniqueOrThrow({ where: { id: alive.f.id } })).status).toBe("ACCEPTED");
    expect((await db.fulfillment.findUniqueOrThrow({ where: { id: quiet.f.id } })).status).toBe("ACCEPTED");
    // A read error is no proof.
    const failing = {
      getAwbStatus: async () => {
        throw new Error("down");
      },
    };
    expect(
      (
        await checkProblemShipmentsByAwb(new Date(), {
          clientFor: async () => failing,
          accountId: g.accountId,
        })
      ).deleted,
    ).toBe(0);
    // Again: nothing new (already cancelled).
    expect(
      (
        await checkProblemShipmentsByAwb(new Date(), {
          clientFor: async () => client,
          accountId: g.accountId,
        })
      ).deleted,
    ).toBe(0);
  });

  it("only before the courier (ACCEPTED / PROCESSING); every AWB must be deleted; a failing connection is left after 3 errors", async () => {
    const g = await euTestGroup("awb-check-2");
    const db = systemDb();
    const make = async (n: string, awbs: string[], status: "ACCEPTED" | "PROCESSING" | "SHIPPED") => {
      const { order } = await euTestOrder(g, { number: n });
      await db.order.update({ where: { id: order.id }, data: { status } });
      const f = await db.fulfillment.create({
        data: {
          accountId: g.accountId,
          orderId: order.id,
          connectionId: g.connection.id,
          externalId: `Y${n}`,
          status,
          trackingNumbers: awbs,
        },
      });
      await db.alert.create({
        data: {
          accountId: g.accountId,
          kind: "order_stuck",
          isTask: true,
          severity: "WARNING",
          title: "Synthetic",
          body: `status=${status}`,
          entityType: "Order",
          entityId: order.id,
        },
      });
      return f;
    };
    const shipped = await make("#AWB-S", ["SYNAWB1001"], "SHIPPED");
    const mixed = await make("#AWB-M", ["SYNAWB1002", "SYNAWB1003"], "PROCESSING");
    const both = await make("#AWB-B", ["SYNAWB1004", "SYNAWB1005"], "PROCESSING");
    const asked: string[] = [];
    const client = {
      getAwbStatus: async (awb: string) => {
        asked.push(awb);
        return { status: awb === "SYNAWB1003" ? "In transit" : "canceled/deleted" };
      },
    };
    const r = await checkProblemShipmentsByAwb(new Date(), {
      clientFor: async () => client,
      accountId: g.accountId,
    });
    expect(r.deleted).toBe(1);
    expect(asked).not.toContain("SYNAWB1001"); // a parcel on its way is never asked
    const st = async (id: string) => (await db.fulfillment.findUniqueOrThrow({ where: { id } })).status;
    expect(await st(shipped.id)).toBe("SHIPPED");
    expect(await st(mixed.id)).toBe("PROCESSING");
    expect(await st(both.id)).toBe("CANCELLED");

    // A connection that keeps failing is left after 3 lookups without an answer.
    for (let i = 0; i < 3; i++) await make(`#AWB-E${i}`, [`SYNAWB20${i}0`], "ACCEPTED");
    let calls = 0;
    const failing = {
      getAwbStatus: async () => {
        calls++;
        throw new Error("down");
      },
    };
    await checkProblemShipmentsByAwb(new Date(), { clientFor: async () => failing, accountId: g.accountId });
    expect(calls).toBe(3); // 4 live shipments (mixed + 3 new), only 3 asked
  });

  it("one shipment that fails never stops the others", async () => {
    const g = await euTestGroup("awb-check-3");
    const db = systemDb();
    const make = async (n: string, awb: string) => {
      const { order } = await euTestOrder(g, { number: n });
      await db.order.update({ where: { id: order.id }, data: { status: "ACCEPTED" } });
      const f = await db.fulfillment.create({
        data: {
          accountId: g.accountId,
          orderId: order.id,
          connectionId: g.connection.id,
          externalId: `Z${n}`,
          status: "ACCEPTED",
          trackingNumbers: [awb],
        },
      });
      await db.alert.create({
        data: {
          accountId: g.accountId,
          kind: "order_stuck",
          isTask: true,
          severity: "WARNING",
          title: "Synthetic",
          body: "status=ACCEPTED",
          entityType: "Order",
          entityId: order.id,
        },
      });
      return { order, f };
    };
    const a = await make("#AWB-F1", "SYNAWB3001");
    const b = await make("#AWB-F2", "SYNAWB3002");
    // Its order disappears under the sweep: the transaction for that shipment throws.
    const doomed = [a, b].sort((x, y) => (x.f.id < y.f.id ? -1 : 1))[0]!;
    const other = doomed === a ? b : a;
    const client = {
      getAwbStatus: async (awb: string) => {
        if (awb === doomed.f.trackingNumbers[0]) await db.fulfillment.delete({ where: { id: doomed.f.id } });
        return { status: "canceled/deleted" };
      },
    };
    const r = await checkProblemShipmentsByAwb(new Date(), {
      clientFor: async () => client,
      accountId: g.accountId,
    });
    expect(r.deleted).toBe(1);
    expect((await db.fulfillment.findUniqueOrThrow({ where: { id: other.f.id } })).status).toBe("CANCELLED");
  });

  it("names the cancelling warehouse in a Shopify tag (≤ 40 characters)", () => {
    expect(cancelledByWarehouseTag("Warehouse A")).toBe("cancelled by warehouse Warehouse A");
    expect(cancelledByWarehouseTag("A very long warehouse name, with comma").length).toBeLessThanOrEqual(40);
  });
});
