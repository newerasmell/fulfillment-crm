import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/auth/rbac";
import { checkOrder } from "@/server/checks";
import { euTestGroup, euTestOrder } from "@/server/eushipments/test-fixtures";
import { applyOrderHistory } from "@/server/eushipments/statuses";
import { fulfillOrder } from "@/server/fulfill";
import { processOutbound } from "@/server/outbox/outbox";
import type { OutboundTransport, TransportResolver } from "@/server/outbox/transport";
import { transitionOrder } from "@/server/pipeline";
import { decideOrder } from "@/server/review";
import {
  clearWarehouseChoice,
  isTwoActiveShipments,
  processReroute,
  requestReroute,
  rerouteView,
  setWarehouseChoice,
  warehouseOptions,
  warehouseReasonCodes,
} from "./index";

// Synthetic data only. No vendor is called: the outbox sender runs with fake transports.

type G = Awaited<ReturnType<typeof euTestGroup>>;

const fake =
  (t: Partial<OutboundTransport>): TransportResolver =>
  () => ({
    send: async () => ({ outcome: "accepted", response: { ok: true } }),
    readBack: async () => ({ found: true, response: { gone: true } }),
    ...t,
  });

describe("manual warehouse choice and reroute (P4-09)", () => {
  let g: G;
  let n = 7000;
  let connB: { id: string };
  let connC: { id: string };
  let connOff: { id: string };
  let operator: G["owner"];
  let viewer: G["owner"];
  let admin: G["owner"];

  async function stockAt(connectionId: string, productId: string, qty: number) {
    const vp = await g.db.vendorProduct.create({
      data: { accountId: g.accountId, connectionId, productId, vendorId: `REF-${++n}` },
    });
    await g.db.stockLevel.create({
      data: {
        accountId: g.accountId,
        vendorProductId: vp.id,
        physical: qty,
        free: qty,
        sellable: qty,
        snapshotAt: new Date(),
        source: "POLL",
      },
    });
  }

  /** A checked order with stock at A and B (routing picks A, the selling company's own warehouse). */
  async function checkedOrder(opts: { stockB?: number } = {}) {
    const { order, product } = await euTestOrder(g, { number: `#${++n}` });
    await stockAt(g.connection.id, product.id, 50);
    await stockAt(connB.id, product.id, opts.stockB ?? 50);
    await stockAt(connC.id, product.id, 50);
    await g.db.order.update({ where: { id: order.id }, data: { status: "IMPORTED" } });
    const c = await checkOrder(g.accountId, order.id, { actor: { kind: "system" } });
    expect(c.connectionId).toBe(g.connection.id);
    return { order, product };
  }

  const approve = (orderId: string) =>
    decideOrder(g.owner, {
      orderId,
      decision: "approve",
      reasonCode: null,
      reasonText: null,
      openedAt: null,
    });

  /** Sent and accepted at A (synthetic: as if the outbox had sent it and the vendor answered). */
  async function sentAtA(raw = "Information received") {
    const { order } = await checkedOrder();
    await approve(order.id);
    const r = await fulfillOrder(g.owner, order.id);
    expect(r.status).toBe("QUEUED");
    const f = await g.db.fulfillment.findFirstOrThrow({ where: { orderId: order.id } });
    await g.db.outboundRequest.update({ where: { id: r.requestId! }, data: { status: "SENT" } });
    await g.db.fulfillment.update({
      where: { id: f.id },
      data: { status: "ACCEPTED", rawStatus: raw, submittedAt: new Date() },
    });
    await transitionOrder(g.accountId, {
      orderId: order.id,
      to: "ACCEPTED",
      cause: "vendor",
      actor: { kind: "system" },
    });
    return { order, fulfillment: f };
  }

  const setMode = (id: string, liveMode: "READ_ONLY" | "DRY_RUN" | "CANARY" | "LIVE") =>
    g.db.fulfillmentConnection.update({ where: { id }, data: { liveMode } });

  const reroute = (orderId: string, by = g.owner) =>
    requestReroute(by, { orderId, toConnectionId: connB.id, reasonCode: "no_stock" });

  beforeAll(async () => {
    g = await euTestGroup("override");
    await g.db.countrySetting.create({ data: { accountId: g.accountId, country: "BG", currency: "EUR" } });
    const line = await g.db.productLine.create({ data: { accountId: g.accountId, name: "Козметика" } });
    const other = await g.db.productLine.create({ data: { accountId: g.accountId, name: "Текстил" } });
    await g.db.company.update({ where: { id: g.company.id }, data: { lineId: line.id } });
    const sister = await g.db.company.create({
      data: { accountId: g.accountId, name: "Сестринска фирма", lineId: line.id },
    });
    const foreign = await g.db.company.create({
      data: { accountId: g.accountId, name: "Друга линия", lineId: other.id },
    });
    const base = {
      accountId: g.accountId,
      type: "EUSHIPMENTS" as const,
      credentialId: g.connection.credentialId,
      vendorIds: { companyId: 334 },
      liveMode: "LIVE" as const,
    };
    connB = await g.db.fulfillmentConnection.create({
      data: { ...base, companyId: sister.id, name: "euShipments сестра" },
    });
    connC = await g.db.fulfillmentConnection.create({
      data: { ...base, companyId: foreign.id, name: "euShipments друга линия" },
    });
    connOff = await g.db.fulfillmentConnection.create({
      data: { ...base, companyId: sister.id, name: "euShipments изключен", enabled: false },
    });
    operator = { ...g.owner, role: "OPERATOR" };
    viewer = { ...g.owner, role: "VIEWER" };
    admin = { ...g.owner, role: "ADMIN" };
  });

  describe("Изпрати от (before sending)", () => {
    it("lists only enabled warehouses of the order's product line, with stock and the cross-company marker", async () => {
      const { order } = await checkedOrder({ stockB: 1 });
      const options = await warehouseOptions(g.owner, order.id);
      const ids = options.map((o) => o.id);
      expect(ids).toContain(g.connection.id);
      expect(ids).toContain(connB.id);
      expect(ids).not.toContain(connC.id); // another line sells other goods
      expect(ids).not.toContain(connOff.id);
      const b = options.find((o) => o.id === connB.id)!;
      expect(b.crossCompany).toBe(true);
      expect(b.stock.status).toBe("insufficient"); // 2 needed, 1 there
      expect(options.find((o) => o.id === g.connection.id)!.crossCompany).toBe(false);
    });

    it("the default reason list: няма наличност, по-бърза доставка, клиентът поиска, друго", async () => {
      const codes = (await warehouseReasonCodes(g.accountId)).map((c) => c.code);
      expect(codes).toEqual(["no_stock", "faster_delivery", "customer_requested", "other"]);
    });

    it("needs a reason (and text for Друго), an eligible warehouse and orders.review", async () => {
      const { order } = await checkedOrder();
      const base = { orderId: order.id, connectionId: connB.id };
      await expect(setWarehouseChoice(g.owner, base)).rejects.toMatchObject({ code: "reason_required" });
      await expect(setWarehouseChoice(g.owner, { ...base, reasonCode: "other" })).rejects.toMatchObject({
        code: "reason_text_required",
      });
      await expect(setWarehouseChoice(g.owner, { ...base, reasonCode: "all_ok" })).rejects.toMatchObject({
        code: "reason_invalid",
      });
      await expect(
        setWarehouseChoice(g.owner, { ...base, connectionId: connC.id, reasonCode: "no_stock" }),
      ).rejects.toMatchObject({ code: "connection_not_eligible" });
      await expect(setWarehouseChoice(viewer, { ...base, reasonCode: "no_stock" })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      expect(await g.db.orderWarehouseChoice.count({ where: { orderId: order.id } })).toBe(0);
    });

    it("stores the choice, re-runs the checks for it and binds approval + Fulfill to it", async () => {
      const { order } = await checkedOrder();
      const r = await setWarehouseChoice(operator, {
        orderId: order.id,
        connectionId: connB.id,
        reasonCode: "faster_delivery",
      });
      expect(r.connectionId).toBe(connB.id);
      const check = await g.db.orderCheck.findFirstOrThrow({ where: { orderId: order.id } });
      expect(check.connectionId).toBe(connB.id);
      expect(check.ruleId).toBeNull();
      const routing = check.routing as {
        via: string;
        crossCompany: boolean;
        manual: Record<string, unknown>;
      };
      expect(routing.via).toBe("manual");
      expect(routing.crossCompany).toBe(true);
      expect(routing.manual).toMatchObject({
        via: "manual",
        userId: g.owner.userId,
        reasonCode: "faster_delivery",
        routed: { connectionId: g.connection.id },
      });
      const ev = await g.db.orderEvent.findFirstOrThrow({
        where: { orderId: order.id, cause: "warehouse_choice" },
      });
      expect(ev.meta).toMatchObject({ connectionId: connB.id, fromConnectionId: g.connection.id });
      expect(
        await g.db.auditLog.count({ where: { entityId: order.id, action: "order.warehouse_choice" } }),
      ).toBe(1);
      expect(await g.db.review.count({ where: { orderId: order.id, decision: "REROUTE" } })).toBe(1);

      // A later background re-check keeps the choice.
      await g.db.order.update({ where: { id: order.id }, data: { status: "IMPORTED" } });
      await checkOrder(g.accountId, order.id, { actor: { kind: "system" } });
      expect((await g.db.orderCheck.findFirstOrThrow({ where: { orderId: order.id } })).connectionId).toBe(
        connB.id,
      );

      await approve(order.id);
      const f = await fulfillOrder(g.owner, order.id);
      expect(f).toMatchObject({ status: "QUEUED", connectionId: connB.id });
      const shipments = await g.db.fulfillment.findMany({ where: { orderId: order.id } });
      expect(shipments.map((s) => s.connectionId)).toEqual([connB.id]);
    });

    it("changing the warehouse of an APPROVED order reopens it; the old approval can no longer be used", async () => {
      const { order } = await checkedOrder();
      await approve(order.id);
      await setWarehouseChoice(g.owner, {
        orderId: order.id,
        connectionId: connB.id,
        reasonCode: "no_stock",
      });
      const o = await g.db.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(o.status).not.toBe("APPROVED");
      expect(await fulfillOrder(g.owner, order.id)).toMatchObject({ status: "SKIPPED" });
      // The pipeline guard still refuses an approval meant for the other warehouse.
      await expect(
        transitionOrder(g.accountId, {
          orderId: order.id,
          to: "APPROVED",
          cause: "approve",
          actor: { kind: "user", userId: g.owner.userId },
          meta: { connectionId: g.connection.id },
        }),
      ).rejects.toMatchObject({ code: "transition_guard:check_connection_mismatch" });
    });

    it("clearing the choice returns to the routing decision", async () => {
      const { order } = await checkedOrder();
      await setWarehouseChoice(g.owner, {
        orderId: order.id,
        connectionId: connB.id,
        reasonCode: "no_stock",
      });
      const r = await clearWarehouseChoice(g.owner, order.id);
      expect(r.connectionId).toBe(g.connection.id);
      expect(await g.db.orderWarehouseChoice.count({ where: { orderId: order.id } })).toBe(0);
      const check = await g.db.orderCheck.findFirstOrThrow({ where: { orderId: order.id } });
      expect((check.routing as { via: string }).via).not.toBe("manual");
      await expect(clearWarehouseChoice(g.owner, order.id)).rejects.toMatchObject({ code: "no_choice" });
    });

    it("a chosen warehouse that is switched off later blocks the order instead of silently re-routing", async () => {
      const { order } = await checkedOrder();
      await setWarehouseChoice(g.owner, {
        orderId: order.id,
        connectionId: connB.id,
        reasonCode: "no_stock",
      });
      await g.db.fulfillmentConnection.update({ where: { id: connB.id }, data: { enabled: false } });
      try {
        await g.db.order.update({ where: { id: order.id }, data: { status: "IMPORTED" } });
        const c = await checkOrder(g.accountId, order.id, { actor: { kind: "system" } });
        expect(c.connectionId).toBe(connB.id);
        expect(c.findings.map((f) => f.code)).toContain("routing.chosen_connection_disabled");
        expect(c.status).toBe("NEEDS_REVIEW");
      } finally {
        await g.db.fulfillmentConnection.update({ where: { id: connB.id }, data: { enabled: true } });
      }
    });

    it("is refused once the order is queued or at a warehouse", async () => {
      const { order } = await sentAtA();
      await expect(
        setWarehouseChoice(g.owner, { orderId: order.id, connectionId: connB.id, reasonCode: "no_stock" }),
      ).rejects.toMatchObject({ code: "choice_not_allowed" });
    });
  });

  describe("Пренасочи (after sending)", () => {
    it("OWNER/ADMIN only, and only while the old warehouse can still cancel", async () => {
      const { order } = await sentAtA();
      await expect(reroute(order.id, operator)).rejects.toBeInstanceOf(ForbiddenError);
      const packed = await sentAtA("Packed");
      await expect(reroute(packed.order.id)).rejects.toMatchObject({ code: "not_cancellable" });
      const old = await sentAtA();
      await g.db.fulfillment.update({
        where: { id: old.fulfillment.id },
        data: { submittedAt: new Date(Date.now() - 15 * 24 * 3600_000) },
      });
      await expect(reroute(old.order.id)).rejects.toMatchObject({ code: "not_cancellable" });
      const view = await rerouteView(operator, order.id);
      expect(view.canReroute).toBe(false);
      expect((await rerouteView(admin, order.id)).targets.map((t) => t.id)).toEqual([connB.id]);
      expect(await g.db.orderReroute.count({ where: { orderId: packed.order.id } })).toBe(0);
    });

    it("cancel confirmed by read-back → old shipment CANCELLED, order APPROVED for the new warehouse, Fulfill sends once", async () => {
      const { order, fulfillment } = await sentAtA();
      const req = await reroute(order.id, admin);
      // Before the cancel is sent nothing changes.
      expect(await processReroute(g.accountId, req.rerouteId, fake({}))).toBe("waiting");
      expect(await processOutbound(req.requestId, fake({}))).toBe("SENT");
      expect(await processReroute(g.accountId, req.rerouteId, fake({}))).toBe("DONE");

      expect((await g.db.fulfillment.findUniqueOrThrow({ where: { id: fulfillment.id } })).status).toBe(
        "CANCELLED",
      );
      const o = await g.db.order.findUniqueOrThrow({ where: { id: order.id }, include: { check: true } });
      expect(o.status).toBe("APPROVED");
      expect(o.check!.connectionId).toBe(connB.id);
      expect((o.check!.routing as { manual?: { via: string } }).manual?.via).toBe("reroute");
      expect(await g.db.orderEvent.count({ where: { orderId: order.id, cause: "reroute" } })).toBe(1);
      expect(await g.db.auditLog.count({ where: { entityId: order.id, action: "order.reroute_done" } })).toBe(
        1,
      );

      const rs = await Promise.all([1, 2, 3].map(() => fulfillOrder(g.owner, order.id)));
      expect(rs.filter((r) => r.status === "QUEUED")).toHaveLength(1);
      const active = await g.db.fulfillment.findMany({
        where: { orderId: order.id, status: { notIn: ["CANCELLED", "SUBMIT_FAILED"] } },
      });
      expect(active.map((f) => f.connectionId)).toEqual([connB.id]);

      // A late status of the old shipment never reactivates it or moves the order.
      await applyOrderHistory(g.accountId, fulfillment.id, {
        refNum: fulfillment.externalId,
        statusesHistory: [{ ID: 1, STATUS: "Information received", DATE: "2026-11-02 10:00:00" }],
      } as never);
      expect((await g.db.fulfillment.findUniqueOrThrow({ where: { id: fulfillment.id } })).status).toBe(
        "CANCELLED",
      );
      expect((await g.db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("QUEUED");
    });

    it("races: two reroute requests → one; two confirmations → one switch", async () => {
      const { order } = await sentAtA();
      const both = await Promise.allSettled([reroute(order.id), reroute(order.id)]);
      expect(both.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      const failed = both.find((x) => x.status === "rejected") as PromiseRejectedResult;
      expect(failed.reason).toMatchObject({ code: "reroute_open" });
      const r = await g.db.orderReroute.findFirstOrThrow({ where: { orderId: order.id } });
      await processOutbound(r.cancelRequestId!, fake({}));
      const results = await Promise.all([
        processReroute(g.accountId, r.id, fake({})),
        processReroute(g.accountId, r.id, fake({})),
      ]);
      expect(results.filter((x) => x === "DONE")).toHaveLength(1);
      expect(await g.db.orderEvent.count({ where: { orderId: order.id, cause: "reroute" } })).toBe(1);
    });

    it("the database refuses a second active shipment of one order", async () => {
      const { order } = await sentAtA();
      const err = await g.db.fulfillment
        .create({
          data: {
            accountId: g.accountId,
            orderId: order.id,
            connectionId: connB.id,
            externalId: `X-${order.number}`,
            status: "QUEUED",
          },
        })
        .catch((e: unknown) => e);
      expect(isTwoActiveShipments(err)).toBe(true);
      // An inactive row is fine, but it cannot be re-activated while the other is active.
      const dead = await g.db.fulfillment.create({
        data: {
          accountId: g.accountId,
          orderId: order.id,
          connectionId: connB.id,
          externalId: `Y-${order.number}`,
          status: "CANCELLED",
        },
      });
      const err2 = await g.db.fulfillment
        .update({ where: { id: dead.id }, data: { status: "QUEUED" } })
        .catch((e: unknown) => e);
      expect(isTwoActiveShipments(err2)).toBe(true);
    });

    it("refused at the warehouse: nothing changes, a task is opened", async () => {
      const { order, fulfillment } = await sentAtA();
      const req = await reroute(order.id);
      const refusing = fake({
        send: async () => ({ outcome: "rejected", response: null, error: "too late" }),
      });
      expect(await processOutbound(req.requestId, refusing)).toBe("FAILED");
      expect(await processReroute(g.accountId, req.rerouteId, refusing)).toBe("REFUSED");
      expect((await g.db.fulfillment.findUniqueOrThrow({ where: { id: fulfillment.id } })).status).toBe(
        "ACCEPTED",
      );
      expect((await g.db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("ACCEPTED");
      expect(await g.db.orderWarehouseChoice.count({ where: { orderId: order.id } })).toBe(0);
      const task = await g.db.alert.findFirstOrThrow({
        where: { entityId: order.id, kind: "reroute_refused" },
      });
      expect(task.isTask).toBe(true);
    });

    it("unknown outcome / unconfirmed cancel: nothing changes, a CRITICAL task", async () => {
      const { order, fulfillment } = await sentAtA();
      const req = await reroute(order.id);
      const stillThere = fake({ readBack: async () => ({ found: false }) });
      await processOutbound(req.requestId, fake({}));
      let now = Date.now();
      let last = "";
      for (let i = 0; i < 12 && last !== "UNCERTAIN"; i++) {
        now += 61_000;
        last = await processReroute(g.accountId, req.rerouteId, stillThere, new Date(now));
      }
      expect(last).toBe("UNCERTAIN");
      expect((await g.db.fulfillment.findUniqueOrThrow({ where: { id: fulfillment.id } })).status).toBe(
        "ACCEPTED",
      );
      expect((await g.db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("ACCEPTED");
      expect(
        await g.db.alert.findFirst({ where: { entityId: order.id, kind: "reroute_uncertain" } }),
      ).toMatchObject({ severity: "CRITICAL", isTask: true });

      const other = await sentAtA();
      const req2 = await reroute(other.order.id);
      const broken = fake({
        send: async () => {
          throw new Error("timeout");
        },
        readBack: async () => {
          throw new Error("down");
        },
      });
      expect(await processOutbound(req2.requestId, broken)).toBe("UNCERTAIN");
      expect(await processReroute(g.accountId, req2.rerouteId, broken)).toBe("UNCERTAIN");
      expect((await g.db.order.findUniqueOrThrow({ where: { id: other.order.id } })).status).toBe("ACCEPTED");
    });

    it("DRY_RUN: only records what would happen", async () => {
      const { order, fulfillment } = await sentAtA();
      const req = await reroute(order.id);
      await setMode(g.connection.id, "DRY_RUN");
      try {
        expect(await processOutbound(req.requestId, fake({}))).toBe("DRY_RUN_RECORDED");
        expect(await processReroute(g.accountId, req.rerouteId, fake({}))).toBe("SIMULATED");
      } finally {
        await setMode(g.connection.id, "LIVE");
      }
      const r = await g.db.orderReroute.findUniqueOrThrow({ where: { id: req.rerouteId } });
      expect(r.outcome).toMatchObject({ mode: "DRY_RUN", wouldApproveFor: { connectionId: connB.id } });
      expect((await g.db.fulfillment.findUniqueOrThrow({ where: { id: fulfillment.id } })).status).toBe(
        "ACCEPTED",
      );
      expect((await g.db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("ACCEPTED");
      expect(await g.db.orderEvent.count({ where: { orderId: order.id, cause: "reroute_simulated" } })).toBe(
        1,
      );
    });

    it("refuses a target with blocking findings (no stock) before anything is queued", async () => {
      const { order } = await sentAtA();
      const lines = await g.db.orderLine.findMany({ where: { orderId: order.id } });
      await g.db.stockLevel.updateMany({
        where: { vendorProduct: { connectionId: connB.id, productId: lines[0]!.productId! } },
        data: { sellable: 0, free: 0, physical: 0 },
      });
      await expect(reroute(order.id)).rejects.toMatchObject({ code: "reroute_hard_findings" });
      expect(await g.db.orderReroute.count({ where: { orderId: order.id } })).toBe(0);
      expect(
        await g.db.outboundRequest.count({
          where: { fulfillment: { orderId: order.id }, operation: "eushipments.deleteOrder" },
        }),
      ).toBe(0);
    });
  });
});
