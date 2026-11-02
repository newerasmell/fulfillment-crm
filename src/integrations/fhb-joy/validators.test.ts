import { describe, expect, it } from "vitest";
import { buildJoyShipment, trackingFromLabel } from "./mapper";
import { isJoyRejectable, mapJoyStatus } from "./status-map";
import { validateJoyShipment, type JoyShipmentDraft } from "./validators";

// Synthetic data only.
const ok: JoyShipmentDraft = {
  id: "M-M1001",
  variableSymbol: "1001",
  parcelService: "pplcz",
  allowedParcelServices: ["pplcz", "posta_expres"],
  name: "Test Recipient",
  street: "Testovacia 12",
  city: "Testov",
  zip: "75501",
  country: "CZ",
  email: "recipient@example.com",
  phone: "+420601000000",
  cod: 250,
  codCurrency: "CZK",
  localCurrency: "CZK",
  numberOfPackages: 1,
  weights: [1.2],
};
const codes = (d: Partial<JoyShipmentDraft>) => validateJoyShipment({ ...ok, ...d }).map((f) => f.code);

describe("validateJoyShipment", () => {
  it("passes a complete draft", () => expect(validateJoyShipment(ok)).toEqual([]));

  it.each<[Partial<JoyShipmentDraft>, string]>([
    [{ name: "Al" }, "joy.name.short"],
    [{ street: "A1" }, "joy.street.short"],
    [{ city: "X" }, "joy.city.short"],
    [{ zip: "12" }, "joy.zip.length"],
    [{ zip: "1234567890123" }, "joy.zip.length"],
    [{ country: "CZE" }, "joy.country.invalid"],
    [{ email: null }, "joy.email.missing"],
    [{ email: `${"a".repeat(45)}@example.com` }, "joy.email.too_long"],
    [{ phone: "12" }, "joy.phone.invalid"],
    [{ parcelService: null }, "joy.parcel_service.missing"],
    [{ parcelService: "dpd" }, "joy.parcel_service.not_enabled"],
    [{ parcelService: "posta_expres", variableSymbol: "A1" }, "joy.variable_symbol.posta_expres"],
    [{ parcelService: "posta_expres", variableSymbol: "12345678901" }, "joy.variable_symbol.posta_expres"],
    [{ numberOfPackages: 2, weights: [1] }, "joy.weight.count"],
    [{ numberOfPackages: 0, weights: null }, "joy.packages.invalid"],
    [{ requiresDeliveryPoint: true, deliveryPoint: null }, "joy.delivery_point.missing"],
    [{ note: "x".repeat(251) }, "joy.note.too_long"],
    [{ codCurrency: "EUR" }, "joy.cod.currency"],
    [{ localCurrency: null }, "joy.cod.no_local_currency"],
    [{ duplicateId: true }, "joy.id.duplicate"],
  ])("hard: %o → %s", (patch, code) => {
    const found = validateJoyShipment({ ...ok, ...patch }).find((f) => f.code === code);
    expect(found?.severity).toBe("hard");
  });

  it("soft warnings: street without number, phone normalised, fractional HUF, unconfigured services", () => {
    expect(codes({ street: "Hlavna ulica" })).toContain("joy.street.no_number");
    expect(codes({ phone: "+420 601 000 000" })).toContain("joy.phone.normalised");
    expect(
      codes({ country: "HU", cod: 1000.5, codCurrency: "HUF", localCurrency: "HUF", phone: "+36301234567" }),
    ).toContain("joy.cod.fractional");
    expect(codes({ allowedParcelServices: [] })).toContain("joy.parcel_service.unconfigured");
  });

  it("no COD needs no currency", () => {
    expect(codes({ cod: null, codCurrency: null, localCurrency: null })).toEqual([]);
  });
});

describe("buildJoyShipment", () => {
  it("lowercases the country, rounds COD and keeps one weight per package", () => {
    const b = buildJoyShipment({ ...ok, cod: 250.004, note: " hi " });
    expect(b.country).toBe("cz");
    expect(b.cod).toBe(250);
    expect(b.note).toBe("hi");
    expect(b.weight).toEqual([1.2]);
    expect(b.id).toBe("M-M1001");
  });
  it("omits COD when there is none", () => {
    expect(buildJoyShipment({ ...ok, cod: null }).cod).toBeUndefined();
  });
  it("refuses a draft the schema would refuse (never sends something Joy rejects)", () => {
    expect(() => buildJoyShipment({ ...ok, email: "not-an-email" })).toThrow();
  });
  it("reads tracking numbers from packages", () => {
    expect(
      trackingFromLabel({ packages: [{ tracking: "T1" }, { tracking: null }, { tracking: "T1" }] }),
    ).toEqual(["T1"]);
  });
});

describe("mapJoyStatus", () => {
  it.each([
    ["pending", "ACCEPTED"],
    ["confirmed", "PROCESSING"],
    ["sent", "SHIPPED"],
    ["delivered", "DELIVERED"],
    ["returned", "RETURN_RECEIVED"],
    ["rejected", "CANCELLED"],
  ])("%s → %s", (raw, crm) => {
    expect(mapJoyStatus(raw).status).toBe(crm);
    expect(mapJoyStatus(raw).alert).toBeNull();
  });
  it("undefined and unknown values are UNKNOWN with an alert, never thrown", () => {
    expect(mapJoyStatus("undefined")).toMatchObject({
      status: "UNKNOWN",
      alert: "unknown_status",
      raw: "undefined",
    });
    expect(mapJoyStatus("brand_new")).toMatchObject({ status: "UNKNOWN", raw: "brand_new" });
    expect(mapJoyStatus(null).status).toBe("UNKNOWN");
  });
  it("reject is offered only while pending or not read yet", () => {
    expect(isJoyRejectable("pending")).toBe(true);
    expect(isJoyRejectable(null)).toBe(true);
    expect(isJoyRejectable("sent")).toBe(false);
  });
});
