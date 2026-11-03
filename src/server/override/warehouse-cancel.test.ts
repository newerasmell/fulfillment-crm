import { beforeAll, describe, expect, it } from "vitest";
import examples from "@/integrations/fhb-v3/__fixtures__/openapi-examples.json";
import { ForbiddenError } from "@/server/auth/rbac";
import { withAccountTransaction } from "@/server/db/client";
import { createFhbConnection } from "@/server/fhb/connection";
import { createFhbTransportResolver } from "@/server/fhb/transport";
import { applyOrderHistory, markGoneAtVendor } from "@/server/eushipments/statuses";
import { euTestGroup, euTestOrder } from "@/server/eushipments/test-fixtures";
import { euShipmentsTransportFor } from "@/server/eushipments/transport";
import { confirmCanary, processOutbound } from "@/server/outbox/outbox";
import type { TransportResolver } from "@/server/outbox/transport";
import { BLOCKED_TASK_KIND, decideOrder, restartOrder } from "@/server/review";
import {
  requestWarehouseCancel,
  warehouseCancelConfirmed,
  warehouseCancelRefusal,
  warehouseCancelView,
  type CancelShipmentLike,
} from "./index";

// Synthetic data only. No vendor is called: the outbox sender runs the REAL FHB / euShipments adapters against
// mocked HTTP, so their effects (an accepted delete marks the shipment CANCELLED, a refusal raises a task) run as in
// production.

type G = Awaited<ReturnType<typeof euTestGroup>>;

const jsonRes = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function euVendor(o: { del?: () => Response; history?: (refNum: string) => unknown } = {}) {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname.replace("/api/v1", "");
    calls.push(path);
    if (path.startsWith("/orders-delete/"))
      return o.del ? o.del() : jsonRes({ error: null, message: "deleted" });
    if (path === "/fulfilment/orders-history" && o.history) {
      const body = JSON.parse(String(init.body ?? "{}")) as { orders: { refNum: string }[] };
      return jsonRes(body.orders.map((x) => o.history!(x.refNum)));
    }
    throw new Error(`unexpected call ${path}`);
  };
  const resolve: TransportResolver = (c) => euShipmentsTransportFor(c, { fetchImpl, sleep: async () => {} });
  return { calls, resolve };
}

const ex = examples as unknown as Record<string, Record<string, unknown>>;

function fhbVendor(o: { refuse?: boolean; deleteDropped?: boolean } = {}) {
  const calls: string[] = [];
  let deleted = false;
  const fetchImpl = async (u: string, init: RequestInit = {}) => {
    const url = new URL(u);
    if (url.pathname === "/v3/login") return jsonRes({ token: "t", expiration: "2099-01-01T00:00:00+0000" });
    const key = `${init.method ?? "GET"} ${url.pathname.replace("/v3", "")}`;
    const id = url.searchParams.get("id") ?? "";
    calls.push(`${key} ${id}`);
    if (key === "DELETE /order") {
      // The request reached FHB and deleted the order, but the answer was lost (network error).
      if (o.deleteDropped) {
        deleted = true;
        throw new TypeError("fetch failed");
      }
      if (o.refuse) return jsonRes({ message: "Order is not in pending state", errors: {} }, 400);
      return new Response(null, { status: 204 });
    }
    if (key === "GET /order")
      return deleted
        ? jsonRes({ message: "Not found" }, 404)
        : jsonRes({ ...ex["POST /order 200 response"], id, status: "pending" });
    throw new Error(`unexpected ${key}`);
  };
  const resolve = createFhbTransportResolver({ fetchImpl, sleep: async () => {}, random: () => 0 });
  return { calls, resolve };
}

const vendors =
  (eu = euVendor(), fhb = fhbVendor()): TransportResolver =>
  (c) =>
    c.type === "FHB_V3" ? fhb.resolve(c) : eu.resolve(c);

describe("Откажи в склада (cancel a shipment at the warehouse from the CRM)", () => {
  let g: G;
  let other: G;
  let n = 9100;
  let fhb: { id: string };
  let admin: G["owner"];
  let operator: G["owner"];
  let viewer: G["owner"];

  /** An order whose single shipment was accepted at the connection (synthetic: as if sent and answered). */
  async function shipped(opts: { connectionId?: string; raw?: string; submittedAt?: Date } = {}) {
    const connectionId = opts.connectionId ?? g.connection.id;
    const { order } = await euTestOrder(g, { number: `#${++n}` });
    const fulfillment = await g.db.fulfillment.create({
      data: {
        accountId: g.accountId,
        orderId: order.id,
        connectionId,
        externalId: `TST-${n}`,
        variableSymbol: connectionId === fhb.id ? String(n) : null,
        status: "ACCEPTED",
        rawStatus: opts.raw ?? (connectionId === fhb.id ? "pending" : "Information received"),
        submittedAt: opts.submittedAt ?? new Date(),
      },
    });
    await g.db.order.update({ where: { id: order.id }, data: { status: "ACCEPTED" } });
    return { order, fulfillment };
  }

  const cancel = (fulfillmentId: string, by = g.owner, reasonCode: string | null = "sent_by_mistake") =>
    requestWarehouseCancel(by, { fulfillmentId, reasonCode, reasonText: "грешен склад" });
  const status = async (orderId: string) =>
    (await g.db.order.findUniqueOrThrow({ where: { id: orderId } })).status;
  const shipStatus = async (id: string) =>
    (await g.db.fulfillment.findUniqueOrThrow({ where: { id } })).status;
  const setMode = (id: string, liveMode: "READ_ONLY" | "DRY_RUN" | "CANARY" | "LIVE") =>
    g.db.fulfillmentConnection.update({ where: { id }, data: { liveMode } });

  beforeAll(async () => {
    g = await euTestGroup("wcancel");
    other = await euTestGroup("wcancel-other");
    const f = await createFhbConnection(g.owner, {
      companyId: g.company.id,
      name: "FHB test",
      appId: "test-app",
      secret: "test-secret",
      skuPrefix: "W",
    });
    fhb = await g.db.fulfillmentConnection.update({ where: { id: f.id }, data: { liveMode: "LIVE" } });
    admin = { ...g.owner, role: "ADMIN" };
    operator = { ...g.owner, role: "OPERATOR" };
    viewer = { ...g.owner, role: "VIEWER" };
  });

  describe("cancellable rules per vendor (pure)", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    const base: CancelShipmentLike = {
      status: "ACCEPTED",
      rawStatus: "pending",
      submittedAt: now,
      createdAt: now,
      connectionType: "FHB_V3",
      label: false,
    };
    it("FHB: only while the raw status is pending", () => {
      expect(warehouseCancelRefusal(base, now)).toBeNull();
      expect(warehouseCancelRefusal({ ...base, rawStatus: "processing" }, now)).toBe("fhb_not_pending");
      expect(warehouseCancelRefusal({ ...base, rawStatus: "new" }, now)).toBe("fhb_not_pending");
    });
    it("euShipments: New / Information received / Awaiting pickup and within 14 days", () => {
      const eu = { ...base, connectionType: "EUSHIPMENTS" as const };
      expect(warehouseCancelRefusal({ ...eu, rawStatus: "Information received" }, now)).toBeNull();
      expect(warehouseCancelRefusal({ ...eu, rawStatus: "Awaiting pickup" }, now)).toBeNull();
      expect(warehouseCancelRefusal({ ...eu, rawStatus: "Packed" }, now)).toBe("eushipments_not_deletable");
      const old = new Date(now.getTime() - 15 * 24 * 3600_000);
      expect(warehouseCancelRefusal({ ...eu, rawStatus: "New", submittedAt: old }, now)).toBe(
        "eushipments_not_deletable",
      );
    });
    it("not offered for label shipments (FHB Joy / AWB) or a shipment not accepted yet", () => {
      expect(warehouseCancelRefusal({ ...base, connectionType: "FHB_JOY" }, now)).toBe("label");
      expect(warehouseCancelRefusal({ ...base, connectionType: "EUSHIPMENTS", label: true }, now)).toBe(
        "label",
      );
      expect(warehouseCancelRefusal({ ...base, status: "QUEUED" }, now)).toBe(
        "not_at_warehouse_yet_or_locked",
      );
    });
  });

  describe("the button guard (view)", () => {
    it("offered for a cancellable shipment to OWNER/ADMIN only; a short reason otherwise", async () => {
      const { order, fulfillment } = await shipped();
      const v = await warehouseCancelView(admin, order.id);
      expect(v.canCancel).toBe(true);
      expect(v.rows).toEqual([expect.objectContaining({ fulfillmentId: fulfillment.id, refusal: null })]);
      expect((await warehouseCancelView(operator, order.id)).canCancel).toBe(false);
      const packed = await shipped({ raw: "Packed" });
      expect((await warehouseCancelView(g.owner, packed.order.id)).rows[0]!.refusal).toBe(
        "eushipments_not_deletable",
      );
    });
  });

  describe("RBAC, reason, tenant scope", () => {
    it("OPERATOR and VIEWER are refused; a reason is required", async () => {
      const { fulfillment } = await shipped();
      await expect(cancel(fulfillment.id, operator)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(cancel(fulfillment.id, viewer)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(cancel(fulfillment.id, g.owner, null)).rejects.toMatchObject({ code: "reason_required" });
      await expect(
        requestWarehouseCancel(g.owner, {
          fulfillmentId: fulfillment.id,
          reasonCode: "other",
          reasonText: "",
        }),
      ).rejects.toMatchObject({ code: "reason_text_required" });
      expect(await g.db.outboundRequest.count({ where: { fulfillmentId: fulfillment.id } })).toBe(0);
    });

    it("another account or a company outside the actor's scope cannot see or cancel it", async () => {
      const { order, fulfillment } = await shipped();
      await expect(cancel(fulfillment.id, other.owner)).rejects.toMatchObject({ code: "not_found" });
      await expect(warehouseCancelView(other.owner, order.id)).rejects.toMatchObject({ code: "not_found" });
      await expect(
        cancel(fulfillment.id, { ...g.owner, companyScope: ["some-other-company"] }),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(await g.db.outboundRequest.count({ where: { fulfillmentId: fulfillment.id } })).toBe(0);
    });
  });

  describe("LIVE: the vendor confirms → shipment CANCELLED, order BLOCKED", () => {
    it("euShipments: delete through the outbox, info timeline entry, then Изпрати отново works", async () => {
      const { order, fulfillment } = await shipped();
      const r = await cancel(fulfillment.id, admin);
      expect(r.mode).toBe("LIVE");
      const req = await g.db.outboundRequest.findUniqueOrThrow({ where: { id: r.requestId } });
      expect(req).toMatchObject({
        operation: "eushipments.deleteOrder",
        idempotencyKey: `delete:${fulfillment.externalId}`,
      });
      // Nothing changes before the vendor answered.
      expect(await shipStatus(fulfillment.id)).toBe("ACCEPTED");
      expect(await status(order.id)).toBe("ACCEPTED");
      const eu = euVendor();
      expect(await processOutbound(r.requestId, vendors(eu))).toBe("SENT");
      expect(eu.calls).toEqual([`/orders-delete/${fulfillment.externalId}`]);
      expect(await shipStatus(fulfillment.id)).toBe("CANCELLED");
      expect(await status(order.id)).toBe("BLOCKED");
      const info = await g.db.orderEvent.findFirstOrThrow({
        where: { orderId: order.id, cause: "warehouse_cancelled" },
      });
      expect(info.reason).toBe("отказана в склада от O: sent_by_mistake: грешен склад");
      expect(
        await g.db.orderEvent.count({ where: { orderId: order.id, cause: "warehouse_cancel_requested" } }),
      ).toBe(1);
      expect(
        await g.db.auditLog.count({
          where: { entityId: fulfillment.id, action: "order.warehouse_cancel_requested" },
        }),
      ).toBe(1);
      // A late "Deleted" from orders-history never moves the order on to CANCELLED.
      await applyOrderHistory(g.accountId, fulfillment.id, {
        refNum: fulfillment.externalId,
        statusesHistory: [{ ID: 9, STATUS: "Deleted", DATE: "2026-11-03 11:00:00" }],
      } as never);
      expect(await status(order.id)).toBe("BLOCKED");
      await restartOrder(g.owner, order.id);
      expect(await status(order.id)).not.toBe("BLOCKED");
    });

    it("FHB: DELETE /order, the order goes to BLOCKED", async () => {
      const { order, fulfillment } = await shipped({ connectionId: fhb.id });
      const r = await cancel(fulfillment.id);
      const req = await g.db.outboundRequest.findUniqueOrThrow({ where: { id: r.requestId } });
      expect(req.operation).toBe("fhb.order.delete");
      expect(req.payload).toMatchObject({
        id: fulfillment.externalId,
        meta: { warehouseCancel: "1", requestedById: g.owner.userId, reasonCode: "sent_by_mistake" },
      });
      const v = fhbVendor();
      expect(await processOutbound(r.requestId, vendors(euVendor(), v))).toBe("SENT");
      expect(v.calls).toEqual([`DELETE /order ${fulfillment.externalId}`]);
      expect(await shipStatus(fulfillment.id)).toBe("CANCELLED");
      expect(await status(order.id)).toBe("BLOCKED");
    });

    it("euShipments 'Deleted' in orders-history after a CRM delete (answer lost) → BLOCKED, not CANCELLED", async () => {
      const { order, fulfillment } = await shipped();
      const r = await cancel(fulfillment.id);
      await g.db.outboundRequest.update({ where: { id: r.requestId }, data: { status: "UNCERTAIN" } });
      await applyOrderHistory(g.accountId, fulfillment.id, {
        refNum: fulfillment.externalId,
        statusesHistory: [{ ID: 3, STATUS: "Deleted", DATE: "2026-11-03 11:00:00" }],
      } as never);
      expect(await shipStatus(fulfillment.id)).toBe("CANCELLED");
      expect(await status(order.id)).toBe("BLOCKED");
      expect(
        await g.db.orderEvent.count({ where: { orderId: order.id, cause: "warehouse_cancelled" } }),
      ).toBe(1);
    });
  });

  describe("unknown outcome → read-back", () => {
    it("euShipments 503 on orders-delete, orders-history read-back 'Deleted' → CANCELLED / BLOCKED", async () => {
      const { order, fulfillment } = await shipped();
      const r = await cancel(fulfillment.id);
      const eu = euVendor({
        del: () => jsonRes({ error: "busy" }, 503),
        history: (refNum) => ({
          refNum,
          statusesHistory: [
            { ID: 1, STATUS: "Information received", DATE: "2026-11-03 10:00:00" },
            { ID: 2, STATUS: "Deleted", DATE: "2026-11-03 11:00:00" },
          ],
        }),
      });
      expect(await processOutbound(r.requestId, vendors(eu))).toBe("SENT");
      expect(eu.calls).toEqual([`/orders-delete/${fulfillment.externalId}`, "/fulfilment/orders-history"]);
      expect(await shipStatus(fulfillment.id)).toBe("CANCELLED");
      expect(await status(order.id)).toBe("BLOCKED");
      const info = await g.db.orderEvent.findFirstOrThrow({
        where: { orderId: order.id, cause: "warehouse_cancelled" },
      });
      expect(info.reason).toBe("отказана в склада от O: sent_by_mistake: грешен склад");
    });

    it("FHB DELETE network error, GET /order 404 on read-back → shipment CANCELLED, order BLOCKED", async () => {
      const { order, fulfillment } = await shipped({ connectionId: fhb.id });
      const r = await cancel(fulfillment.id);
      const v = fhbVendor({ deleteDropped: true });
      expect(await processOutbound(r.requestId, vendors(euVendor(), v))).toBe("SENT");
      expect(v.calls).toEqual([
        `DELETE /order ${fulfillment.externalId}`,
        `GET /order ${fulfillment.externalId}`,
      ]);
      expect(await shipStatus(fulfillment.id)).toBe("CANCELLED");
      expect(await status(order.id)).toBe("BLOCKED");
      expect(
        await g.db.orderEvent.count({ where: { orderId: order.id, cause: "warehouse_cancelled" } }),
      ).toBe(1);
    });
  });

  describe("CANARY: waits for an explicit confirmation", () => {
    it("AWAITING_CONFIRMATION, button hidden; only confirmCanary lets the sender call the vendor", async () => {
      const { order, fulfillment } = await shipped();
      await setMode(g.connection.id, "CANARY");
      try {
        const r = await cancel(fulfillment.id);
        expect(r.mode).toBe("CANARY");
        const eu = euVendor();
        expect(await processOutbound(r.requestId, vendors(eu))).toBe("AWAITING_CONFIRMATION");
        expect(eu.calls).toEqual([]);
        expect(await status(order.id)).toBe("ACCEPTED");
        const row = (await warehouseCancelView(g.owner, order.id)).rows[0]!;
        expect(row.request?.status).toBe("AWAITING_CONFIRMATION");
        expect(row.refusal).toBe("already_requested");
        await confirmCanary(g.owner, r.requestId);
        expect(await processOutbound(r.requestId, vendors(eu))).toBe("SENT");
        expect(eu.calls).toEqual([`/orders-delete/${fulfillment.externalId}`]);
        expect(await status(order.id)).toBe("BLOCKED");
      } finally {
        await setMode(g.connection.id, "LIVE");
      }
    });
  });

  describe("a deletion outside the CRM after a cancel that never left it", () => {
    const vendorAlerts = (fulfillmentId: string) =>
      g.db.alert.count({ where: { kind: "eushipments_cancelled_at_vendor", entityId: fulfillmentId } });

    for (const mode of ["DRY_RUN", "READ_ONLY"] as const)
      it(`${mode} request, then history 'Deleted' → CRITICAL cabinet task, no attribution to the requester`, async () => {
        const { order, fulfillment } = await shipped();
        await setMode(g.connection.id, mode);
        try {
          const r = await cancel(fulfillment.id);
          expect(await processOutbound(r.requestId, vendors(euVendor()))).toBe(
            mode === "DRY_RUN" ? "DRY_RUN_RECORDED" : "REFUSED",
          );
        } finally {
          await setMode(g.connection.id, "LIVE");
        }
        await applyOrderHistory(g.accountId, fulfillment.id, {
          refNum: fulfillment.externalId,
          statusesHistory: [{ ID: 4, STATUS: "Deleted", DATE: "2026-11-03 11:00:00" }],
        } as never);
        expect(await shipStatus(fulfillment.id)).toBe("CANCELLED");
        expect(await status(order.id)).toBe("BLOCKED");
        expect(await vendorAlerts(fulfillment.id)).toBe(1);
        expect(
          await g.db.orderEvent.count({ where: { orderId: order.id, cause: "warehouse_cancelled" } }),
        ).toBe(0);
      });

    it("a vendor-refused (FAILED) request, then 'not found' twice → CRITICAL cabinet task", async () => {
      const { order, fulfillment } = await shipped();
      const r = await cancel(fulfillment.id);
      const refusing = vendors(euVendor({ del: () => jsonRes({ error: "Order cannot be deleted" }) }));
      expect(await processOutbound(r.requestId, refusing)).toBe("FAILED");
      expect(await markGoneAtVendor(g.accountId, fulfillment.id)).toBe(true);
      expect(await status(order.id)).toBe("BLOCKED");
      expect(await vendorAlerts(fulfillment.id)).toBe(1);
      expect(
        await g.db.orderEvent.count({ where: { orderId: order.id, cause: "warehouse_cancelled" } }),
      ).toBe(0);
    });

    it("a request that left the CRM (answer lost), then 'not found' twice → BLOCKED with attribution, no task", async () => {
      const { order, fulfillment } = await shipped();
      const r = await cancel(fulfillment.id);
      await g.db.outboundRequest.update({ where: { id: r.requestId }, data: { status: "UNCERTAIN" } });
      expect(await markGoneAtVendor(g.accountId, fulfillment.id)).toBe(true);
      expect(await shipStatus(fulfillment.id)).toBe("CANCELLED");
      expect(await status(order.id)).toBe("BLOCKED");
      expect(await vendorAlerts(fulfillment.id)).toBe(0);
      const info = await g.db.orderEvent.findFirstOrThrow({
        where: { orderId: order.id, cause: "warehouse_cancelled" },
      });
      expect(info.reason).toBe("отказана в склада от O: sent_by_mistake: грешен склад");
    });
  });

  describe("euShipments 401 on the delete is not a warehouse refusal", () => {
    it("FAILED 'unauthenticated', no refusal task, shipment unchanged", async () => {
      const { order, fulfillment } = await shipped();
      const r = await cancel(fulfillment.id);
      const unauth = vendors(euVendor({ del: () => jsonRes({ message: "Unauthenticated." }, 401) }));
      expect(await processOutbound(r.requestId, unauth)).toBe("FAILED");
      const row = await g.db.outboundRequest.findUniqueOrThrow({ where: { id: r.requestId } });
      expect(row.lastError).toBe("unauthenticated");
      expect(await shipStatus(fulfillment.id)).toBe("ACCEPTED");
      expect(
        await g.db.alert.count({ where: { entityId: order.id, kind: "warehouse_cancel_refused" } }),
      ).toBe(0);
    });
  });

  describe("DRY_RUN / READ_ONLY: only recorded", () => {
    it("DRY_RUN records what would be sent; nothing reaches the vendor, nothing changes; may be re-requested", async () => {
      const { order, fulfillment } = await shipped();
      await setMode(g.connection.id, "DRY_RUN");
      try {
        const r = await cancel(fulfillment.id);
        const eu = euVendor();
        expect(await processOutbound(r.requestId, vendors(eu))).toBe("DRY_RUN_RECORDED");
        expect(eu.calls).toEqual([]);
        expect(await shipStatus(fulfillment.id)).toBe("ACCEPTED");
        expect(await status(order.id)).toBe("ACCEPTED");
        const row = (await warehouseCancelView(g.owner, order.id)).rows[0]!;
        expect(row.request?.status).toBe("DRY_RUN_RECORDED");
        expect(row.refusal).toBeNull();
        // In LIVE the same request is re-armed (one row, one key) and then really sent.
        await setMode(g.connection.id, "LIVE");
        const again = await cancel(fulfillment.id);
        expect(again.requestId).toBe(r.requestId);
        expect(await processOutbound(again.requestId, vendors(eu))).toBe("SENT");
        expect(await status(order.id)).toBe("BLOCKED");
      } finally {
        await setMode(g.connection.id, "LIVE");
      }
    });

    it("READ_ONLY refuses in the sender", async () => {
      const { order, fulfillment } = await shipped();
      await setMode(g.connection.id, "READ_ONLY");
      try {
        const r = await cancel(fulfillment.id);
        const eu = euVendor();
        expect(await processOutbound(r.requestId, vendors(eu))).toBe("REFUSED");
        expect(eu.calls).toEqual([]);
        expect(await status(order.id)).toBe("ACCEPTED");
        expect((await warehouseCancelView(g.owner, order.id)).rows[0]!.request).toMatchObject({
          status: "REFUSED",
          lastError: "read_only",
        });
      } finally {
        await setMode(g.connection.id, "LIVE");
      }
    });
  });

  describe("vendor refusal", () => {
    it("euShipments refuses: the shipment stays, a task says so", async () => {
      const { order, fulfillment } = await shipped();
      const r = await cancel(fulfillment.id);
      const refusing = vendors(euVendor({ del: () => jsonRes({ error: "Order cannot be deleted" }) }));
      expect(await processOutbound(r.requestId, refusing)).toBe("FAILED");
      expect(await shipStatus(fulfillment.id)).toBe("ACCEPTED");
      expect(await status(order.id)).toBe("ACCEPTED");
      const task = await g.db.alert.findFirstOrThrow({
        where: { entityId: order.id, kind: "warehouse_cancel_refused" },
      });
      expect(task.isTask).toBe(true);
    });

    it("FHB refuses (no longer pending): the shipment stays, a task says so", async () => {
      const { order, fulfillment } = await shipped({ connectionId: fhb.id });
      const r = await cancel(fulfillment.id);
      expect(await processOutbound(r.requestId, vendors(euVendor(), fhbVendor({ refuse: true })))).toBe(
        "FAILED",
      );
      expect(await shipStatus(fulfillment.id)).toBe("ACCEPTED");
      expect(await status(order.id)).toBe("ACCEPTED");
      expect(
        await g.db.alert.count({ where: { entityId: order.id, kind: "warehouse_cancel_refused" } }),
      ).toBe(1);
    });
  });

  describe("double click / concurrent cancel", () => {
    it("two requests at once → one outbox request; the second is told it is already requested", async () => {
      const { fulfillment } = await shipped();
      const both = await Promise.allSettled([cancel(fulfillment.id), cancel(fulfillment.id)]);
      expect(both.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      const failed = both.find((x) => x.status === "rejected") as PromiseRejectedResult;
      expect(failed.reason).toMatchObject({ code: "already_requested" });
      expect(await g.db.outboundRequest.count({ where: { fulfillmentId: fulfillment.id } })).toBe(1);
      expect(
        (
          await warehouseCancelView(
            g.owner,
            (await g.db.fulfillment.findUniqueOrThrow({ where: { id: fulfillment.id } })).orderId,
          )
        ).rows[0]!.refusal,
      ).toBe("already_requested");
    });
  });

  describe("a reroute owns the shipment", () => {
    it("refused while a reroute is open, and a confirmation never moves the order", async () => {
      const { order, fulfillment } = await shipped();
      await g.db.orderReroute.create({
        data: {
          accountId: g.accountId,
          orderId: order.id,
          fromFulfillmentId: fulfillment.id,
          fromConnectionId: g.connection.id,
          toConnectionId: fhb.id,
          reasonCode: "no_stock",
          requestedById: g.owner.userId,
        },
      });
      await expect(cancel(fulfillment.id)).rejects.toMatchObject({ code: "reroute_open" });
      expect((await warehouseCancelView(g.owner, order.id)).rows[0]!.refusal).toBe("reroute_open");
      const moved = await withAccountTransaction(g.accountId, (tx) =>
        warehouseCancelConfirmed(tx, {
          accountId: g.accountId,
          orderId: order.id,
          fulfillmentId: fulfillment.id,
          source: "test",
        }),
      );
      expect(moved).toBe(false);
      expect(await status(order.id)).toBe("ACCEPTED");
    });
  });

  describe("Откажи поръчката (cancel the order itself from BLOCKED)", () => {
    const block = (orderId: string) =>
      decideOrder(g.owner, {
        orderId,
        decision: "block",
        reasonCode: "customer_cancelled",
        reasonText: null,
        openedAt: null,
      });

    it("refused while a shipment is active; allowed once it is cancelled, with the Shopify task", async () => {
      const { order, fulfillment } = await shipped();
      await g.db.order.update({ where: { id: order.id }, data: { status: "BLOCKED" } });
      await expect(block(order.id)).rejects.toMatchObject({ code: "transition_guard:active_shipment" });
      await g.db.fulfillment.update({ where: { id: fulfillment.id }, data: { status: "CANCELLED" } });
      const r = await block(order.id);
      expect(r).toMatchObject({ status: "CANCELLED", from: "BLOCKED" });
      expect(await status(order.id)).toBe("CANCELLED");
      expect(await g.db.alert.count({ where: { entityId: order.id, kind: BLOCKED_TASK_KIND } })).toBe(1);
    });

    it("refused while a vendor write of the order is still on its way or uncertain", async () => {
      const { order, fulfillment } = await shipped();
      const r = await cancel(fulfillment.id);
      await g.db.fulfillment.update({ where: { id: fulfillment.id }, data: { status: "CANCELLED" } });
      await g.db.outboundRequest.update({ where: { id: r.requestId }, data: { status: "UNCERTAIN" } });
      await g.db.order.update({ where: { id: order.id }, data: { status: "EXCEPTION" } });
      await expect(block(order.id)).rejects.toMatchObject({ code: "transition_guard:vendor_request_open" });
      expect(await status(order.id)).toBe("EXCEPTION");
    });

    it("an operator may cancel (orders.review); a viewer may not", async () => {
      const { order, fulfillment } = await shipped();
      await g.db.fulfillment.update({ where: { id: fulfillment.id }, data: { status: "CANCELLED" } });
      await g.db.order.update({ where: { id: order.id }, data: { status: "UNKNOWN" } });
      await expect(
        decideOrder(viewer, { orderId: order.id, decision: "block", reasonCode: "customer_cancelled" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await decideOrder(operator, { orderId: order.id, decision: "block", reasonCode: "customer_cancelled" });
      expect(await status(order.id)).toBe("CANCELLED");
    });
  });
});
