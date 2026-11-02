import { describe, expect, it, vi } from "vitest";
import { AWB_OPS, AwbTransport, withAwbOperations, type AwbResultEvent } from "./awb-adapter";
import { EuAwbClient, waybillFor } from "./awb-client";
import { isNoPrice, ShipmentPriceResponse } from "./awb-schemas";
import { buildCreateAwb, buildPreAwb, validateAwb, type AwbDraft } from "./awb-validators";
import type { FetchLike } from "./client";

// Bodies follow the examples in docs/integrations/eushipments.md; all values synthetic.
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

const draft: AwbDraft = {
  service: "createAWB",
  referenceNumber: "M-M1001",
  senderId: 333,
  courierId: 20,
  waybillAvailableDate: "2026-11-03",
  today: "2026-11-02",
  name: "Test User",
  phone: "0888123456",
  email: "test@example.com",
  country: "BG",
  cityName: "Testograd",
  zip: "1000",
  street: "Test street 10",
  parcels: 1,
  totalWeight: 1,
  cod: 20,
  codCurrency: "EUR",
  localCurrency: "EUR",
  contents: "test product",
};

function fakeClient(route: (method: string, path: string, body: unknown) => Response | Promise<Response>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = vi.fn<FetchLike>(async (u, init = {}) => {
    const url = new URL(u);
    const path = url.pathname.replace("/api/v1", "") + url.search;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", path, body });
    return route(init.method ?? "GET", path, body);
  });
  return { client: new EuAwbClient("token", { fetchImpl, sleep: async () => {} }), calls };
}

describe("validateAwb", () => {
  it("passes a complete draft (phone normalised is soft only for a change)", () => {
    expect(validateAwb(draft).filter((f) => f.severity === "hard")).toEqual([]);
  });
  it.each<[Partial<AwbDraft>, string]>([
    [{ duplicateReference: true }, "awb.reference.duplicate"],
    [{ senderId: null }, "awb.sender.missing"],
    [{ courierId: null }, "awb.courier.missing"],
    [{ waybillAvailableDate: "2026-11-01" }, "awb.date.window"],
    [{ waybillAvailableDate: "2026-11-12" }, "awb.date.window"],
    [{ name: null }, "awb.name.missing"],
    [{ country: "Bulgaria" }, "awb.country.invalid"],
    [{ zip: null, region: null }, "awb.zip.missing"],
    [{ country: "RO", phone: "0712345678", region: null }, "awb.region.ro"],
    [{ street: null }, "awb.street.missing"],
    [{ phone: "abc" }, "awb.phone.invalid"],
    [{ parcels: 0 }, "awb.parcels.invalid"],
    [{ totalWeight: 0 }, "awb.weight.min"],
    [{ codCurrency: "BGN" }, "awb.cod.currency"],
    [{ localCurrency: null }, "awb.cod.no_local_currency"],
    [{ observations: "x".repeat(101) }, "awb.observations.too_long"],
  ])("hard %o → %s", (patch, code) => {
    expect(validateAwb({ ...draft, ...patch }).find((f) => f.code === code)?.severity).toBe("hard");
  });
  it("declared value must be in the local currency, even without COD", () => {
    const code = "awb.declared_value.currency";
    const prepaidRo = { ...draft, country: "RO", region: "Bucuresti", phone: "0712345678", cod: 0 };
    expect(
      validateAwb({ ...prepaidRo, codCurrency: "EUR", localCurrency: "RON", declaredValue: 100 }).find(
        (f) => f.code === code,
      )?.severity,
    ).toBe("hard");
    expect(
      validateAwb({ ...draft, cod: null, localCurrency: null, declaredValue: 50 }).find(
        (f) => f.code === code,
      )?.severity,
    ).toBe("hard");
    expect(
      validateAwb({ ...prepaidRo, codCurrency: "ron", localCurrency: "RON", declaredValue: 100 }).map(
        (f) => f.code,
      ),
    ).not.toContain(code);
    expect(validateAwb({ ...draft, declaredValue: -1 }).map((f) => f.code)).toContain(
      "awb.declared_value.negative",
    );
  });
  it("office delivery makes the street optional for createAWB but not for preAWB", () => {
    expect(validateAwb({ ...draft, street: null, officeId: 1297 }).map((f) => f.code)).not.toContain(
      "awb.street.missing",
    );
    expect(
      validateAwb({ ...draft, service: "preAWB", street: null, officeId: 1297 }).map((f) => f.code),
    ).toContain("awb.street.missing");
  });
  it("preAWB needs ≥0.5 kg, a zip and an integer building number; courier optional", () => {
    const codes = validateAwb({
      ...draft,
      service: "preAWB",
      totalWeight: 0.2,
      zip: null,
      buildingNumber: "10A",
      courierId: null,
    }).map((f) => f.code);
    expect(codes).toEqual(
      expect.arrayContaining(["awb.weight.min", "awb.zip.required_with_city", "awb.building.integer"]),
    );
    expect(codes).not.toContain("awb.courier.missing");
  });
  it("soft: building number split, address text truncation, no phone rule", () => {
    const codes = validateAwb({
      ...draft,
      buildingNumber: "123456789",
      addressText: "x".repeat(100),
      country: "DE",
    }).map((f) => f.code);
    expect(codes).toEqual(
      expect.arrayContaining(["awb.building.split", "awb.address_text.truncated", "awb.phone.no_rule"]),
    );
  });
});

describe("AWB body builders", () => {
  it("createAWB: uppercase country, national BG phone, COD as bankRepayment, envelopes 0", () => {
    const b = buildCreateAwb({ ...draft, phone: "+359 888 123 456", country: "bg" });
    expect(b.recipient.countryIsoCode).toBe("BG");
    expect(b.recipient.phoneNumber).toBe("0888123456");
    expect(b.awb).toMatchObject({
      bankRepayment: 20,
      envelopes: 0,
      referenceNumber: "M-M1001",
      shipmentPayer: "sender",
    });
    expect(b.responseData).toEqual({ id: true });
  });
  it("preAWB: street always, building number as integer", () => {
    const b = buildPreAwb({ ...draft, service: "preAWB", buildingNumber: "10" });
    expect(b.recipient.buildingNumber).toBe(10);
    expect(b.recipient.streetName).toBe("Test street 10");
  });
});

describe("EuAwbClient", () => {
  it("sends testMode explicitly and posts createAWB", async () => {
    const { client, calls } = fakeClient(() =>
      json({ awb: 7000008793166, barcode: "B1", packagesBarcodes: [] }),
    );
    const r = await client.createAwb(buildCreateAwb(draft), true);
    expect(r.ok).toBe(true);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/createAWB" });
    expect((calls[0]!.body as { testMode: boolean }).testMode).toBe(true);
  });
  it("a 5xx on a write is an unknown outcome, never retried", async () => {
    const { client, calls } = fakeClient(() => json({}, 502));
    await expect(client.createAwb(buildCreateAwb(draft), false)).rejects.toMatchObject({
      code: "unknown_outcome",
    });
    expect(calls).toHaveLength(1);
  });
  it("print, merged print, delete and waybills-history hit the documented paths", async () => {
    const { client, calls } = fakeClient((m, p) => {
      if (p.startsWith("/print/")) return json({ type: "PDF", awb_print: "JVBERi0x" });
      if (p === "/merged/print")
        return json({
          success: true,
          message: "ok",
          errorPrinting: { "2": "No found waybill" },
          base64_pdf: "JVBERi0x",
        });
      if (p.startsWith("/delete/")) return json({ success: true, awb: "1", error: null });
      return json([
        {
          refNum: "M-M1001",
          awb: "1",
          statusesHistory: [{ ID: 1, STATUS: "In transit", DATE: "2026-11-02 10:00:00" }],
          error: null,
          errorCode: null,
        },
      ]);
    });
    expect((await client.print("1", { printFileType: 2 })).type).toBe("PDF");
    const merged = await client.mergedPrint(["1", "2"]);
    expect(merged.errorPrinting).toEqual({ "2": "No found waybill" });
    await client.deleteAwb("1");
    const hist = await client.waybillsHistory(["1"]);
    expect(waybillFor(hist, "1")?.refNum).toBe("M-M1001");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /print/1?testMode=0&printFileType=2",
      "POST /merged/print",
      "DELETE /delete/1",
      "POST /fulfilment/waybills-history",
    ]);
    await expect(client.mergedPrint(Array.from({ length: 51 }, (_, i) => String(i)))).rejects.toThrow(/50/);
    await expect(client.print("1/../x")).rejects.toThrow(/invalid AWB/);
  });
  it("an all-zero price is 'no price available'", () => {
    const zero = ShipmentPriceResponse.parse({
      price: "0.00",
      pr_weight: "0.00",
      pr_cod: "0.00",
      pr_sms: "0.0000",
    });
    expect(isNoPrice(zero)).toBe(true);
    expect(isNoPrice(ShipmentPriceResponse.parse({ price: "3.99", pr_weight: "3.99" }))).toBe(false);
  });
});

describe("AwbTransport — never a duplicate courier shipment", () => {
  const call = (operation: string, payload: unknown, testMode = false) => ({
    operation,
    idempotencyKey: "k",
    payload,
    testMode,
  });
  const setup = (route: Parameters<typeof fakeClient>[0]) => {
    const { client, calls } = fakeClient(route);
    const events: AwbResultEvent[] = [];
    const t = new AwbTransport({
      connect: async () => ({ client, companyId: 333 }),
      onResult: async (e) => void events.push(e),
    });
    return { t, calls, events };
  };
  const create = { body: buildCreateAwb(draft), ctx: { fulfillmentId: "f1" } };

  it("createAWB and preAWB support testMode, delete does not", () => {
    const { t } = setup(() => json({}));
    expect(t.supportsTestMode(AWB_OPS.create)).toBe(true);
    expect(t.supportsTestMode(AWB_OPS.preAwb)).toBe(true);
    expect(t.supportsTestMode(AWB_OPS.delete)).toBe(false);
  });

  it("a live create stores the AWB through the effect", async () => {
    const { t, events } = setup(() =>
      json({ awb: 7000008793166, barcode: "B", packagesBarcodes: ["P2"], id: 9 }),
    );
    expect((await t.send(call(AWB_OPS.create, create))).outcome).toBe("accepted");
    expect(events[0]).toMatchObject({
      kind: "created",
      awb: "7000008793166",
      packagesBarcodes: ["P2"],
      vendorId: "9",
    });
  });

  it("a test-mode create runs no effect", async () => {
    const { t, events } = setup(() => json({}));
    expect((await t.send(call(AWB_OPS.create, create, true))).outcome).toBe("accepted");
    expect(events).toHaveLength(0);
  });

  it("an unknown outcome throws and read-back refuses (UNCERTAIN + task, never a retry)", async () => {
    const { t, events, calls } = setup(() => json({}, 504));
    await expect(t.send(call(AWB_OPS.create, create))).rejects.toMatchObject({ code: "unknown_outcome" });
    await expect(t.readBack(call(AWB_OPS.create, create))).rejects.toThrow(/cannot be read back/);
    expect(events.map((e) => e.kind)).toEqual(["uncertain"]);
    expect(calls).toHaveLength(1);
  });

  it("a 422 is a definite rejection", async () => {
    const { t, events } = setup(() => json({ error: "Invalid courier" }, 422));
    const r = await t.send(call(AWB_OPS.create, create));
    expect(r).toMatchObject({ outcome: "rejected", error: "Invalid courier" });
    expect(events[0]!.kind).toBe("create_rejected");
  });

  it("delete reads back via waybills-history: Deleted = done", async () => {
    const { t, events } = setup(() =>
      json([{ awb: "1", statusesHistory: [{ ID: 5, STATUS: "Deleted" }], error: null, errorCode: null }]),
    );
    const r = await t.readBack(call(AWB_OPS.delete, { awb: "1", ctx: {} }));
    expect(r.found).toBe(true);
    expect(events[0]!.kind).toBe("deleted");
  });

  it("the composite routes AWB operations to the AWB transport only", async () => {
    const base = {
      send: vi.fn(async () => ({ outcome: "accepted" as const, response: "base" })),
      supportsTestMode: () => false,
    };
    const awb = {
      send: vi.fn(async () => ({ outcome: "accepted" as const, response: "awb" })),
      supportsTestMode: () => true,
    };
    const c = withAwbOperations(base, awb);
    await c.send(call(AWB_OPS.create, {}));
    await c.send(call("eushipments.createOrder", {}));
    expect(awb.send).toHaveBeenCalledOnce();
    expect(base.send).toHaveBeenCalledOnce();
    expect(c.supportsTestMode!(AWB_OPS.create)).toBe(true);
    expect(c.supportsTestMode!("eushipments.createOrder")).toBe(false);
  });
});
