import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import history from "../__fixtures__/orders-history.json";
import products from "../__fixtures__/get-products.json";
import RD from "../__fixtures__/read.json";
import { ENDPOINTS, findUnscrubbed, isSynthetic, RULES, scrubResponse, synth, type Endpoint } from "./scrub";

// Raw shapes from the reference examples (synthetic, but NOT scrubber output) — the scrubber must catch them.
const RAW: Partial<Record<Endpoint, unknown>> = {
  "get-user-companies": RD.userCompanies,
  couriers: RD.couriers,
  warehouses: RD.warehouses,
  "get-countries": RD.countries,
  "get-cities": RD.cities,
  "offices-by-courier": RD.officesPage1,
  "get-products": products,
  "get-prod-avails": RD.prodAvails,
  "orders-history": history,
  "get-request-status": RD.requestStatusAccepted,
  "booking-request-status": RD.bookingStatusClosed,
  "check-cod-by-order": RD.codPaid,
};

describe("euShipments fixture scrubber", () => {
  it("has rules for every endpoint the recorder calls", () => {
    expect(Object.keys(RAW).sort()).toEqual([...ENDPOINTS].sort());
  });

  for (const [endpoint, raw] of Object.entries(RAW) as [Endpoint, unknown][]) {
    it(`${endpoint}: every field is classified; scrubbed output passes the checker; idempotent`, () => {
      const s = scrubResponse(endpoint, raw);
      expect(s.unclassified).toEqual([]);
      expect(findUnscrubbed(endpoint, s.data)).toEqual([]);
      expect(scrubResponse(endpoint, s.data).data).toEqual(s.data);
    });
  }

  it("raw business values are flagged by the checker and replaced", () => {
    expect(findUnscrubbed("get-products", products)).toEqual(
      expect.arrayContaining(["[0].ID", "[0].NAME", "[0].REFERENCE_NUMBER"]),
    );
    expect(findUnscrubbed("get-user-companies", RD.userCompanies)).toEqual(
      expect.arrayContaining(["[0].ID", "[0].NAME", "[0].MOL", "[0].ADDRESS"]),
    );
    const s = scrubResponse("check-cod-by-order", RD.codPaid).data as Record<string, unknown>;
    expect(s.referenceNumber).not.toBe("TST-1001");
    expect(s.awbNumber).not.toBe(RD.codPaid.awbNumber);
    expect(JSON.stringify(scrubResponse("get-prod-avails", RD.prodAvails).data)).not.toContain(
      "Example Company",
    );
    // nomenclature stays readable
    expect((scrubResponse("couriers", RD.couriers).data as { NAME: string }[])[0]!.NAME).toBe(
      "Hungary GLS New",
    );
  });

  it("a field the vendor adds later is reported, not passed through", () => {
    const s = scrubResponse("get-products", [{ ...products[0], NEW_FIELD: "Somebody Real" }]);
    expect(s.unclassified).toEqual(["[0].NEW_FIELD"]);
    expect(JSON.stringify(s.data)).not.toContain("Somebody Real");
    expect(findUnscrubbed("get-products", [{ ...products[0], NEW_FIELD: 1 }])).toContain(
      "[0].NEW_FIELD (unclassified)",
    );
    // an object under a key classified as a plain value is not walked blindly
    expect(scrubResponse("couriers", [{ ...RD.couriers[0], NAME: { x: "y" } }]).unclassified).toEqual([
      "[0].NAME",
    ]);
  });

  it("synthetic values are deterministic, keep their type and are recognised", () => {
    expect(synth("ref", "ABC")).toBe(synth("ref", "ABC"));
    expect(synth("ref", "ABC")).not.toBe(synth("ref", "ABD"));
    expect(typeof synth("amount", "40.00")).toBe("string");
    expect(typeof synth("id", 85)).toBe("number");
    expect(synth("qty", 0)).toBe(0);
    for (const [kind, v] of [
      ["text", "x"],
      ["ref", "x"],
      ["phone", "0888123456"],
      ["email", "a@b.cd"],
      ["ean", "3800000000000"],
      ["company", 333],
      ["id", 85],
      ["qty", 87],
      ["amount", 2310],
      ["message", "Not found order 1234567"],
    ] as const)
      expect(isSynthetic(kind, synth(kind, v)), kind).toBe(true);
  });

  it("rule tables contain only known rule names", () => {
    const allowed = new Set([
      "safe",
      "nest",
      "text",
      "ref",
      "phone",
      "email",
      "ean",
      "company",
      "id",
      "qty",
      "amount",
      "message",
    ]);
    for (const rules of Object.values(RULES))
      for (const r of Object.values(rules)) expect(allowed).toContain(r);
  });
});

/**
 * Recorded fixtures (written by tools/record-eushipments-fixtures.ts at GATE P3-G1): the test fails if any
 * recorded file contains a value the scrubber did not produce, or a field it does not know.
 */
describe("recorded euShipments fixtures contain only scrubbed values", () => {
  const dir = path.join(import.meta.dirname, "../__fixtures__/recorded");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  it("the recorded directory exists", () => expect(files.length).toBeGreaterThan(0));
  for (const f of files) {
    it(f, () => {
      const fixture = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as {
        endpoint: Endpoint;
        response: unknown;
      };
      expect(ENDPOINTS).toContain(fixture.endpoint);
      expect(f).toBe(`${fixture.endpoint}.json`);
      expect(findUnscrubbed(fixture.endpoint, fixture.response)).toEqual([]);
    });
  }
});
