import { describe, expect, it } from "vitest";
import { jsonEqual } from "./json-equal";

describe("jsonEqual", () => {
  it("ignores key order, not values", () => {
    expect(
      jsonEqual({ a: 1, b: { c: [1, { d: 2, e: null }] } }, { b: { c: [1, { e: null, d: 2 }] }, a: 1 }),
    ).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual(null, undefined)).toBe(true);
  });
});
