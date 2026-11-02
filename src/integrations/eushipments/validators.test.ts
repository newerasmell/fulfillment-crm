import { describe, expect, it } from "vitest";
import {
  buildCreateOrder,
  buildCreateProduct,
  distributeCod,
  productsSumCents,
  vendorRefNumber,
  type BuildOrderInput,
} from "./mapper";
import { normalisePhone } from "./phone";
import { addDays, hasBlocks, sofiaToday, storedAddressText, validateEuOrder } from "./validators";

// Synthetic phone numbers only (well-formed, not real subscribers).
describe("phone normaliser (INTEGRATION_NOTES §4.4)", () => {
  it.each([
    // BG — national, without country prefix, trunk 0 kept (spec example 0889000000)
    ["BG", "0888 123 456", "0888123456"],
    ["BG", "+359 888 123 456", "0888123456"],
    ["BG", "00359888123456", "0888123456"],
    ["BG", "359888123456", "0888123456"],
    ["BG", "+359 0888 123 456", "0888123456"], // doubled prefix
    ["BG", "(02) 123-4567", "021234567"], // Sofia landline, 8-digit NSN
    ["BG", "888123456", "0888123456"],
    // RO — national without prefix
    ["RO", "0740 123 456", "0740123456"],
    ["RO", "+40 740 123 456", "0740123456"],
    ["RO", "0040740123456", "0740123456"],
    // GR — 10 digits, no trunk
    ["GR", "+30 691 234 5678", "6912345678"],
    ["GR", "6912345678", "6912345678"],
    ["GR", "0030 6912345678", "6912345678"],
    // PL — 9 digits, no trunk
    ["PL", "+48 512 345 678", "512345678"],
    ["PL", "512-345-678", "512345678"],
    ["PL", "0048512345678", "512345678"],
    // CZ — +420 + 9 digits
    ["CZ", "601 123 456", "+420601123456"],
    ["CZ", "00420 601 123 456", "+420601123456"],
    ["CZ", "+420601123456", "+420601123456"],
    // HU — +36 + 9 digits, national 06 stripped, never two prefixes
    ["HU", "06 30 123 4567", "+36301234567"],
    ["HU", "+36 30 123 4567", "+36301234567"],
    ["HU", "0036 06 30 123 4567", "+36301234567"],
    ["HU", "+36 06 30 123 4567", "+36301234567"],
    ["HU", "30/123-4567", "+36301234567"],
    // SK — +421 + 9 digits, trunk 0 stripped
    ["SK", "0905 123 456", "+421905123456"],
    ["SK", "+421 905 123 456", "+421905123456"],
    ["SK", "00421 0905 123 456", "+421905123456"],
    // HR — +385 + 9 digits, trunk 0 stripped
    ["HR", "091 234 5678", "+385912345678"],
    ["HR", "+385 91 234 5678", "+385912345678"],
    ["HR", "00385912345678", "+385912345678"],
  ])("%s %s → %s", (country, raw, expected) => {
    const r = normalisePhone(raw, country);
    expect(r).toMatchObject({ ok: true, value: expected, original: raw });
  });

  it.each([
    ["BG", "", "empty"],
    ["BG", null, "empty"],
    ["BG", "0888 123 456 ext 2", "invalid_characters"],
    ["BG", "+40 740 123 456", "foreign_number"],
    ["HU", "+421 905 123 456", "foreign_number"],
    ["CZ", "60112345", "wrong_length"],
    ["HU", "06 1 234 567", "wrong_length"], // Budapest landline: not a 9-digit mobile
    ["HR", "098 123 45", "wrong_length"],
    ["RO", "0740 123 45", "wrong_length"],
    ["DE", "+49 151 2345678", "no_rule"],
    ["BG", "0888 123 456", undefined], // control row: valid
  ])("%s %s → %s", (country, raw, reason) => {
    const r = normalisePhone(raw, country);
    if (reason) expect(r).toMatchObject({ ok: false, reason });
    else expect(r.ok).toBe(true);
  });
});

describe("COD distribution: Σ(price × qty) = COD", () => {
  it("keeps prices when the totals already match", () => {
    const d = distributeCod(
      [
        { refNumber: "A", qty: 2, unitPrice: "20.00" },
        { refNumber: "B", qty: 1, unitPrice: "5.50" },
      ],
      "45.50",
    );
    expect(d).toEqual({
      ok: true,
      lines: [
        { refNumber: "A", qty: 2, price: 20 },
        { refNumber: "B", qty: 1, price: 5.5 },
      ],
    });
  });

  it("scales to a COD that includes shipping / another currency and fixes rounding on a qty-1 line", () => {
    const lines = [
      { refNumber: "A", qty: 1, unitPrice: "10.00" },
      { refNumber: "B", qty: 1, unitPrice: "10.00" },
      { refNumber: "C", qty: 1, unitPrice: "10.00" },
    ];
    const d = distributeCod(lines, "100.00");
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(productsSumCents(d.lines)).toBe(10000);
      expect(d.lines.map((l) => l.price)).toEqual([33.33, 33.33, 33.34]);
    }
  });

  it("puts the rounding on the last line whose quantity divides it", () => {
    const d = distributeCod(
      [
        { refNumber: "A", qty: 1, unitPrice: "10.00" },
        { refNumber: "B", qty: 3, unitPrice: "10.00" },
      ],
      "40.01",
    );
    expect(d.ok).toBe(true);
    if (d.ok) expect(productsSumCents(d.lines)).toBe(4001);
  });

  it("refuses when no line can take the rounding exactly", () => {
    expect(distributeCod([{ refNumber: "A", qty: 3, unitPrice: "10.00" }], "10.00")).toEqual({
      ok: false,
      reason: "cannot_split_rounding",
    });
    expect(distributeCod([], "10")).toEqual({ ok: false, reason: "no_lines" });
  });

  it("free lines are split by quantity", () => {
    const d = distributeCod(
      [
        { refNumber: "A", qty: 1, unitPrice: "0" },
        { refNumber: "B", qty: 1, unitPrice: "0" },
      ],
      "9.99",
    );
    expect(d.ok && productsSumCents(d.lines)).toBe(999);
  });
});

const TODAY = "2026-11-02";
const input = (over: Partial<BuildOrderInput> = {}): BuildOrderInput => ({
  referenceNumber: "TST-1001",
  senderId: 333,
  waybillAvailableDate: TODAY,
  address: {
    name: "Test Buyer",
    address1: "Example Street 12",
    address2: "bl. 1 ent. A",
    city: "Sofia",
    zip: "1000",
    countryCode: "bg",
    phone: "+359 888 123 456",
  },
  email: "buyer@example.com",
  codLocal: "40.00",
  lines: [{ refNumber: "ref-1", qty: 2, unitPrice: "20.00" }],
  totalWeightKg: 0.8,
  cashReceiptCod: true,
  ...over,
});

describe("create-order mapping + validators", () => {
  it("builds a clean body with the normalised phone, COD and JSON nulls", () => {
    const b = buildCreateOrder(input());
    expect(b.body).toMatchObject({
      senderId: 333,
      recipient: {
        countryIsoCode: "BG",
        phoneNumber: "0888123456",
        streetName: "Example Street 12",
        addressText: "bl. 1 ent. A",
        region: null,
        officeId: null,
      },
      awb: { bankRepayment: 40, referenceNumber: "TST-1001", parcels: 1, envelopes: 0 },
      products: [{ refNumber: "ref-1", qty: 2, price: 20 }],
    });
    expect(JSON.stringify(b.body)).not.toContain('"null"');
    expect(validateEuOrder(b, { cashReceiptCod: true, today: TODAY })).toEqual([]);
  });

  it("PUDO: officeId instead of a street", () => {
    const b = buildCreateOrder(input({ officeId: 1297 }));
    expect(b.body.recipient).toMatchObject({ officeId: 1297, streetName: null });
    expect(validateEuOrder(b, { cashReceiptCod: true, today: TODAY })).toEqual([]);
  });

  it("blocks an unusable phone", () => {
    const b = buildCreateOrder(input({ address: { ...input().address, phone: "+40 740 123 456" } }));
    const f = validateEuOrder(b, { cashReceiptCod: false, today: TODAY });
    expect(f).toEqual([expect.objectContaining({ code: "phone_invalid", severity: "block" })]);
  });

  it("blocks missing required fields with the exact field path", () => {
    const b = buildCreateOrder(
      input({ address: { ...input().address, name: null, address1: null, zip: null } }),
    );
    const fields = validateEuOrder(b, { cashReceiptCod: false, today: TODAY }).map((f) => f.field);
    expect(fields).toEqual(
      expect.arrayContaining(["recipient.name", "recipient.streetName", "recipient.zipCode"]),
    );
    expect(hasBlocks(validateEuOrder(b, { cashReceiptCod: false, today: TODAY }))).toBe(true);
  });

  it("Romania needs a region", () => {
    const b = buildCreateOrder(
      input({ address: { ...input().address, countryCode: "RO", phone: "0740123456", province: null } }),
    );
    expect(validateEuOrder(b, { cashReceiptCod: false, today: TODAY }).map((f) => f.field)).toContain(
      "recipient.region",
    );
  });

  it("waybillAvailableDate must be today … +9 days (Sofia)", () => {
    expect(sofiaToday(new Date("2026-11-01T22:30:00Z"))).toBe("2026-11-02"); // already the 2nd in Sofia
    expect(addDays(TODAY, 9)).toBe("2026-11-11");
    for (const [date, ok] of [
      ["2026-11-01", false],
      [TODAY, true],
      ["2026-11-11", true],
      ["2026-11-12", false],
    ] as const) {
      const f = validateEuOrder(buildCreateOrder(input({ waybillAvailableDate: date })), {
        cashReceiptCod: true,
        today: TODAY,
      });
      expect(f.some((x) => x.code === "waybill_date_window")).toBe(!ok);
    }
  });

  it("cash-receipt senders: Σ(price × qty) must equal COD; impossible splits are blocked", () => {
    const b = buildCreateOrder(input());
    b.body.products[0]!.price = 19.99;
    expect(validateEuOrder(b, { cashReceiptCod: true, today: TODAY })).toEqual([
      expect.objectContaining({ code: "cod_sum_mismatch", severity: "block" }),
    ]);
    expect(validateEuOrder(b, { cashReceiptCod: false, today: TODAY })).toEqual([]);
    const odd = buildCreateOrder(
      input({ codLocal: "10.00", lines: [{ refNumber: "r", qty: 3, unitPrice: "3" }] }),
    );
    expect(validateEuOrder(odd, { cashReceiptCod: true, today: TODAY })).toEqual([
      expect.objectContaining({ code: "cod_price_split" }),
    ]);
    // Not a cash-receipt sender: prices simply omitted, no finding.
    const oddPlain = buildCreateOrder(
      input({
        cashReceiptCod: false,
        codLocal: "10.00",
        lines: [{ refNumber: "r", qty: 3, unitPrice: "3" }],
      }),
    );
    expect(oddPlain.body.products).toEqual([{ refNumber: "r", qty: 3 }]);
    // Prepaid: COD 0 and no prices → sum 0 = COD.
    const prepaid = buildCreateOrder(input({ codLocal: null }));
    expect(prepaid.body.awb.bankRepayment).toBe(0);
    expect(validateEuOrder(prepaid, { cashReceiptCod: true, today: TODAY })).toEqual([]);
  });

  it("warns when the vendor will truncate the building number or the address text", () => {
    const b = buildCreateOrder(input({ address: { ...input().address, address2: "x".repeat(99) } }));
    b.body.recipient.buildingNumber = "12345678-AB";
    const f = validateEuOrder(b, { cashReceiptCod: true, today: TODAY });
    expect(f.map((x) => [x.code, x.severity])).toEqual([
      ["building_number_truncated", "warn"],
      ["address_text_truncated", "warn"],
    ]);
    expect(storedAddressText("abc", "12345678-AB")).toEqual({
      full: "abc|-AB",
      stored: "abc|-AB",
      truncated: false,
    });
    expect(storedAddressText("y".repeat(101), null).truncated).toBe(true);
  });

  it("warns about a street without a house number", () => {
    const b = buildCreateOrder(
      input({ address: { ...input().address, address1: "Example Street", address2: null } }),
    );
    expect(validateEuOrder(b, { cashReceiptCod: true, today: TODAY })).toEqual([
      expect.objectContaining({ code: "street_without_number", severity: "warn" }),
    ]);
  });
});

describe("product mapping", () => {
  it("converts mm/g to cm/kg and blocks missing dimensions", () => {
    const base = {
      name: "Sample Perfume",
      refNumber: "SK-ABC",
      barcode: "0000000000017",
      weightGrams: 400,
      lengthMm: 100,
      widthMm: 65,
      heightMm: 150,
    };
    expect(buildCreateProduct(332, base)).toEqual({
      ok: true,
      body: {
        companyId: 332,
        product: {
          name: "Sample Perfume",
          barcode: "0000000000017",
          refNumber: "SK-ABC",
          length: 10,
          width: 6.5,
          height: 15,
          weight: 0.4,
        },
      },
    });
    expect(buildCreateProduct(332, { ...base, weightGrams: null, heightMm: 0 })).toEqual({
      ok: false,
      missing: ["height", "weight"],
    });
  });
  it("applies the SKU prefix rule once", () => {
    expect(vendorRefNumber("ABC", { prefix: "SK-" })).toBe("SK-ABC");
    expect(vendorRefNumber("SK-ABC", { prefix: "SK-" })).toBe("SK-ABC");
    expect(vendorRefNumber("ABC", {})).toBe("ABC");
  });
});
