import { describe, expect, it, vi } from "vitest";
import { classifyHistoryItem, EuShipmentsClient, historyItemFor } from "./client";
import { EuShipmentsError } from "./errors";
import type { CreateOrderBody } from "./schemas";
import history from "./__fixtures__/orders-history.json";
import products from "./__fixtures__/get-products.json";
import R from "./__fixtures__/responses.json";

// Synthetic fixtures built from the vendor reference examples only (no production data).
const TOKEN = "test-token-not-real-0001";

function fake(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const i = init ?? {};
    calls.push({ url, init: i, body: i.body ? JSON.parse(String(i.body)) : undefined });
    return handler(url, i);
  });
  return { calls, client: new EuShipmentsClient(TOKEN, { fetchImpl, sleep: async () => {} }) };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

export const sampleOrder = (over: Partial<CreateOrderBody> = {}): CreateOrderBody => ({
  senderId: 333,
  waybillAvailableDate: "2026-11-02",
  recipient: {
    name: "Test User",
    countryIsoCode: "BG",
    cityName: "Sofia",
    zipCode: "1000",
    region: null,
    streetName: "Test street",
    buildingNumber: "1",
    phoneNumber: "0889000000",
    email: null,
  },
  awb: { parcels: 1, envelopes: 0, totalWeight: 0.5, bankRepayment: 25.5, referenceNumber: "TST-1001" },
  products: [{ refNumber: "ref-test-54202", qty: 1, price: 25.5 }],
  ...over,
});

describe("EuShipmentsClient", () => {
  it("sends Bearer auth, an explicit testMode and JSON null (never the string null)", async () => {
    const f = fake(() => json(R.createOrderOk));
    const res = await f.client.createOrder(sampleOrder(), false);
    expect(res).toMatchObject({ ok: true, data: { orderId: 745770 } });
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api1.inout.bg/api/v1/fulfilment/create-order");
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.body).toMatchObject({ testMode: false, senderId: 333 });
    expect(String(call.init.body)).toContain('"region":null');
    expect(String(call.init.body)).not.toContain('"null"');

    await f.client.createOrder(sampleOrder(), true);
    expect(f.calls[1]!.body).toMatchObject({ testMode: true });
  });

  it("every write carries testMode", async () => {
    const f = fake((url) => {
      if (url.endsWith("create-product")) return json(R.createProductOk, 201);
      if (url.endsWith("create-request")) return json(R.createRequestOk, 201);
      if (url.endsWith("create-transfer")) return json(R.transferOk, 201);
      return json(R.attachPdfOk);
    });
    await f.client.createProduct(
      {
        companyId: 1,
        product: { name: "n", barcode: "b", refNumber: "r", length: 1, width: 1, height: 1, weight: 0.1 },
      },
      false,
    );
    await f.client.createRequest(
      { companyId: 1, warehouseId: 1, products: [{ refNumber: "r", quantity: 1 }] },
      false,
    );
    await f.client.createTransfer(
      { companyId: 1, sourceWarehouseId: 1, externalRef: "x", items: [{ refNumber: "r", quantity: 1 }] },
      true,
    );
    await f.client.attachPdf({ referenceNumber: "TST-1", files: [{ base64Attached: "JVBERi0=" }] }, false);
    expect(f.calls.map((c) => (c.body as { testMode: boolean }).testMode)).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  it("a 4xx is a definite rejection with the vendor's reason", async () => {
    const f = fake(() => json(R.createProductBarcodeTaken, 422));
    const res = await f.client.createProduct(
      {
        companyId: 1,
        product: { name: "n", barcode: "b", refNumber: "r", length: 1, width: 1, height: 1, weight: 0.1 },
      },
      false,
    );
    expect(res).toMatchObject({ ok: false, status: 422 });
    if (!res.ok) expect(res.error).toMatch(/barcode is not unique/);
  });

  it("422 transfer validation lists messages and item errors", async () => {
    const f = fake(() => json(R.transferValidation, 422));
    const res = await f.client.createTransfer(
      { companyId: 1, sourceWarehouseId: 1, externalRef: "x", items: [{ refNumber: "r", quantity: 12 }] },
      false,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/VALIDATION_FAILED.*must differ.*INSUFFICIENT_QUANTITY/);
  });

  it("409 DUPLICATE_EXTERNAL_REF on a transfer is a successful answer with the existing protocol", async () => {
    const f = fake(() => json(R.transferDuplicate, 409));
    const res = await f.client.createTransfer(
      {
        companyId: 1,
        sourceWarehouseId: 1,
        externalRef: "CRM-TRF-x1",
        items: [{ refNumber: "r", quantity: 1 }],
      },
      false,
    );
    expect(res).toMatchObject({ ok: true, status: 409, data: { protocolId: 98765 } });
  });

  it("timeouts, network errors, 5xx and unreadable 2xx on writes are UNKNOWN outcomes (thrown)", async () => {
    for (const h of [
      () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
      () => json({ error: "Internal" }, 500),
      () => json({ error: "busy" }, 503),
      () => new Response("<html>gateway</html>", { status: 200 }),
    ]) {
      const f = fake(h);
      await expect(f.client.createOrder(sampleOrder(), false)).rejects.toMatchObject({
        code: "unknown_outcome",
      });
      expect(f.calls).toHaveLength(1); // writes are never retried by the client
    }
  });

  it("does not send an invalid body", async () => {
    const f = fake(() => json(R.createOrderOk));
    await expect(
      f.client.createOrder(sampleOrder({ waybillAvailableDate: "02.11.2026" }), false),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });

  it("orders-history: per-item errors inside HTTP 200 are classified, only the 404 item means not found", async () => {
    const f = fake(() => json(history));
    const items = await f.client.ordersHistory(["TST-1001", "TST-1002", "TST-1003"]);
    expect(f.calls[0]!.body).toEqual({
      testMode: false,
      orders: [{ refNum: "TST-1001" }, { refNum: "TST-1002" }, { refNum: "TST-1003" }],
    });
    expect(classifyHistoryItem(historyItemFor(items, "TST-1001")).kind).toBe("found");
    expect(classifyHistoryItem(historyItemFor(items, "TST-1003")).kind).toBe("not_found");
    expect(classifyHistoryItem(historyItemFor(items, "TST-9999"))).toMatchObject({ kind: "error" });
    expect(classifyHistoryItem({ refNum: "x", error: "Something else", errorCode: 500 })).toMatchObject({
      kind: "error",
    });
    expect(classifyHistoryItem({ refNum: "x", error: "Not found order…", errorCode: "404" }).kind).toBe(
      "not_found",
    );
  });

  it("orders-history enforces the 1–100 batch size", async () => {
    const f = fake(() => json([]));
    await expect(f.client.ordersHistory([])).rejects.toThrow();
    await expect(f.client.ordersHistory(Array.from({ length: 101 }, (_, i) => `R${i}`))).rejects.toThrow();
  });

  it("reads retry on 5xx, then parse with Zod", async () => {
    let n = 0;
    const f = fake(() => (n++ < 2 ? json({}, 502) : json(products)));
    const rows = await f.client.getProducts(332);
    expect(rows.map((r) => r.REFERENCE_NUMBER)).toEqual(["ref-test-54202", "ref-test-54201"]);
    expect(f.calls[0]!.url).toBe("https://api1.inout.bg/api/v1/fulfilment/get-products?companyId=332");
  });

  it("reads: 401 is an auth failure, 503 (no access to the company) ends as http_error, bad shape is invalid", async () => {
    await expect(fake(() => json({}, 401)).client.getProducts(1)).rejects.toMatchObject({
      code: "auth_failed",
    });
    await expect(fake(() => json({ error: "no access" }, 503)).client.getProducts(1)).rejects.toBeInstanceOf(
      EuShipmentsError,
    );
    await expect(fake(() => json({ not: "an array" })).client.getProducts(1)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("delete by reference uses the documented path and has no testMode", async () => {
    const f = fake(() => json(R.deleteOk));
    expect(await f.client.deleteOrderByRef("TST 1/2")).toMatchObject({ ok: true });
    expect(f.calls[0]!.url).toBe("https://api1.inout.bg/api/v1/orders-delete/TST%201%2F2");
    expect(f.calls[0]!.init.method).toBe("DELETE");
    expect(f.calls[0]!.body).toBeUndefined();
  });

  it("never puts the token into error messages", async () => {
    const f = fake(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const err = await f.client.createOrder(sampleOrder(), false).catch((e: Error) => e);
    expect(String(err)).not.toContain(TOKEN);
  });
});
