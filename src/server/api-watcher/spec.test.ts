import { describe, expect, it } from "vitest";
import { z } from "zod";
import { affectedFiles, buildUpgradeBrief } from "./brief";
import { diffSpecs } from "./diff";
import { checkEnum, unknownKeys, validateProbe } from "./live-check";
import {
  canonicalise,
  hashDocument,
  htmlTables,
  normaliseDocument,
  normaliseOpenApi,
  normalisePostman,
  parseAnnotatedJson,
} from "./normalise";
import { evaluatePinnedVersion, supportEndsAt } from "./shopify-version";
import { SPEC_SOURCES } from "./sources";
import { syntheticOpenApi, syntheticPostman } from "./__fixtures__/specs";

// Synthetic specs only, shaped like the vendor references (no real fetch, no real data).

describe("normalise", () => {
  it("hash ignores key order and Postman publish metadata, but not content", () => {
    const a = syntheticOpenApi();
    const reverse = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverse)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, x]) => [k, reverse(x)]),
            )
          : v;
    const reordered = reverse(a) as Record<string, unknown>;
    expect(Object.keys(reordered)[0]).toBe("components");
    expect(hashDocument(canonicalise(reordered))).toBe(hashDocument(canonicalise(a)));

    const p1 = syntheticPostman();
    const p2 = syntheticPostman();
    (p2.info as Record<string, unknown>)._postman_id = "another-publish";
    (p2.info as Record<string, unknown>).publishDate = "2026-12-01T00:00:00Z";
    expect(normaliseDocument("postman", p2).hash).toBe(normaliseDocument("postman", p1).hash);
    const p3 = syntheticPostman({ extraField: true });
    expect(normaliseDocument("postman", p3).hash).not.toBe(normaliseDocument("postman", p1).hash);
  });

  it("reduces an OpenAPI document to endpoints, params, body and response fields ($ref resolved)", () => {
    const n = normaliseOpenApi(syntheticOpenApi());
    expect(Object.keys(n.endpoints).sort()).toEqual(["GET /order", "GET /stock", "POST /order"]);
    const post = n.endpoints["POST /order"]!;
    expect(post.request["body:id"]).toEqual({
      type: "string",
      required: true,
      constraints: { maxLength: 20 },
    });
    expect(post.request["body:items[].product"]).toMatchObject({ type: "string", required: true });
    expect(post.request["body:carrier"]).toEqual({ type: "string", required: false, enum: ["dpd", "gls"] });
    const get = n.endpoints["GET /order"]!;
    expect(get.request["query:id"]).toEqual({ type: "string", required: true });
    expect(get.response["200:status"]).toMatchObject({ enum: ["confirmed", "pending", "sent"] });
    expect(n.changelog).toEqual(["#### 2026-07-01", "- Added `GET /stock`."]);
    expect(n.version).toBe("3.0");
  });

  it("survives recursive schemas", () => {
    const doc = syntheticOpenApi();
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> }).schemas;
    schemas.Order!.properties = {
      ...(schemas.Order!.properties as object),
      parent: { $ref: "#/components/schemas/Order" },
    };
    expect(() => normaliseOpenApi(doc)).not.toThrow();
  });

  it("reads Postman requests: method + path (ids folded), field tables, status tables, annotated bodies", () => {
    const n = normalisePostman(syntheticPostman());
    const keys = Object.keys(n.endpoints).sort();
    expect(keys).toEqual([
      "GET /api/v1/get-status/{} [Shipment_Status_Web_Service]",
      "POST /api/v1/createAWB [Shipment_Creation_Web_Service]",
    ]);
    const create = n.endpoints["POST /api/v1/createAWB [Shipment_Creation_Web_Service]"]!;
    expect(create.request["body:recipient.phone"]).toEqual({
      type: "string",
      required: true,
      constraints: { restrictions: "max 20 characters" },
    });
    expect(create.request["body:testMode"]).toBeDefined();
    expect(create.response["field:awb"]).toEqual({ type: "documented" });
    const status = n.endpoints["GET /api/v1/get-status/{} [Shipment_Status_Web_Service]"]!;
    expect(status.request["query:testMode"]).toBeDefined();
    expect(status.response["enum:Statuses"]?.enum).toEqual(["1=New", "2=Delivered"]);
    expect(n.changelog).toEqual(["Shipment_Creation_Web_Service 1.5: Added recipient.phone rules"]);
  });

  it("parses annotated JSON bodies without eating URLs inside strings", () => {
    expect(parseAnnotatedJson('{\n "a": 1, // note\n "url": "https://x.example/y", // c\n}')).toEqual({
      a: 1,
      url: "https://x.example/y",
    });
    expect(parseAnnotatedJson("not json")).toBeNull();
  });

  it("extracts tables with their headings", () => {
    const t = htmlTables(
      "<p><strong>awb.packages</strong></p><table><thead><tr><th>field</th><th>type</th></tr></thead><tbody><tr><td>weight</td><td>float</td></tr></tbody></table>",
    );
    expect(t).toEqual([{ heading: "awb.packages", header: ["field", "type"], rows: [["weight", "float"]] }]);
  });
});

describe("diff and upgrade brief", () => {
  const before = normaliseOpenApi(syntheticOpenApi());
  const after = normaliseOpenApi(syntheticOpenApi({ changed: true }));
  const diff = diffSpecs(before, after);
  const find = (kind: string, field?: string) =>
    diff.changes.find((c) => c.kind === kind && (field === undefined || c.field === field));

  it("classifies breaking vs additive from our side of the integration", () => {
    expect(find("endpoint_removed")).toMatchObject({ endpoint: "GET /stock", severity: "breaking" });
    expect(find("endpoint_added")).toMatchObject({ endpoint: "GET /rma/list", severity: "additive" });
    // New required input, removed response field, new status value: we break.
    expect(find("field_added", "body:note")).toMatchObject({ severity: "breaking" });
    expect(find("field_removed", "200:tracking")).toMatchObject({ severity: "breaking", side: "response" });
    expect(find("enum_added", "200:status")).toMatchObject({ severity: "breaking", after: ["returned"] });
    // New optional input, new carrier value we may send, new response field: additive.
    expect(find("field_added", "body:cod_currency")).toMatchObject({ severity: "additive" });
    expect(find("enum_added", "body:carrier")).toMatchObject({ severity: "additive", after: ["packeta"] });
    expect(find("field_added", "200:weight")).toMatchObject({ severity: "additive" });
    // Tighter input rule: breaking.
    expect(find("constraints_changed", "body:id")).toMatchObject({ severity: "breaking" });
    expect(find("changelog")).toMatchObject({ severity: "info" });
    expect(diff.counts.breaking).toBe(diff.changes.filter((c) => c.severity === "breaking").length);
    expect(diff.changes[0]!.severity).toBe("breaking");
  });

  it("identical specs give no changes", () => {
    expect(diffSpecs(before, before)).toEqual({ counts: { breaking: 0, additive: 0, info: 0 }, changes: [] });
  });

  it("the brief lists breaking and additive changes, the affected adapter files and the steps", () => {
    const source = SPEC_SOURCES.find((s) => s.vendor === "FHB_V3")!;
    const brief = buildUpgradeBrief({
      source,
      diff,
      previous: { hash: "a".repeat(64), fetchedAt: new Date("2026-11-01T02:23:00Z") },
      current: { hash: "b".repeat(64), fetchedAt: new Date("2026-11-02T02:23:00Z") },
    });
    expect(brief).toContain("# Upgrade brief: FHB Kika API v3");
    expect(brief).toMatch(/## Breaking \(\d+\)/);
    expect(brief).toMatch(/## Additive \(\d+\)/);
    expect(brief).toContain("`GET /stock`: endpoint removed");
    expect(brief).toContain("src/integrations/fhb-v3/status-map.ts");
    expect(brief).toContain("src/integrations/fhb-v3/validators.ts");
    expect(brief).toContain("pnpm docs:refresh");
    expect(brief).toContain("DRY_RUN");
    expect(affectedFiles(source, [])).toEqual([]);
  });
});

describe("Shopify version calendar", () => {
  it("support ends 12 months after the release month", () => {
    expect(supportEndsAt("2026-10")?.toISOString()).toBe("2027-10-01T00:00:00.000Z");
    expect(supportEndsAt("unstable")).toBeNull();
  });
  it("warns 90 days ahead, critical 30 days ahead or when Shopify no longer supports it", () => {
    expect(evaluatePinnedVersion("2026-10", new Date("2026-11-02T00:00:00Z")).level).toBe("ok");
    expect(evaluatePinnedVersion("2026-10", new Date("2027-07-15T00:00:00Z")).level).toBe("warning");
    expect(evaluatePinnedVersion("2026-10", new Date("2027-09-15T00:00:00Z")).level).toBe("critical");
    const reported = [
      { handle: "2026-07", supported: true },
      { handle: "2026-10", supported: true },
      { handle: "2027-01", supported: true },
    ];
    expect(evaluatePinnedVersion("2026-10", new Date("2026-11-02T00:00:00Z"), reported).level).toBe("ok");
    expect(evaluatePinnedVersion("2026-10", new Date("2026-11-02T00:00:00Z"), reported.slice(1)).level).toBe(
      "warning",
    );
    expect(
      evaluatePinnedVersion("2026-10", new Date("2026-11-02T00:00:00Z"), [
        { handle: "2026-10", supported: false },
      ]),
    ).toMatchObject({ level: "critical" });
  });
});

describe("live check validation helpers", () => {
  const Schema = z.object({ a: z.string(), items: z.array(z.object({ id: z.number() })) });
  it("schema mismatches are breaking issues with paths and no values", () => {
    const r = validateProbe("p", Schema, { a: 1, items: [{ id: "secret-value" }] });
    expect(r.issues.every((i) => i.breaking && i.code === "schema_mismatch")).toBe(true);
    expect(r.issues.map((i) => i.path).sort()).toEqual(["a", "items[].id"]);
    expect(JSON.stringify(r.issues)).not.toContain("secret-value");
  });
  it("new fields are reported, not breaking", () => {
    const r = validateProbe("p", Schema, { a: "x", extra: 1, items: [{ id: 1, more: true }] });
    expect(r.data).toBeDefined();
    expect(r.issues).toEqual([
      { breaking: false, probe: "p", code: "new_field", path: "extra", message: "new field" },
      { breaking: false, probe: "p", code: "new_field", path: "items[].more", message: "new field" },
    ]);
    expect([...unknownKeys({ a: 1 }, { a: 1 })]).toEqual([]);
  });
  it("unknown enum values are non-breaking issues", () => {
    const known = new Set(["pending", "sent"]);
    expect(checkEnum("p", "status", "sent", known)).toBeUndefined();
    expect(checkEnum("p", "status", "lost", known)).toMatchObject({ breaking: false, code: "unknown_enum" });
  });
});
