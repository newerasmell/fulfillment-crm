import { describe, expect, it } from "vitest";
import { boardChunkSize } from "./board";

// Owner report 2026-11-12: 4000+ masters × many stores passed PostgreSQL's 32767 bind parameters in one read.
describe("stock board chunk size", () => {
  it("keeps every nested read well under the bind-parameter limit", () => {
    for (const stores of [0, 1, 5, 12, 30, 80, 200])
      for (const connections of [1, 3, 10]) {
        const n = boardChunkSize(stores, connections);
        expect(n).toBeGreaterThanOrEqual(20);
        expect(n).toBeLessThanOrEqual(500);
        // ~2 binds per parent (composite keys) × up to 2 listings per store.
        if (stores <= 250) expect(n * 4 * Math.max(1, stores, connections)).toBeLessThanOrEqual(20_000);
      }
  });
});
