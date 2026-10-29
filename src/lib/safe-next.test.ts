import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it("allows only invitation paths", () => {
    const token = "a".repeat(43);
    expect(safeNext(`/invite/${token}`)).toBe(`/invite/${token}`);
    for (const bad of [
      "https://evil.example",
      "//evil.example",
      "/settings/members",
      `/invite/${token}/../x`,
      null,
      5,
    ]) {
      expect(safeNext(bad)).toBe("/");
    }
  });
});
