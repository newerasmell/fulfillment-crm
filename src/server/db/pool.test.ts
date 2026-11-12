import { describe, expect, it } from "vitest";
import { poolMax } from "./client";

describe("database pool size", () => {
  it("10 by default; DB_POOL_MAX within 5–50", () => {
    expect(poolMax({})).toBe(10);
    expect(poolMax({ DB_POOL_MAX: "30" })).toBe(30);
    expect(poolMax({ DB_POOL_MAX: "2" })).toBe(10);
    expect(poolMax({ DB_POOL_MAX: "500" })).toBe(10);
    expect(poolMax({ DB_POOL_MAX: "x" })).toBe(10);
  });
});
