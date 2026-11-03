import { describe, expect, it } from "vitest";
import examples from "./__fixtures__/openapi-examples.json";
import { payloadHash } from "./adapter";
import {
  buildFhbOrderCreate,
  buildFhbOrderUpdate,
  buildFhbProductCreate,
  buildFhbProductUpdate,
  fhbOrderExternalId,
  fhbProductId,
  mapFhbOrderView,
  mapFhbProductView,
} from "./mapper";
import { FhbOrderView, FhbProductView } from "./schemas";

const ex = examples as Record<string, unknown>;
const draft = {
  externalId: "TST-1001",
  variableSymbol: "42",
  address: { name: " Test Buyer ", street: "Example 1", city: "Testville", zip: "00000", country: "sk" },
  email: "buyer@example.com",
  phone: "0900 000 000",
  items: [
    { id: "R1", quantity: 1 },
    { id: "R1", quantity: 2 },
    { id: "R2", quantity: 1 },
  ],
  cod: 12.345,
  value: 0,
  note: "n".repeat(300),
};

describe("FHB ids", () => {
  it("order id = STORECODE-number, reships get a suffix", () => {
    expect(fhbOrderExternalId("tst", "#1001")).toBe("TST-1001");
    expect(fhbOrderExternalId("TST", "#1001", 2)).toBe("TST-1001-2");
    // No prefix (owner request 2026-11-03): the Shopify order number as it is.
    expect(fhbOrderExternalId("", "#1-EUR2848")).toBe("1-EUR2848");
    expect(fhbOrderExternalId("", "1-EUR2848", 2)).toBe("1-EUR2848-2");
    expect(() => fhbOrderExternalId("", "#")).toThrow();
  });
  it("product id = connection prefix + SKU", () => {
    expect(fhbProductId("SKU-1", { prefix: "R" })).toBe("RSKU-1");
    expect(fhbProductId("SKU-1", {})).toBe("SKU-1");
  });
});

describe("order payloads", () => {
  it("create: validate:true, merged lines, E.164 phone, rounded COD, truncated note, no zero value", () => {
    const body = buildFhbOrderCreate(draft);
    expect(body).toMatchObject({
      id: "TST-1001",
      variable_symbol: "42",
      validate: true,
      cod: 12.35,
      items: [
        { id: "R1", quantity: 3 },
        { id: "R2", quantity: 1 },
      ],
      recipient: { address: { name: "Test Buyer", country: "SK" }, contact: { phone: "+421900000000" } },
    });
    expect(body.note).toHaveLength(250);
    expect(body).not.toHaveProperty("value");
  });
  it("update has no id / validate / invoice_number (not in the PUT body list)", () => {
    const body = buildFhbOrderUpdate(draft);
    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("validate");
    expect(body.variable_symbol).toBe("42");
  });
  it("no COD → no cod field", () => {
    expect(buildFhbOrderCreate({ ...draft, cod: null })).not.toHaveProperty("cod");
  });
});

describe("product payloads", () => {
  const p = { vendorProductId: "R1", name: "Sample", notifyUrl: "https://crm.example.test/x" };
  it("EAN only on create", () => {
    expect(buildFhbProductCreate({ ...p, ean: "0000000000017" }).ean).toBe("0000000000017");
    expect(buildFhbProductUpdate(p)).not.toHaveProperty("ean");
    expect(buildFhbProductUpdate({ ...p, explicitEan: "0000000000024" }).ean).toBe("0000000000024");
  });
  it("rename via new_id, multi via type+items", () => {
    expect(buildFhbProductUpdate({ ...p, newId: "R1-NEW" }).new_id).toBe("R1-NEW");
    expect(buildFhbProductUpdate({ ...p, newId: "R1" })).not.toHaveProperty("new_id");
    expect(buildFhbProductCreate({ ...p, components: [{ id: "A", quantity: 2 }] })).toMatchObject({
      type: "multi",
      items: [{ id: "A", quantity: 2 }],
    });
  });
});

describe("response mapping", () => {
  it("order view → shipment fields", () => {
    const m = mapFhbOrderView(FhbOrderView.parse(ex["GET /order 200 response"]));
    expect(m.externalId).toBe("AB12345");
    expect(m.mapping.raw).toBeTruthy();
    expect(Array.isArray(m.trackingNumbers)).toBe(true);
  });
  it("product view → free_quantity is the sellable stock, EAN mirrored", () => {
    const m = mapFhbProductView(
      FhbProductView.parse({ ...(ex["GET /product 200 response"] as object), free_quantity: 3 }),
    );
    expect(m).toMatchObject({
      vendorId: "123",
      vendorEan: "8580000001234",
      free: 3,
      physical: 0,
      archived: false,
    });
  });
  it("payload hash is key-order independent", () => {
    expect(payloadHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(payloadHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
  });
});
