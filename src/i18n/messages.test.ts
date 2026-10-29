import { describe, expect, it } from "vitest";
import bg from "../../messages/bg.json";
import en from "../../messages/en.json";

function keys(obj: unknown, prefix = ""): string[] {
  if (!obj || typeof obj !== "object") return [prefix];
  return Object.entries(obj).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

describe("i18n", () => {
  it("bg and en have exactly the same keys", () => {
    expect(keys(en).sort()).toEqual(keys(bg).sort());
  });
});
