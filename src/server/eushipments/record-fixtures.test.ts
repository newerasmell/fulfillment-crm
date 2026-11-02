import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import products from "@/integrations/eushipments/__fixtures__/get-products.json";
import RD from "@/integrations/eushipments/__fixtures__/read.json";
import { findUnscrubbed, type Endpoint } from "@/integrations/eushipments/fixtures/scrub";
import { recordEuFixtures } from "./record-fixtures";
import { euTestGroup } from "./test-fixtures";

// The recorder is exercised against a mocked vendor only (it is RUN by the owner at the gate, never here).
describe("euShipments fixtures:record", () => {
  it("reads only, scrubs everything and refuses responses with unknown fields", async () => {
    const g = await euTestGroup("record");
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (u: string, init?: RequestInit) => {
      const p = new URL(u).pathname.replace("/api/v1", "");
      calls.push(`${init?.method ?? "GET"} ${p}`);
      if (p === "/get-user-companies") return Response.json(RD.userCompanies);
      if (p.startsWith("/couriers/")) return Response.json(RD.couriers);
      if (p === "/fulfilment/warehouses") return Response.json(RD.warehouses);
      if (p === "/get-countries") return Response.json(RD.countries);
      // a field the scrubber does not know → this file must not be written
      if (p.startsWith("/fulfilment/get-products"))
        return Response.json([{ ...products[0], SECRET_NEW: "x" }]);
      if (p === "/fulfilment/get-prod-avails") return Response.json(RD.prodAvails);
      throw new Error(`unexpected ${p}`);
    });
    const outDir = mkdtempSync(path.join(tmpdir(), "eu-rec-"));
    const r = await recordEuFixtures(g.accountId, g.connection.id, {
      outDir,
      clientOptions: { fetchImpl, sleep: async () => {} },
    });
    expect(calls.every((c) => c.startsWith("GET ") || c === "POST /fulfilment/warehouses")).toBe(true);
    expect(r.refused).toEqual([{ endpoint: "get-products", unclassified: ["[0].SECRET_NEW"] }]);
    const files = readdirSync(outDir).sort();
    expect(files).toEqual(
      ["couriers", "get-countries", "get-prod-avails", "get-user-companies", "warehouses"].map(
        (f) => `${f}.json`,
      ),
    );
    for (const f of files) {
      const text = readFileSync(path.join(outDir, f), "utf8");
      const fx = JSON.parse(text) as { endpoint: Endpoint; response: unknown };
      expect(findUnscrubbed(fx.endpoint, fx.response)).toEqual([]);
      expect(text).not.toContain("Example Company");
      expect(text).not.toContain("ref-test-54202");
      expect(text).not.toContain("test-token-not-real");
    }
  });
});
