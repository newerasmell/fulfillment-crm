import { beforeAll, describe, expect, it } from "vitest";
import { checkOrder } from "@/server/checks";
import { systemDb } from "@/server/db/client";
import { euTestGroup } from "@/server/eushipments/test-fixtures";
import { createFhbConnection } from "@/server/fhb/connection";
import { transitionOrder } from "@/server/pipeline";
import type { ScopedActor } from "@/server/stores";
import {
  canaryView,
  confirmFulfillCanary,
  createFulfillBatch,
  fulfillOrder,
  getFulfillBatch,
  retryFulfillItem,
  runFulfillBatch,
  STALE_RUNNING_MS,
} from "./index";

// FHB POST /order has no test flag: every send would be a real order. Nothing is sent here (the outbox sender
// is never run); synthetic data only.

describe("Fulfill at FHB (P4-06)", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  let fhbId: string;
  let operator: ScopedActor;
  let n = 6000;
  const sys = () => systemDb();

  const setMode = (liveMode: "READ_ONLY" | "DRY_RUN" | "CANARY" | "LIVE", id = fhbId) =>
    sys().fulfillmentConnection.update({ where: { id }, data: { liveMode } });

  async function approved(opts: { connectionId?: string } = {}) {
    const connectionId = opts.connectionId ?? fhbId;
    const num = ++n;
    const product = await sys().product.create({
      data: { accountId: g.accountId, sku: `FSKU-${num}`, name: "Sample Perfume 50ml" },
    });
    await sys().productEan.create({
      data: { accountId: g.accountId, productId: product.id, ean: "0000000000017" },
    });
    for (const cid of [fhbId, g.connection.id]) {
      const vp = await sys().vendorProduct.create({
        data: {
          accountId: g.accountId,
          connectionId: cid,
          productId: product.id,
          vendorId: `RFSKU-${num}-${cid.slice(-4)}`,
          lastSyncAt: new Date(),
          raw: { id: `RFSKU-${num}`, type: "single" },
        },
      });
      await sys().stockLevel.create({
        data: {
          accountId: g.accountId,
          vendorProductId: vp.id,
          physical: 50,
          free: 50,
          sellable: 50,
          snapshotAt: new Date(),
          source: "POLL",
        },
      });
    }
    const order = await sys().order.create({
      data: {
        accountId: g.accountId,
        companyId: g.company.id,
        source: "SHOPIFY",
        storeId: g.store.id,
        number: `#${num}`,
        email: "buyer@example.com",
        phone: "0900 000 000",
        customerName: "Test Buyer",
        shippingAddress: {
          name: "Test Buyer",
          address1: "Example street 1",
          city: "Testville",
          zip: "00000",
          countryCode: "SK",
        },
        countryCode: "SK",
        currency: "EUR",
        subtotal: "40.00",
        total: "40.00",
        paymentMethod: "PREPAID",
        placedAt: new Date(),
        status: "IMPORTED",
        lines: {
          create: [
            { productId: product.id, sku: product.sku, title: "Sample", quantity: 2, unitPrice: "20.00" },
          ],
        },
      },
    });
    const c = await checkOrder(g.accountId, order.id, { actor: { kind: "system" }, connectionId });
    expect(c.findings.filter((f) => f.severity === "hard")).toEqual([]);
    await transitionOrder(g.accountId, {
      orderId: order.id,
      to: "APPROVED",
      cause: "approve",
      actor: { kind: "user", userId: g.owner.userId },
      meta: { connectionId },
    });
    return { order, product };
  }
  const counts = async (orderId: string) => ({
    fulfillments: await sys().fulfillment.count({ where: { orderId } }),
    requests: await sys().outboundRequest.count({ where: { fulfillment: { orderId } } }),
  });
  const requestOf = (orderId: string) =>
    sys().outboundRequest.findFirstOrThrow({ where: { fulfillment: { orderId } } });

  beforeAll(async () => {
    process.env.APP_URL = "https://crm.example.test";
    g = await euTestGroup("fulfill-fhb");
    await sys().store.update({ where: { id: g.store.id }, data: { countries: ["SK"] } });
    await sys().countrySetting.create({ data: { accountId: g.accountId, country: "SK", currency: "EUR" } });
    const c = await createFhbConnection(g.owner, {
      companyId: g.company.id,
      name: "FHB test",
      appId: "test-app",
      secret: "test-secret",
      skuPrefix: "R",
    });
    fhbId = c.id;
    await setMode("LIVE");
    // A second, separate operator (its own user and membership).
    const u = await sys().user.create({
      data: { email: `op2-${Date.now()}@example.com`, name: "Op 2", passwordHash: "x" },
    });
    await sys().membership.create({ data: { accountId: g.accountId, userId: u.id, role: "OPERATOR" } });
    operator = { userId: u.id, accountId: g.accountId, role: "OPERATOR", companyScope: null };
  });

  it("two operators and a double click at once: exactly one Fulfillment and one request", async () => {
    const { order } = await approved();
    const rs = await Promise.all([
      fulfillOrder(g.owner, order.id),
      fulfillOrder(operator, order.id),
      fulfillOrder(g.owner, order.id),
    ]);
    expect(rs.filter((r) => r.status === "QUEUED")).toHaveLength(1);
    expect(rs.filter((r) => r.status !== "QUEUED").map((r) => [r.status, r.code])).toEqual([
      ["SKIPPED", "already_submitted"],
      ["SKIPPED", "already_submitted"],
    ]);
    expect(await counts(order.id)).toEqual({ fulfillments: 1, requests: 1 });
    expect((await requestOf(order.id)).operation).toBe("fhb.order.create");
  });

  it("bulk and single on the same order at once: one shipment, one request", async () => {
    const { order } = await approved();
    const batch = await createFulfillBatch(operator, [order.id]);
    const [single] = await Promise.all([
      fulfillOrder(g.owner, order.id),
      runFulfillBatch(operator, batch.id),
    ]);
    const view = await getFulfillBatch(operator, batch.id);
    expect([single.status, view.rows[0]!.status].sort()).toEqual(["QUEUED", "SKIPPED"]);
    expect(await counts(order.id)).toEqual({ fulfillments: 1, requests: 1 });
  });

  it("SUBMIT_FAILED: Fulfill again re-arms the SAME request with the same externalId and variable symbol", async () => {
    const { order } = await approved();
    const first = await fulfillOrder(g.owner, order.id);
    expect(first.status).toBe("QUEUED");
    const f0 = await sys().fulfillment.findFirstOrThrow({ where: { orderId: order.id } });
    // The vendor refused it definitively (as the outbox + status map record it).
    await sys().outboundRequest.update({
      where: { id: first.requestId! },
      data: { status: "FAILED", lastError: "HTTP 400" },
    });
    await sys().fulfillment.update({ where: { id: f0.id }, data: { status: "SUBMIT_FAILED" } });
    await sys().order.update({ where: { id: order.id }, data: { status: "SUBMIT_FAILED" } });
    const again = await fulfillOrder(operator, order.id);
    expect(again).toMatchObject({ status: "QUEUED", requestId: first.requestId });
    const f1 = await sys().fulfillment.findFirstOrThrow({ where: { orderId: order.id } });
    expect([f1.id, f1.externalId, f1.variableSymbol]).toEqual([f0.id, f0.externalId, f0.variableSymbol]);
    expect((await requestOf(order.id)).status).toBe("PENDING");
    expect(await counts(order.id)).toEqual({ fulfillments: 1, requests: 1 });
  });

  it("QUEUED: re-arms a DRY_RUN_RECORDED / REFUSED request; PENDING, SENDING, SENT, UNCERTAIN are left alone", async () => {
    for (const rearmable of ["DRY_RUN_RECORDED", "REFUSED"] as const) {
      const { order } = await approved();
      const first = await fulfillOrder(g.owner, order.id);
      await sys().outboundRequest.update({ where: { id: first.requestId! }, data: { status: rearmable } });
      const again = await fulfillOrder(g.owner, order.id);
      expect(again).toMatchObject({ status: "QUEUED", requestId: first.requestId });
      expect((await requestOf(order.id)).status).toBe("PENDING");
      expect(await counts(order.id)).toEqual({ fulfillments: 1, requests: 1 });
    }
    for (const live of ["PENDING", "SENDING", "SENT", "UNCERTAIN"] as const) {
      const { order } = await approved();
      const first = await fulfillOrder(g.owner, order.id);
      await sys().outboundRequest.update({ where: { id: first.requestId! }, data: { status: live } });
      const before = await requestOf(order.id);
      expect(await fulfillOrder(operator, order.id)).toMatchObject({
        status: "SKIPPED",
        code: "already_submitted",
      });
      const after = await requestOf(order.id);
      expect(after.status).toBe(live);
      expect(after.updatedAt).toEqual(before.updatedAt); // nothing re-armed
      expect(await counts(order.id)).toEqual({ fulfillments: 1, requests: 1 });
    }
  });

  it("NEEDS_ACK without acknowledgement; QUEUED only with the codes that were shown", async () => {
    const { order, product } = await approved();
    // Stock snapshot older than the 1 h limit: a soft "stale stock" warning at send time.
    await sys().stockLevel.updateMany({
      where: { vendorProduct: { connectionId: fhbId, productId: product.id } },
      data: { snapshotAt: new Date(Date.now() - 3 * 3600_000) },
    });
    const r = await fulfillOrder(g.owner, order.id);
    expect(r.status).toBe("NEEDS_ACK");
    expect(r.findings.length).toBeGreaterThan(0);
    expect(await counts(order.id)).toEqual({ fulfillments: 0, requests: 0 });
    // Acknowledging something else is not enough.
    expect((await fulfillOrder(g.owner, order.id, { acknowledgedCodes: ["unrelated"] })).status).toBe(
      "NEEDS_ACK",
    );
    const ok = await fulfillOrder(g.owner, order.id, { acknowledgedCodes: r.findings.map((f) => f.code) });
    expect(ok.status).toBe("QUEUED");
    expect(await counts(order.id)).toEqual({ fulfillments: 1, requests: 1 });
  });

  it("a warning that appears between NEEDS_ACK and the acknowledgement is shown first, never sent unseen", async () => {
    const { order, product } = await approved();
    await sys().stockLevel.updateMany({
      where: { vendorProduct: { connectionId: fhbId, productId: product.id } },
      data: { snapshotAt: new Date(Date.now() - 3 * 3600_000) },
    });
    const batch = await createFulfillBatch(g.owner, [order.id]);
    await runFulfillBatch(g.owner, batch.id);
    const v1 = await getFulfillBatch(g.owner, batch.id);
    expect(v1.rows[0]!.status).toBe("NEEDS_ACK");
    const shown = v1.rows[0]!.findings.map((f) => f.code);
    // W2 appears meanwhile: the order now carries a customer note (another soft finding).
    await sys().order.update({ where: { id: order.id }, data: { note: "Please call before delivery" } });
    await retryFulfillItem(g.owner, batch.id, v1.rows[0]!.id, { acknowledgedCodes: shown });
    const v2 = await getFulfillBatch(g.owner, batch.id);
    // The note is not part of the approval fingerprint: the approval stays valid, the new warning is shown.
    expect(v2.rows[0]!.status).toBe("NEEDS_ACK");
    expect(await counts(order.id)).toEqual({ fulfillments: 0, requests: 0 });
    const codes = v2.rows[0]!.findings.map((f) => f.code);
    expect(codes).toContain("fhb.order.customer_note");
    expect(shown).not.toContain("fhb.order.customer_note");
    // Acknowledging what is shown now sends it.
    await retryFulfillItem(g.owner, batch.id, v2.rows[0]!.id, { acknowledgedCodes: codes });
    expect((await getFulfillBatch(g.owner, batch.id)).rows[0]!.status).toBe("QUEUED");
    expect(await counts(order.id)).toEqual({ fulfillments: 1, requests: 1 });
  });

  it("acknowledged codes come from the STORED item, not the client: a forged code does not count", async () => {
    const { order, product } = await approved();
    await sys().stockLevel.updateMany({
      where: { vendorProduct: { connectionId: fhbId, productId: product.id } },
      data: { snapshotAt: new Date(Date.now() - 3 * 3600_000) },
    });
    const batch = await createFulfillBatch(g.owner, [order.id]);
    await runFulfillBatch(g.owner, batch.id);
    const row = (await getFulfillBatch(g.owner, batch.id)).rows[0]!;
    expect(row.status).toBe("NEEDS_ACK");
    // Retry without acknowledging: still NEEDS_ACK, nothing queued.
    await retryFulfillItem(g.owner, batch.id, row.id, { acknowledgedCodes: ["fhb.something_else"] });
    expect((await getFulfillBatch(g.owner, batch.id)).rows[0]!.status).toBe("NEEDS_ACK");
    expect(await counts(order.id)).toEqual({ fulfillments: 0, requests: 0 });
    // Wrong batch id: not found.
    const other = await createFulfillBatch(g.owner, [(await approved()).order.id]);
    await expect(
      retryFulfillItem(g.owner, other.id, row.id, { acknowledgedCodes: row.findings.map((f) => f.code) }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("a stale RUNNING item is picked again without creating a second request", async () => {
    const { order } = await approved();
    const batch = await createFulfillBatch(g.owner, [order.id]);
    // The first run queued it, then the request crashed before the item result was written.
    expect((await fulfillOrder(g.owner, order.id)).status).toBe("QUEUED");
    const item = await sys().fulfillBatchItem.findFirstOrThrow({ where: { batchId: batch.id } });
    const startedAt = new Date(Date.now() - STALE_RUNNING_MS - 60_000);
    await sys().fulfillBatchItem.update({ where: { id: item.id }, data: { status: "RUNNING", startedAt } });
    // Not stale yet from the point of view of a run 1 minute after it started: left alone.
    expect(await runFulfillBatch(g.owner, batch.id, 5, new Date(startedAt.getTime() + 60_000))).toEqual({
      waiting: 1,
    });
    expect(await runFulfillBatch(g.owner, batch.id)).toEqual({ waiting: 0 });
    const view = await getFulfillBatch(g.owner, batch.id);
    expect(view.rows[0]).toMatchObject({ status: "SKIPPED", code: "already_submitted" });
    expect(await counts(order.id)).toEqual({ fulfillments: 1, requests: 1 });
  });

  it("a BLOCKED item is retried once the block is gone; FHB pre-flight hard findings block", async () => {
    const { order, product } = await approved();
    await sys().stockLevel.updateMany({
      where: { vendorProduct: { connectionId: fhbId, productId: product.id } },
      data: { free: 0, sellable: 0 },
    });
    const batch = await createFulfillBatch(g.owner, [order.id]);
    await runFulfillBatch(g.owner, batch.id);
    const row = (await getFulfillBatch(g.owner, batch.id)).rows[0]!;
    expect(row.status).toBe("BLOCKED");
    expect(await counts(order.id)).toEqual({ fulfillments: 0, requests: 0 });
    await sys().stockLevel.updateMany({
      where: { vendorProduct: { connectionId: fhbId, productId: product.id } },
      data: { free: 50, sellable: 50 },
    });
    await retryFulfillItem(g.owner, batch.id, row.id);
    expect((await getFulfillBatch(g.owner, batch.id)).rows[0]!.status).toBe("QUEUED");
    expect(await counts(order.id)).toEqual({ fulfillments: 1, requests: 1 });
  });

  it("a leftover QUEUED shipment at another warehouse blocks with connection_mismatch (never sent there)", async () => {
    const { order } = await approved();
    await sys().fulfillment.create({
      data: {
        accountId: g.accountId,
        orderId: order.id,
        connectionId: g.connection.id,
        externalId: `LEFTOVER-${n}`,
        status: "QUEUED",
      },
    });
    const r = await fulfillOrder(g.owner, order.id);
    expect(r).toMatchObject({ status: "BLOCKED", code: "connection_mismatch", connectionId: fhbId });
    expect(await sys().outboundRequest.count({ where: { fulfillment: { orderId: order.id } } })).toBe(0);
  });

  it("routing changed since approval (now another warehouse): NEEDS_ACK routing.changed naming both", async () => {
    // A rule that routes SK to FHB with a parcel service: the approval saw FHB + that carrier.
    const rule = await sys().routingRule.create({
      data: {
        accountId: g.accountId,
        name: "SK to FHB",
        priority: 1,
        match: { countries: ["SK"] },
        connectionId: fhbId,
        parcelService: "test-service",
      },
    });
    try {
      const { order } = await approved();
      const check = await sys().orderCheck.findFirstOrThrow({ where: { orderId: order.id } });
      expect((check.routing as { connectionId: string }).connectionId).toBe(fhbId);
      // Now the rule points at the euShipments warehouse.
      await sys().routingRule.update({ where: { id: rule.id }, data: { connectionId: g.connection.id } });
      const r = await fulfillOrder(g.owner, order.id);
      expect(r.status).toBe("NEEDS_ACK");
      const f = r.findings.find((x) => x.code === "routing.changed");
      expect(f?.message_en).toContain("FHB test");
      expect(f?.message_en).toContain("euShipments test");
      expect(f?.message_en).toContain("test-service");
      expect(await counts(order.id)).toEqual({ fulfillments: 0, requests: 0 });
      // Acknowledged: goes to the APPROVED warehouse (FHB), without the dropped carrier.
      const ok = await fulfillOrder(g.owner, order.id, { acknowledgedCodes: r.findings.map((x) => x.code) });
      expect(ok).toMatchObject({ status: "QUEUED", connectionId: fhbId });
      const sh = await sys().fulfillment.findFirstOrThrow({ where: { orderId: order.id } });
      expect(sh.carrier).toBeNull();
    } finally {
      await sys().routingRule.delete({ where: { id: rule.id } });
    }
  });

  it("CANARY: a request re-armed after the dialog opened is not confirmed by the stale click", async () => {
    await setMode("CANARY");
    try {
      const { order } = await approved();
      const r = await fulfillOrder(g.owner, order.id);
      expect(r).toMatchObject({ status: "QUEUED", liveMode: "CANARY" });
      const view = await canaryView(g.owner, r.requestId!);
      // Meanwhile: dry run recorded, then re-armed by another Fulfill with a different payload.
      await sys().outboundRequest.update({
        where: { id: r.requestId! },
        data: { status: "DRY_RUN_RECORDED" },
      });
      const stored = await requestOf(order.id);
      await sys().outboundRequest.update({
        where: { id: stored.id },
        data: {
          status: "PENDING",
          payload: { ...(stored.payload as object), changed: true },
          confirmedAt: null,
        },
      });
      await expect(confirmFulfillCanary(g.owner, r.requestId!, view.payloadHash)).rejects.toMatchObject({
        code: "not_confirmable",
      });
      expect((await requestOf(order.id)).confirmedAt).toBeNull();
      // A fresh view of the new payload can be confirmed.
      const fresh = await canaryView(g.owner, r.requestId!);
      expect(fresh.payloadHash).not.toBe(view.payloadHash);
      await confirmFulfillCanary(operator, r.requestId!, fresh.payloadHash);
      expect((await requestOf(order.id)).confirmedById).toBe(operator.userId);
    } finally {
      await setMode("LIVE");
    }
  });

  it("a restricted member cannot run or retry items of orders outside their companies", async () => {
    const { order } = await approved();
    const batch = await createFulfillBatch(g.owner, [order.id]);
    const restricted: ScopedActor = { ...operator, companyScope: ["another-company"] };
    expect(await runFulfillBatch(restricted, batch.id)).toEqual({ waiting: 1 });
    const item = await sys().fulfillBatchItem.findFirstOrThrow({ where: { batchId: batch.id } });
    expect(item.status).toBe("PENDING");
    await sys().fulfillBatchItem.update({ where: { id: item.id }, data: { status: "BLOCKED" } });
    await expect(retryFulfillItem(restricted, batch.id, item.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await counts(order.id)).toEqual({ fulfillments: 0, requests: 0 });
  });
});
