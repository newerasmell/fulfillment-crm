import { describe, expect, it } from "vitest";
import { DEFAULT_LOCAL_CURRENCY, localCurrencyFor } from "./currency";

describe("local currency per country", () => {
  it("own setting wins, else the built-in default, else unknown", () => {
    expect(localCurrencyFor({ currency: "bgn" }, "BG")).toBe("BGN");
    expect(localCurrencyFor(null, "gr")).toBe("EUR");
    expect(localCurrencyFor({ currency: null }, "RO")).toBe("RON");
    expect(localCurrencyFor(null, "MK")).toBeNull();
    expect(localCurrencyFor(null, null)).toBeNull();
    for (const c of ["GR", "CY", "BG", "HR", "SK"]) expect(DEFAULT_LOCAL_CURRENCY[c]).toBe("EUR");
    expect(DEFAULT_LOCAL_CURRENCY.HU).toBe("HUF");
  });
});
