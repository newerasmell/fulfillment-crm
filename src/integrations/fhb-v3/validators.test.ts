import { describe, expect, it } from "vitest";
import { callingCodeOf, nationalMaxOf, NO_TRUNK_COUNTRIES, normalisePhoneE164 } from "./phone";
import {
  findingsFromViolations,
  hasHardBlock,
  validateFhbOrder,
  validateFhbProduct,
  validateFhbStockReceipt,
  type FhbOrderCheck,
} from "./validators";

const NOW = new Date("2026-11-02T12:00:00Z");
// Synthetic data only.
const good = (over: Partial<FhbOrderCheck> = {}): FhbOrderCheck => ({
  externalId: "TST-1001",
  variableSymbol: "1001",
  country: "SK",
  name: "Test Buyer",
  street: "Example street 1",
  city: "Testville",
  zip: "00000",
  email: "buyer@example.com",
  phone: "+421900000000",
  lines: [
    {
      label: "SKU-1",
      quantity: 2,
      vendorProductId: "R-SKU-1",
      vendorActive: true,
      freeQuantity: 5,
      stockSnapshotAt: new Date(NOW.getTime() - 60_000),
    },
  ],
  isCod: true,
  codAmount: 45,
  codCurrency: "EUR",
  localCurrency: "EUR",
  now: NOW,
  ...over,
});
const codes = (o: FhbOrderCheck) => validateFhbOrder(o).map((x) => x.code);

describe("phone → E.164", () => {
  const table: [string, string | null, string | null][] = [
    ["+421 900 000 000", "SK", "+421900000000"],
    ["00421900000000", "SK", "+421900000000"],
    ["0900 000 000", "SK", "+421900000000"],
    ["06 30 123 4567", "HU", "+36301234567"],
    ["36301234567", "HU", "+36301234567"],
    ["+36 30 123 4567", "HU", "+36301234567"],
    ["777 123 456", "CZ", "+420777123456"],
    ["0888 123 456", "BG", "+359888123456"],
    ["+359 0888 123 456", "BG", "+359888123456"],
    ["(0) 30-1234567", "DE", "+49301234567"],
    ["600 100 200", "PL", "+48600100200"],
    // Italian mobiles start with 3 — "39…" is the number itself, not Italy's code (owner report 2026-11-11).
    ["3927838955", "IT", "+393927838955"],
    ["392 783 8955", "IT", "+393927838955"],
    ["393927838955", "IT", "+393927838955"],
    ["+39 392 783 8955", "IT", "+393927838955"],
    ["0039 392 783 8955", "IT", "+393927838955"],
    ["06 1234 5678", "IT", "+390612345678"],
    ["359888123456", "BG", "+359888123456"],
    ["30 6912345678", "GR", "+306912345678"],
    ["6912345678", "GR", "+306912345678"],
    ["call me", "SK", null],
    ["12", "SK", null],
    ["0900000000", null, null],
    ["", "SK", null],
  ];
  for (const [raw, country, want] of table) {
    it(`${raw} (${country}) → ${want}`, () => expect(normalisePhoneE164(raw, country)).toBe(want));
  }
});

describe("phone → E.164: the country code is never doubled nor swallowed", () => {
  // Owner report 2026-11-11: 392 783 8955 (Italy, +39) went out as +392 783 8955. In a country without a trunk prefix,
  // a national number of the longest national length that begins with the code's digits keeps the code added once.
  for (const country of NO_TRUNK_COUNTRIES) {
    it(`${country}: national number beginning with the code`, () => {
      const cc = callingCodeOf(country)!;
      const national = (cc + "1234567890123").slice(0, nationalMaxOf(country));
      expect(normalisePhoneE164(national, country)).toBe(`+${cc}${national}`);
      expect(normalisePhoneE164(cc + national, country)).toBe(`+${cc}${national}`);
      expect(normalisePhoneE164(`+${cc}${national}`, country)).toBe(`+${cc}${national}`);
    });
  }
  // International numbers written without "+": one code, shortest and longest real forms.
  const intl: [string, string, string][] = [
    ["49301234567", "DE", "+49301234567"],
    ["4930123456", "DE", "+4930123456"],
    ["436641234567", "AT", "+436641234567"],
    ["4312345678", "AT", "+4312345678"],
    ["39021234567", "IT", "+39021234567"],
    ["393927838955", "IT", "+393927838955"],
    ["35212345678", "LU", "+35212345678"],
    ["36301234567", "HU", "+36301234567"],
    ["359888123456", "BG", "+359888123456"],
    ["421901123456", "SK", "+421901123456"],
    ["420601123456", "CZ", "+420601123456"],
    ["306912345678", "GR", "+306912345678"],
    ["40721123456", "RO", "+40721123456"],
    ["48600100200", "PL", "+48600100200"],
    ["385911234567", "HR", "+385911234567"],
  ];
  for (const [raw, country, want] of intl)
    it(`${raw} (${country}) → ${want}`, () => expect(normalisePhoneE164(raw, country)).toBe(want));
  it("a group's own rule: guarded only without a trunk prefix", () => {
    expect(normalisePhoneE164("3831234567", "XK", { cc: "383", trunk: "" })).toBe("+3833831234567");
    expect(normalisePhoneE164("38344123456", "XK", { cc: "383", trunk: "0" })).toBe("+38344123456");
  });
});

describe("FHB order pre-flight", () => {
  it("a complete order passes", () => {
    expect(validateFhbOrder(good())).toEqual([]);
  });

  it("every finding carries both languages", () => {
    const all = validateFhbOrder(
      good({ email: "x".repeat(60), phone: "nope", name: "", lines: [], country: "?", localCurrency: null }),
    );
    expect(all.length).toBeGreaterThan(4);
    for (const x of all) {
      expect(x.message_bg.length).toBeGreaterThan(3);
      expect(x.message_en.length).toBeGreaterThan(3);
      expect(["hard", "soft"]).toContain(x.severity);
    }
  });

  it("blocks missing required fields with FHB field paths", () => {
    const findings = validateFhbOrder(good({ name: " ", street: null, city: "", zip: null }));
    expect(findings.map((x) => x.field)).toEqual(
      expect.arrayContaining([
        "recipient.address.name",
        "recipient.address.street",
        "recipient.address.city",
        "recipient.address.zip",
      ]),
    );
    expect(hasHardBlock(findings)).toBe(true);
  });

  it("email over 50 chars is a hard block", () => {
    expect(codes(good({ email: `${"a".repeat(45)}@example.com` }))).toContain("fhb.contact.email_too_long");
    expect(codes(good({ email: "not-an-email" }))).toContain("fhb.contact.email_invalid");
  });

  it("phone must be normalisable for the destination; a fix is suggested otherwise", () => {
    expect(codes(good({ phone: "hello" }))).toContain("fhb.contact.phone_invalid");
    const n = validateFhbOrder(good({ phone: "0900 000 000" })).find(
      (x) => x.code === "fhb.contact.phone_normalised",
    );
    expect(n?.severity).toBe("soft");
    expect(n?.suggestedFix).toEqual({ field: "recipient.contact.phone", value: "+421900000000" });
  });

  it("variable symbol must be digits, max 10", () => {
    expect(codes(good({ variableSymbol: "12345678901" }))).toContain("fhb.order.variable_symbol_invalid");
    expect(codes(good({ variableSymbol: "12A" }))).toContain("fhb.order.variable_symbol_invalid");
    expect(codes(good({ variableSymbol: null }))).toContain("fhb.order.variable_symbol_invalid");
  });

  it("unmapped, missing-at-vendor and out-of-stock lines are hard blocks", () => {
    const line = good().lines[0]!;
    expect(codes(good({ lines: [{ ...line, vendorProductId: null }] }))).toContain("fhb.line.unmapped");
    expect(codes(good({ lines: [{ ...line, vendorActive: false }] }))).toContain("fhb.line.vendor_missing");
    expect(codes(good({ lines: [{ ...line, freeQuantity: 1 }] }))).toContain("fhb.stock.insufficient");
    expect(codes(good({ lines: [{ ...line, freeQuantity: null }] }))).toContain("fhb.stock.insufficient");
    // the same product on two lines counts once against free stock
    expect(codes(good({ lines: [line, { ...line, quantity: 4 }] }))).toContain("fhb.stock.insufficient");
    expect(codes(good({ lines: [] }))).toContain("fhb.order.no_lines");
  });

  it("stale stock snapshot is a warning", () => {
    const line = { ...good().lines[0]!, stockSnapshotAt: new Date(NOW.getTime() - 2 * 3600_000) };
    const f = validateFhbOrder(good({ lines: [line] })).find((x) => x.code === "fhb.stock.snapshot_stale");
    expect(f?.severity).toBe("soft");
  });

  it("COD must be in the destination's local currency", () => {
    expect(codes(good({ codCurrency: "BGN" }))).toContain("fhb.cod.not_convertible");
    expect(codes(good({ codAmount: null }))).toContain("fhb.cod.not_convertible");
    expect(codes(good({ localCurrency: null }))).toContain("fhb.cod.no_local_currency");
    expect(codes(good({ isCod: false, localCurrency: null, codAmount: null }))).not.toContain(
      "fhb.cod.no_local_currency",
    );
    expect(codes(good({ codAmount: 0 }))).toContain("fhb.cod.zero");
  });

  it("a fractional COD in a whole-unit currency (HUF) is a soft finding", () => {
    const huf = { codCurrency: "HUF", localCurrency: "HUF", country: "HU" };
    expect(codes(good({ ...huf, codAmount: 12345.67 }))).toContain("fhb.cod.fractional");
    expect(codes(good({ ...huf, codAmount: 12345 }))).not.toContain("fhb.cod.fractional");
    expect(codes(good({ codAmount: 12.5 }))).not.toContain("fhb.cod.fractional");
    const found = validateFhbOrder({ ...good({ ...huf, codAmount: 1.5 }) }).find(
      (x) => x.code === "fhb.cod.fractional",
    );
    expect(found?.severity).toBe("soft");
  });

  it("duplicate id and PUDO without a point are hard blocks", () => {
    expect(codes(good({ duplicateExternalId: true }))).toContain("fhb.order.duplicate_id");
    expect(codes(good({ requiresDeliveryPoint: true, deliveryPoint: null }))).toContain(
      "fhb.order.delivery_point_missing",
    );
    expect(codes(good({ requiresDeliveryPoint: true, deliveryPoint: "12345" }))).not.toContain(
      "fhb.order.delivery_point_missing",
    );
  });

  it("soft warnings: house number, note, risk, unconverted value", () => {
    const f = validateFhbOrder(
      good({
        street: "Example street",
        note: "n".repeat(300),
        customerNote: "ring twice",
        riskLevel: "HIGH",
        valueNotConverted: true,
      }),
    );
    expect(f.map((x) => x.code).sort()).toEqual(
      [
        "fhb.address.street_no_number",
        "fhb.order.customer_note",
        "fhb.order.note_truncated",
        "fhb.order.risk",
        "fhb.value.not_converted",
      ].sort(),
    );
    expect(hasHardBlock(f)).toBe(false);
  });
});

describe("FHB product pre-flight", () => {
  it("passes a simple product", () => {
    expect(validateFhbProduct({ vendorProductId: "R-SKU-1", name: "Sample", targetType: "single" })).toEqual(
      [],
    );
  });
  it("id chars, name length, URLs", () => {
    const c = validateFhbProduct({
      vendorProductId: "R#1",
      name: "n".repeat(151),
      photo: "https://x/" + "p".repeat(260),
      notifyUrl: "https://x/" + "p".repeat(260),
    }).map((x) => x.code);
    expect(c).toEqual(
      expect.arrayContaining([
        "fhb.product.id_chars",
        "fhb.product.name_too_long",
        "fhb.product.photo_too_long",
        "fhb.product.notify_url_too_long",
      ]),
    );
  });
  it("multi-product rules mirror FHB's error codes", () => {
    const c = validateFhbProduct({
      vendorProductId: "SET-1",
      name: "Set",
      targetType: "multi",
      components: [
        { id: "A", quantity: 1, exists: true, type: "single" },
        { id: "A", quantity: 1, exists: true, type: "single" },
        { id: "SET-1", quantity: 1, exists: true, type: "multi" },
        { id: "B", quantity: 1, exists: false, type: null },
        { id: "C", quantity: 0, exists: true, type: "multi" },
      ],
    }).map((x) => x.code);
    expect(c).toEqual(
      expect.arrayContaining([
        "fhb.product.multi_duplicate",
        "fhb.product.multi_self",
        "fhb.product.multi_component_missing",
        "fhb.product.multi_nested",
        "fhb.product.multi_quantity",
      ]),
    );
    expect(
      validateFhbProduct({ vendorProductId: "S", name: "S", targetType: "multi" }).map((x) => x.code),
    ).toEqual(["fhb.product.multi_empty"]);
    expect(
      validateFhbProduct({ vendorProductId: "S", name: "S", currentType: "multi", targetType: "single" }).map(
        (x) => x.code,
      ),
    ).toEqual(["fhb.product.demote_not_supported"]);
  });
});

describe("FHB stock receipt pre-flight", () => {
  it("checks name, lines and multi-products", () => {
    expect(
      validateFhbStockReceipt({
        externalRef: "SR-1",
        name: "Inbound 1",
        lines: [{ label: "A", vendorProductId: "R-A", quantity: 3 }],
      }),
    ).toEqual([]);
    const c = validateFhbStockReceipt({
      externalRef: "SR-1",
      name: "x".repeat(51),
      expectedDate: "02.11.2026",
      lines: [
        { label: "A", vendorProductId: null, quantity: 1 },
        { label: "B", vendorProductId: "R-B", quantity: 0, vendorType: "multi" },
      ],
    }).map((x) => x.code);
    expect(c).toEqual(
      expect.arrayContaining([
        "fhb.receipt.name_invalid",
        "fhb.receipt.date_invalid",
        "fhb.receipt.unmapped",
        "fhb.receipt.multi_product",
        "fhb.receipt.quantity_invalid",
      ]),
    );
  });
});

it("maps vendor violations to findings on the same field", () => {
  expect(findingsFromViolations({ "recipient.address.zip": ["IS_BLANK_ERROR"] })).toEqual([
    expect.objectContaining({
      code: "fhb.vendor.IS_BLANK_ERROR",
      field: "recipient.address.zip",
      severity: "hard",
    }),
  ]);
});
