import { beforeAll, describe, expect, it, vi } from "vitest";
import { EU_OPS, EuShipmentsTransport } from "@/integrations/eushipments/adapter";
import { EuShipmentsClient } from "@/integrations/eushipments/client";
import R from "@/integrations/eushipments/__fixtures__/responses.json";
import { DomainError } from "@/server/accounts";
import { accountDb, systemDb } from "@/server/db/client";
import { processOutbound } from "@/server/outbox/outbox";
import { euTestGroup, euTestOrder } from "./test-fixtures";
import { euShipmentsTransportFor } from "./transport";
import {
  queueEuBooking,
  queueEuOrder,
  queueEuOrderDeletion,
  queueEuProduct,
  queueEuTransfer,
  referenceFor,
} from "./write";

// Mocked euShipments only — tests never call the vendor (CLAUDE.md).
type Handler = (path: string, body: Record<string, unknown> | undefined) => Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const timeout = () => {
  throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
};
const notFound = (ref: string) => ({
  refNum: ref,
  awb: null,
  error: "Not found order with specified reference number!",
  errorCode: 404,
  statusesHistory: [],
  items: [],
});
const found = (ref: string, status = "Information received") => ({
  refNum: ref,
  awb: null,
  error: null,
  errorCode: null,
  statusesHistory: [{ ID: 1, STATUS: status, DATE: "2026-11-02 10:00:00", DATE_CREATED: null }],
  items: [],
});

function vendor(routes: Record<string, Handler>) {
  const calls: { path: string; body: Record<string, unknown> | undefined }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.replace("/api/v1", "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ path, body });
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    if (!key) throw new Error(`unexpected call ${path}`);
    return routes[key]!(path, body);
  });
  const resolve = (c: { id: string; type: string }) =>
    euShipmentsTransportFor(c, { fetchImpl, sleep: async () => {} });
  const count = (p: string) => calls.filter((c) => c.path.startsWith(p)).length;
  return { calls, resolve, count };
}

const PDF = Buffer.from("%PDF-1.4 synthetic test file").toString("base64");

describe("euShipments write side through the outbox (DB)", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  const mapProduct = (productId: string, refNumber: string) =>
    g.db.vendorProduct.create({
      data: { accountId: g.accountId, connectionId: g.connection.id, productId, vendorId: refNumber },
    });
  const request = (id: string) => systemDb().outboundRequest.findUniqueOrThrow({ where: { id } });
  const setMode = (liveMode: "READ_ONLY" | "DRY_RUN" | "CANARY" | "LIVE") =>
    g.db.fulfillmentConnection.update({ where: { id: g.connection.id }, data: { liveMode } });

  beforeAll(async () => {
    g = await euTestGroup("write");
  });

  it("reference is {STORECODE}-{number}", () => {
    expect(referenceFor({ number: "#1001" }, "TST")).toBe("TST-1001");
    expect(referenceFor({ number: "77" }, null)).toBe("M-77");
  });

  it("blocks an order whose product has no euShipments mapping; nothing is queued", async () => {
    const { order } = await euTestOrder(g, { number: "#900" });
    const r = await queueEuOrder(g.owner, { orderId: order.id, connectionId: g.connection.id });
    expect(r.status).toBe("blocked");
    expect(r.findings.map((f) => f.code)).toContain("product_not_mapped");
    expect(await g.db.fulfillment.count({ where: { orderId: order.id } })).toBe(0);
    expect(await g.db.outboundRequest.count({ where: { idempotencyKey: "order:TST-900" } })).toBe(0);
  });

  it("warnings need an acknowledgement before queueing", async () => {
    const { order, product } = await euTestOrder(g, { number: "#901" });
    await mapProduct(product.id, `ref-${product.sku}`);
    await g.db.order.update({
      where: { id: order.id },
      data: {
        shippingAddress: {
          name: "Test Buyer",
          address1: "Example Street",
          city: "Sofia",
          zip: "1000",
          countryCode: "BG",
        },
      },
    });
    const r = await queueEuOrder(g.owner, { orderId: order.id, connectionId: g.connection.id });
    expect(r).toMatchObject({
      status: "needs_ack",
      findings: [expect.objectContaining({ code: "street_without_number" })],
    });
    const ok = await queueEuOrder(g.owner, {
      orderId: order.id,
      connectionId: g.connection.id,
      acknowledged: ["street_without_number"],
    });
    expect(ok.status).toBe("queued");
  });

  it("queues once, sends once, stores the vendor orderId and attaches the invoice right after", async () => {
    const { order, product } = await euTestOrder(g, { number: "#1001" });
    await mapProduct(product.id, `ref-${product.sku}`);
    const q = await queueEuOrder(g.owner, {
      orderId: order.id,
      connectionId: g.connection.id,
      invoicePdfBase64: PDF,
    });
    expect(q.status).toBe("queued");
    if (q.status !== "queued") return;
    expect(q.referenceNumber).toBe("TST-1001");
    await expect(queueEuOrder(g.owner, { orderId: order.id, connectionId: g.connection.id })).rejects.toThrow(
      DomainError,
    );
    expect((await g.db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("QUEUED");

    const v = vendor({
      "/fulfilment/create-order": () => json(R.createOrderOk),
      "/fulfilment/attach-pdf-files": () => json(R.attachPdfOk),
    });
    expect(await processOutbound(q.requestId, v.resolve)).toBe("SENT");
    const sent = v.calls[0]!.body!;
    expect(sent).toMatchObject({
      testMode: false,
      senderId: 333,
      recipient: { phoneNumber: "0888123456", countryIsoCode: "BG" },
      awb: { referenceNumber: "TST-1001", bankRepayment: 40 },
      products: [{ refNumber: `ref-${product.sku}`, qty: 2, price: 20 }],
    });
    expect(JSON.stringify(sent)).not.toContain("invoicePdfBase64"); // our ctx never goes to the vendor
    const f = await g.db.fulfillment.findUniqueOrThrow({ where: { id: q.fulfillmentId } });
    expect(f).toMatchObject({ status: "ACCEPTED", vendorOrderId: "745770" });
    expect((await g.db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("ACCEPTED");

    const attach = await g.db.outboundRequest.findFirstOrThrow({
      where: { idempotencyKey: "attach-pdf:TST-1001" },
    });
    expect(attach.operation).toBe(EU_OPS.attachPdf);
    expect(await processOutbound(attach.id, v.resolve)).toBe("SENT");
    expect(v.calls[1]!.body).toMatchObject({
      testMode: false,
      referenceNumber: "TST-1001",
      files: [{ base64Attached: PDF }],
    });
    expect(v.count("/fulfilment/create-order")).toBe(1);
  });

  it("duplicate-submit: a timed-out create-order is read back by reference, never sent twice", async () => {
    const { order, product } = await euTestOrder(g, { number: "#1002" });
    await mapProduct(product.id, `ref-${product.sku}`);
    const q = await queueEuOrder(g.owner, { orderId: order.id, connectionId: g.connection.id });
    if (q.status !== "queued") throw new Error("not queued");
    const v = vendor({
      "/fulfilment/create-order": timeout, // the vendor may have created it
      "/fulfilment/orders-history": (_p, b) => {
        const ref = (b!.orders as { refNum: string }[])[0]!.refNum;
        return json([found(ref)]);
      },
    });
    expect(await processOutbound(q.requestId, v.resolve)).toBe("SENT");
    expect(await processOutbound(q.requestId, v.resolve)).toBe("skipped");
    expect(v.count("/fulfilment/create-order")).toBe(1);
    expect(v.calls[1]!.body).toEqual({ testMode: false, orders: [{ refNum: "TST-1002" }] });
    const f = await g.db.fulfillment.findUniqueOrThrow({ where: { id: q.fulfillmentId } });
    expect(f.status).toBe("ACCEPTED");
    expect((await request(q.requestId)).lastError).toMatch(/recovered by read-back/);
  });

  it("timeout + 'Not found order' (404 item) is the only answer that allows a resend", async () => {
    const { order, product } = await euTestOrder(g, { number: "#1003" });
    await mapProduct(product.id, `ref-${product.sku}`);
    const q = await queueEuOrder(g.owner, { orderId: order.id, connectionId: g.connection.id });
    if (q.status !== "queued") throw new Error("not queued");
    let first = true;
    const v = vendor({
      "/fulfilment/create-order": () => {
        if (first) {
          first = false;
          return json({ error: "Service Unavailable" }, 503);
        }
        return json(R.createOrderOk);
      },
      "/fulfilment/orders-history": (_p, b) =>
        json([notFound((b!.orders as { refNum: string }[])[0]!.refNum)]),
    });
    const now = new Date();
    expect(await processOutbound(q.requestId, v.resolve, now)).toBe("PENDING");
    expect(await processOutbound(q.requestId, v.resolve, now)).toBe("skipped"); // backoff
    expect(await processOutbound(q.requestId, v.resolve, new Date(now.getTime() + 3600_000))).toBe("SENT");
    expect(v.count("/fulfilment/create-order")).toBe(2);

    // Any other per-item error inside HTTP 200 is NOT "not found": UNCERTAIN, no resend.
    const o2 = await euTestOrder(g, { number: "#1004" });
    await mapProduct(o2.product.id, `ref-${o2.product.sku}`);
    const q2 = await queueEuOrder(g.owner, { orderId: o2.order.id, connectionId: g.connection.id });
    if (q2.status !== "queued") throw new Error("not queued");
    const v2 = vendor({
      "/fulfilment/create-order": timeout,
      "/fulfilment/orders-history": () =>
        json([{ refNum: "TST-1004", error: "Temporary problem", errorCode: 500, statusesHistory: [] }]),
    });
    expect(await processOutbound(q2.requestId, v2.resolve)).toBe("UNCERTAIN");
    expect(v2.count("/fulfilment/create-order")).toBe(1);
  });

  it("a definite rejection marks the shipment SUBMIT_FAILED with a task; a re-queue re-arms the same key", async () => {
    const { order, product } = await euTestOrder(g, { number: "#1005" });
    await mapProduct(product.id, `ref-${product.sku}`);
    const q = await queueEuOrder(g.owner, { orderId: order.id, connectionId: g.connection.id });
    if (q.status !== "queued") throw new Error("not queued");
    const v = vendor({ "/fulfilment/create-order": () => json({ error: "Wrong params.", code: 422 }, 422) });
    expect(await processOutbound(q.requestId, v.resolve)).toBe("FAILED");
    expect((await g.db.fulfillment.findUniqueOrThrow({ where: { id: q.fulfillmentId } })).status).toBe(
      "SUBMIT_FAILED",
    );
    expect(
      await g.db.alert.count({ where: { kind: "eushipments_submit_failed", entityId: q.fulfillmentId } }),
    ).toBe(1);
    const again = await queueEuOrder(g.owner, { orderId: order.id, connectionId: g.connection.id });
    expect(again).toMatchObject({ status: "queued", fulfillmentId: q.fulfillmentId, requestId: q.requestId });
    expect((await request(q.requestId)).status).toBe("PENDING");
  });

  it("DRY_RUN sends create-order with testMode: true and changes nothing on our side", async () => {
    await setMode("DRY_RUN");
    try {
      const { order, product } = await euTestOrder(g, { number: "#1006" });
      await mapProduct(product.id, `ref-${product.sku}`);
      const q = await queueEuOrder(g.owner, {
        orderId: order.id,
        connectionId: g.connection.id,
        invoicePdfBase64: PDF,
      });
      if (q.status !== "queued") throw new Error("not queued");
      const v = vendor({
        "/fulfilment/create-order": () => json({ orderId: null, error: false, code: 200 }),
      });
      expect(await processOutbound(q.requestId, v.resolve)).toBe("DRY_RUN_RECORDED");
      expect(v.calls[0]!.body).toMatchObject({ testMode: true });
      expect((await g.db.fulfillment.findUniqueOrThrow({ where: { id: q.fulfillmentId } })).status).toBe(
        "QUEUED",
      );
      expect(await g.db.outboundRequest.count({ where: { idempotencyKey: "attach-pdf:TST-1006" } })).toBe(0);

      // Operations without a validate-only mode are only recorded in DRY_RUN.
      const p = await queueEuProduct(g.owner, { connectionId: g.connection.id, productId: product.id });
      const v2 = vendor({});
      expect(await processOutbound(p.request.id, v2.resolve)).toBe("DRY_RUN_RECORDED");
      expect(v2.calls).toHaveLength(0);
    } finally {
      await setMode("LIVE");
    }
  });

  it("READ_ONLY refuses every write without calling the vendor", async () => {
    await setMode("READ_ONLY");
    try {
      const { product } = await euTestOrder(g, { number: "#1007" });
      const p = await queueEuProduct(g.owner, { connectionId: g.connection.id, productId: product.id });
      const v = vendor({});
      expect(await processOutbound(p.request.id, v.resolve)).toBe("REFUSED");
      expect(v.calls).toHaveLength(0);
    } finally {
      await setMode("LIVE");
    }
  });

  it("product: barcode collision → operator task, re-queue with an internal barcode, then mapped", async () => {
    const { product } = await euTestOrder(g, { number: "#1100" });
    const p = await queueEuProduct(g.owner, { connectionId: g.connection.id, productId: product.id });
    const v = vendor({ "/fulfilment/create-product": () => json(R.createProductBarcodeTaken, 422) });
    expect(await processOutbound(p.request.id, v.resolve)).toBe("FAILED");
    expect(v.calls[0]!.body).toMatchObject({
      testMode: false,
      companyId: 333,
      product: {
        barcode: "0000000000017",
        refNumber: product.sku,
        length: 10,
        width: 6,
        height: 15,
        weight: 0.4,
      },
    });
    const task = await g.db.alert.findFirstOrThrow({
      where: { kind: "eushipments_barcode_collision", entityId: product.id },
    });
    expect(task).toMatchObject({ isTask: true, status: "OPEN" });

    const again = await queueEuProduct(g.owner, {
      connectionId: g.connection.id,
      productId: product.id,
      barcode: product.sku,
    });
    expect(again.request.id).toBe(p.request.id); // same deterministic key, re-armed
    const v2 = vendor({ "/fulfilment/create-product": () => json(R.createProductOk, 201) });
    expect(await processOutbound(p.request.id, v2.resolve)).toBe("SENT");
    expect((v2.calls[0]!.body as { product: { barcode: string } }).product.barcode).toBe(product.sku);
    const vp = await g.db.vendorProduct.findFirstOrThrow({ where: { productId: product.id } });
    expect(vp).toMatchObject({ vendorId: product.sku, vendorCode: "85", vendorEan: null });
    expect((await g.db.alert.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("RESOLVED");
  });

  it("product: a timed-out create is read back via get-products by refNumber", async () => {
    const { product } = await euTestOrder(g, { number: "#1101" });
    await g.db.product.update({ where: { id: product.id }, data: { sku: "ref-test-54202" } });
    const p = await queueEuProduct(g.owner, { connectionId: g.connection.id, productId: product.id });
    const products = (await import("@/integrations/eushipments/__fixtures__/get-products.json")).default;
    const v = vendor({
      "/fulfilment/create-product": timeout,
      "/fulfilment/get-products": () => json(products),
    });
    expect(await processOutbound(p.request.id, v.resolve)).toBe("SENT");
    expect(v.count("/fulfilment/create-product")).toBe(1);
    expect(
      await g.db.vendorProduct.count({ where: { productId: product.id, vendorId: "ref-test-54202" } }),
    ).toBe(1);
  });

  it("product creation needs all four dimensions", async () => {
    const { product } = await euTestOrder(g, { number: "#1102" });
    await g.db.product.update({ where: { id: product.id }, data: { heightMm: null } });
    await expect(
      queueEuProduct(g.owner, { connectionId: g.connection.id, productId: product.id }),
    ).rejects.toMatchObject({
      code: "missing_dimensions",
    });
  });

  it("booking request: a timeout is UNCERTAIN + operator task, never retried", async () => {
    const { product } = await euTestOrder(g, { number: "#1200" });
    await mapProduct(product.id, `ref-${product.sku}`);
    const b = await queueEuBooking(g.owner, {
      connectionId: g.connection.id,
      warehouseId: 1,
      documentNumber: "INB-2026-0001",
      lines: [{ productId: product.id, quantity: 10 }],
    });
    await expect(
      queueEuBooking(g.owner, {
        connectionId: g.connection.id,
        warehouseId: 1,
        documentNumber: "INB-2026-0001",
        lines: [{ productId: product.id, quantity: 10 }],
      }),
    ).rejects.toMatchObject({ code: "duplicate_reference" });
    const v = vendor({ "/fulfilment/create-request": timeout });
    expect(await processOutbound(b.request.id, v.resolve)).toBe("UNCERTAIN");
    expect(await processOutbound(b.request.id, v.resolve, new Date(Date.now() + 86400_000))).toBe("skipped");
    expect(v.count("/fulfilment/create-request")).toBe(1);
    expect(v.calls[0]!.body).toMatchObject({
      testMode: false,
      companyId: 333,
      warehouseId: 1,
      clientReference: "INB-2026-0001",
      products: [{ refNumber: `ref-${product.sku}`, quantity: 10 }],
    });
    expect((await g.db.inboundShipment.findUniqueOrThrow({ where: { id: b.inbound.id } })).status).toBe(
      "UNCERTAIN",
    );
    expect(
      await g.db.alert.count({ where: { kind: "outbox_uncertain", entityId: b.request.id, isTask: true } }),
    ).toBe(1);
  });

  it("booking request: success stores the requestId", async () => {
    const { product } = await euTestOrder(g, { number: "#1201" });
    await mapProduct(product.id, `ref-${product.sku}`);
    const b = await queueEuBooking(g.owner, {
      connectionId: g.connection.id,
      warehouseId: 1,
      documentNumber: "INB-2026-0002",
      lines: [{ productId: product.id, quantity: 3 }],
    });
    const v = vendor({ "/fulfilment/create-request": () => json(R.createRequestOk, 201) });
    expect(await processOutbound(b.request.id, v.resolve)).toBe("SENT");
    expect(await g.db.inboundShipment.findUniqueOrThrow({ where: { id: b.inbound.id } })).toMatchObject({
      vendorId: "137",
      status: "CREATED",
    });
  });

  it("transfer: deterministic externalRef; an unknown outcome resends safely (409 = existing protocol)", async () => {
    const { product } = await euTestOrder(g, { number: "#1300" });
    await mapProduct(product.id, `ref-${product.sku}`);
    const t = await queueEuTransfer(g.owner, {
      connectionId: g.connection.id,
      sourceWarehouseId: 4,
      destinationWarehouseId: 7,
      lines: [{ productId: product.id, quantity: 1 }],
    });
    expect(t.transfer.externalRef).toBe(`CRM-TRF-${t.transfer.id}`);
    let n = 0;
    const v = vendor({
      "/fulfilment/create-transfer": () =>
        n++ === 0 ? json({ error: "Internal" }, 500) : json(R.transferDuplicate, 409),
    });
    expect(await processOutbound(t.request.id, v.resolve)).toBe("SENT");
    const bodies = v.calls.map((c) => c.body!.externalRef);
    expect(bodies).toEqual([t.transfer.externalRef, t.transfer.externalRef]);
    expect(await g.db.eushipmentsTransfer.findUniqueOrThrow({ where: { id: t.transfer.id } })).toMatchObject({
      status: "CREATED",
      protocolId: "98765",
    });
  });

  it("transfer in DRY_RUN is validated with testMode: true", async () => {
    await setMode("DRY_RUN");
    try {
      const { product } = await euTestOrder(g, { number: "#1301" });
      await mapProduct(product.id, `ref-${product.sku}`);
      const t = await queueEuTransfer(g.owner, {
        connectionId: g.connection.id,
        sourceWarehouseId: 4,
        protocolType: 3,
        lines: [{ productId: product.id, quantity: 1 }],
      });
      const v = vendor({ "/fulfilment/create-transfer": () => json(R.transferTestMode, 201) });
      expect(await processOutbound(t.request.id, v.resolve)).toBe("DRY_RUN_RECORDED");
      expect(v.calls[0]!.body).toMatchObject({ testMode: true, protocolType: 3 });
      expect(
        (await g.db.eushipmentsTransfer.findUniqueOrThrow({ where: { id: t.transfer.id } })).status,
      ).toBe("QUEUED");
    } finally {
      await setMode("LIVE");
    }
  });

  it("delete: only while still deletable; a timeout is read back via orders-history", async () => {
    const { order, product } = await euTestOrder(g, { number: "#1400" });
    await mapProduct(product.id, `ref-${product.sku}`);
    const f = await g.db.fulfillment.create({
      data: {
        accountId: g.accountId,
        orderId: order.id,
        connectionId: g.connection.id,
        externalId: "TST-1400",
        status: "PROCESSING",
        rawStatus: "Packed",
        submittedAt: new Date(),
      },
    });
    await expect(queueEuOrderDeletion(g.owner, f.id)).rejects.toMatchObject({ code: "not_deletable" });
    await g.db.fulfillment.update({
      where: { id: f.id },
      data: { status: "ACCEPTED", rawStatus: "Information received" },
    });
    await expect(
      queueEuOrderDeletion(g.owner, f.id, new Date(Date.now() + 15 * 86400_000)),
    ).rejects.toMatchObject({
      code: "not_deletable",
    });
    const d = await queueEuOrderDeletion(g.owner, f.id);
    const v = vendor({
      "/orders-delete/": timeout,
      "/fulfilment/orders-history": () => json([found("TST-1400", "Deleted")]),
    });
    expect(await processOutbound(d.request.id, v.resolve)).toBe("SENT");
    expect(v.calls[0]!.path).toBe("/orders-delete/TST-1400");
    expect((await g.db.fulfillment.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("CANCELLED");
  });

  it("company-restricted members cannot write for another company's connection", async () => {
    const restricted = { ...g.owner, role: "OPERATOR" as const, companyScope: ["some-other-company"] };
    const { order } = await euTestOrder(g, { number: "#1500" });
    await expect(
      queueEuOrder(restricted, { orderId: order.id, connectionId: g.connection.id }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    const viewer = { ...g.owner, role: "VIEWER" as const };
    await expect(queueEuOrder(viewer, { orderId: order.id, connectionId: g.connection.id })).rejects.toThrow(
      /Forbidden/,
    );
  });

  it("other groups see none of this group's requests", async () => {
    const other = await euTestGroup("write-other");
    expect(await accountDb(other.accountId).outboundRequest.count()).toBe(0);
    expect(await accountDb(other.accountId).eushipmentsTransfer.count()).toBe(0);
  });
});

describe("EuShipmentsTransport (unit)", () => {
  const transport = (handler: () => Response) =>
    new EuShipmentsTransport({
      connect: async () => ({
        client: new EuShipmentsClient("test-token", {
          fetchImpl: async () => handler(),
          sleep: async () => {},
        }),
        companyId: 1,
      }),
    });

  it("offers validate-only test mode for create-order and create-transfer only", () => {
    const t = transport(() => json({}));
    expect(t.supportsTestMode(EU_OPS.createOrder)).toBe(true);
    expect(t.supportsTestMode(EU_OPS.createTransfer)).toBe(true);
    for (const op of [EU_OPS.createProduct, EU_OPS.createRequest, EU_OPS.attachPdf, EU_OPS.deleteOrder])
      expect(t.supportsTestMode(op)).toBe(false);
  });

  it("an invalid stored payload is rejected without any call", async () => {
    const fetchImpl = vi.fn();
    const t = new EuShipmentsTransport({
      connect: async () => ({ client: new EuShipmentsClient("x", { fetchImpl }), companyId: 1 }),
    });
    const r = await t.send({
      operation: EU_OPS.createOrder,
      idempotencyKey: "k",
      payload: { body: { senderId: "nope" }, ctx: {} },
      testMode: false,
    });
    expect(r.outcome).toBe("rejected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("attach-pdf per-file errors are rejections; no read-back exists for attach or booking", async () => {
    const t = transport(() => json(R.attachPdfNotFound, 422));
    const call = {
      operation: EU_OPS.attachPdf,
      idempotencyKey: "k",
      payload: { body: { referenceNumber: "TST-1", files: [{ base64Attached: PDF }] }, ctx: {} },
      testMode: false,
    };
    const r = await t.send(call);
    expect(r).toMatchObject({ outcome: "rejected", error: expect.stringMatching(/Not found order/) });
    await expect(t.readBack(call)).rejects.toThrow(/cannot be read back/);
    await expect(t.readBack({ ...call, operation: EU_OPS.createRequest })).rejects.toThrow(
      /cannot be read back/,
    );
  });

  it("a create-order 2xx without orderId is an unknown outcome on a real send", async () => {
    const t = transport(() => json({ orderId: null, error: "something", code: 200 }));
    const call = {
      operation: EU_OPS.createOrder,
      idempotencyKey: "k",
      payload: {
        body: {
          senderId: 1,
          waybillAvailableDate: "2026-11-02",
          recipient: {
            name: "T",
            countryIsoCode: "BG",
            cityName: "S",
            zipCode: "1",
            streetName: "s 1",
            phoneNumber: "0888123456",
          },
          awb: { parcels: 1, envelopes: 0, totalWeight: 1, referenceNumber: "TST-1" },
          products: [{ refNumber: "r", qty: 1 }],
        },
        ctx: {},
      },
      testMode: false,
    };
    await expect(t.send(call)).rejects.toMatchObject({ code: "unknown_outcome" });
    expect(await t.send({ ...call, testMode: true })).toMatchObject({
      outcome: "rejected",
      error: "something",
    });
  });
});
