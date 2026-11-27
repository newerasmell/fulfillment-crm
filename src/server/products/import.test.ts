import { beforeAll, describe, expect, it } from "vitest";
import { systemDb } from "@/server/db/client";
import { euTestGroup } from "@/server/eushipments/test-fixtures";
import { applyImport, importTemplate, parseImportTable, planImport } from "./import";

// „Импорт от Excel“ (owner request 2026-11-23). Synthetic data only.
describe("product import: pure checks", () => {
  it("the template has exactly the warehouse's columns", () => {
    expect(importTemplate("FHB_V3")[0]).toEqual([
      "SKU",
      "Име",
      "EAN",
      "Снимка (URL)",
      "HS код",
      "Държава на произход",
    ]);
    expect(importTemplate("EUSHIPMENTS")[0]).toContain("Тегло (г)");
  });

  it("euShipments needs barcode, weight and size within its limits; headers may be in English", () => {
    const head = ["sku", "name", "barcode", "weight", "length", "width", "height"];
    const { rows } = parseImportTable("EUSHIPMENTS", [
      head,
      ["SYN-1", "Synthetic 50 ml", "2000000000015", "350", "60", "40", "120"],
      ["SYN-2", "No barcode", "", "5", "60", "40", "120000"],
      ["SYN-1", "Duplicate", "2000000000039", "350", "60", "40", "120"],
      ["BAD SKU", "", "12", "", "", "", ""],
    ]);
    expect(rows[0]?.errors).toEqual([]);
    expect(rows[0]?.values).toMatchObject({ weightGrams: 350, lengthMm: 60, heightMm: 120 });
    expect(rows[1]?.errors).toEqual(
      expect.arrayContaining(["ean_missing", "weight_invalid", "height_invalid"]),
    );
    expect(rows[2]?.errors).toContain("sku_duplicate");
    expect(rows[3]?.errors).toEqual(
      expect.arrayContaining(["sku_invalid", "name_missing", "weight_missing", "length_missing"]),
    );
  });

  it("barcode and HS code as each warehouse takes them; thousands separators refused", () => {
    const eu = parseImportTable("EUSHIPMENTS", [
      ["SKU", "Име", "Баркод (EAN)", "Тегло (г)", "Дължина (мм)", "Ширина (мм)", "Височина (мм)", "HS код"],
      ["SYN-4", "x", "bb-test-54202", "1.000", "60", "40", "120", "640399.30.00"],
    ]).rows[0]!;
    expect(eu.errors).toEqual(["weight_invalid"]);
    const fhb = parseImportTable("FHB_V3", [
      ["SKU", "Име", "EAN"],
      ["SYN-5", "x", "bb-test-54202"],
    ]).rows[0]!;
    expect(fhb.errors).toEqual(["ean_invalid"]);
  });

  it("euShipments' own import file: reference number is the SKU, cm / kg become mm / g (owner 2026-11-26)", () => {
    const { rows, fileErrors } = parseImportTable("EUSHIPMENTS", [
      [
        "name",
        "barcode",
        "description",
        "length (cm)",
        "width (cm)",
        "height (cm)",
        "weight (kg)",
        "reference number",
      ],
      ["Synthetic Cap", "SYN-BC-1", "", "20", "20", "8", "0.2", "SYN-REF-1"],
      ["Synthetic Bag", "SYN-BC-2", "x", "35,5", "12.4", "40", "1,25", "SYN-REF-2"],
      ["Synthetic Bad", "SYN-BC-3", "", "20", "abc", "8", "0.005", "SYN-REF-3"],
    ]);
    expect(fileErrors).toEqual([]);
    expect(rows[0]).toMatchObject({
      errors: [],
      values: {
        sku: "SYN-REF-1",
        name: "Synthetic Cap",
        ean: "SYN-BC-1",
        lengthMm: 200,
        widthMm: 200,
        heightMm: 80,
        weightGrams: 200,
      },
    });
    expect(rows[1]).toMatchObject({
      errors: [],
      values: { lengthMm: 355, widthMm: 124, heightMm: 400, weightGrams: 1250 },
    });
    // Bulgarian headers with units, bracketed units, bounds and empty / negative cells.
    const more = parseImportTable("EUSHIPMENTS", [
      ["reference number", "name", "barcode", "Дължина (см)", "Ширина [см]", "Височина, см", "Тегло (кг)"],
      ["SYN-REF-4", "Bounds ok", "SYN-BC-4", "999", "0.1", "1", "999"],
      ["SYN-REF-5", "Bounds out", "SYN-BC-5", "999.1", "-1", "", "999.1"],
      ["SYN-REF-6", "Comma kg", "SYN-BC-6", "10", "10", "10", "1,000"],
    ]);
    expect(more.fileErrors).toEqual([]);
    expect(more.rows[0]).toMatchObject({
      errors: [],
      values: { lengthMm: 9990, widthMm: 1, weightGrams: 999_000 },
    });
    expect(more.rows[1]!.errors).toEqual(
      expect.arrayContaining(["length_invalid", "width_invalid", "height_missing", "weight_invalid"]),
    );
    expect(more.rows[2]).toMatchObject({ errors: [], values: { weightGrams: 1000 } });
    // Not a number, and below euShipments' 10 g minimum: refused, never guessed.
    expect(rows[2]!.errors).toEqual(expect.arrayContaining(["width_invalid", "weight_invalid"]));
  });

  it("FHB needs only SKU and name; a missing required column is a file error", () => {
    expect(
      parseImportTable("FHB_V3", [
        ["SKU", "Име"],
        ["SYN-3", "Synthetic"],
      ]).rows[0]?.errors,
    ).toEqual([]);
    expect(parseImportTable("FHB_V3", [["SKU"], ["SYN-3"]])).toMatchObject({
      fileErrors: ["missing_columns"],
      missingCols: ["Име"],
    });
  });
});

describe("product import: plan and apply", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  beforeAll(async () => {
    g = await euTestGroup("import");
  });
  const table = (rows: string[][]) =>
    parseImportTable("EUSHIPMENTS", [
      ["SKU", "Име", "Баркод (EAN)", "Тегло (г)", "Дължина (мм)", "Ширина (мм)", "Височина (мм)"],
      ...rows,
    ]).rows;

  it("euShipments' own file: its prefixed reference number finds the existing master (never a second one)", async () => {
    const stamp = Date.now();
    await systemDb().fulfillmentConnection.update({
      where: { id: g.connection.id },
      data: { skuPrefixRule: { prefix: "SYNP-" } },
    });
    try {
      await systemDb().product.create({
        data: { accountId: g.accountId, sku: `IMP-PFX-${stamp}`, name: "Old" },
      });
      const parsed = parseImportTable("EUSHIPMENTS", [
        ["name", "barcode", "length (cm)", "width (cm)", "height (cm)", "weight (kg)", "reference number"],
        ["Synthetic", "2000000000039", "10", "10", "10", "0.3", `SYNP-IMP-PFX-${stamp}`],
      ]).rows;
      const plan = await planImport(g.owner, g.connection.id, parsed);
      expect(plan.rows.map((r) => [r.action, r.values.sku])).toEqual([["update", `IMP-PFX-${stamp}`]]);
    } finally {
      await systemDb().fulfillmentConnection.update({
        where: { id: g.connection.id },
        data: { skuPrefixRule: {} },
      });
    }
  });

  it("a new product is created in the CRM and queued at the warehouse; an existing one is completed; checked again on the server", async () => {
    const stamp = Date.now();
    const existing = await systemDb().product.create({
      data: { accountId: g.accountId, sku: `IMP-OLD-${stamp}`, name: "Old" },
    });
    const parsed = table([
      [`IMP-NEW-${stamp}`, "Synthetic new", "2000000000015", "350", "60", "40", "120"],
      [`imp-old-${stamp}`, "Synthetic old", "2000000000022", "200", "50", "50", "100"],
    ]);
    const plan = await planImport(g.owner, g.connection.id, parsed);
    expect(plan.rows.map((r) => r.action)).toEqual(["create", "update"]);

    const r = await applyImport(g.owner, {
      connectionId: g.connection.id,
      rows: [
        ...plan.rows.map((x) => ({ row: x.row, values: x.values })),
        // A row tampered with in the browser is refused on the server.
        { row: 9, values: { ...plan.rows[0]!.values, sku: `IMP-X-${stamp}`, weightGrams: 5 } },
      ],
    });
    expect(r).toMatchObject({ created: 1, updated: 1, queued: 2 });
    expect(r.failed).toEqual([{ row: 9, code: "weight_invalid" }]);
    const created = await systemDb().product.findFirstOrThrow({
      where: { accountId: g.accountId, sku: `IMP-NEW-${stamp}` },
      include: { eans: true },
    });
    expect(created).toMatchObject({ weightGrams: 350, lengthMm: 60, widthMm: 40, heightMm: 120 });
    expect(created.eans.map((e) => e.ean)).toEqual(["2000000000015"]);
    expect(await systemDb().product.findUniqueOrThrow({ where: { id: existing.id } })).toMatchObject({
      name: "Old",
      weightGrams: 200,
    });
    expect(
      await systemDb().outboundRequest.count({
        where: { connectionId: g.connection.id, operation: "eushipments.createProduct" },
      }),
    ).toBeGreaterThanOrEqual(2);
    // An archived product's SKU, and a product the warehouse has but not linked: never sent; the rest goes on.
    await systemDb().product.create({
      data: { accountId: g.accountId, sku: `IMP-ARCH-${stamp}`, name: "Archived", archived: true },
    });
    await systemDb().vendorProduct.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        vendorId: `IMP-LOOSE-${stamp}`,
        raw: {},
      },
    });
    const more = await planImport(
      g.owner,
      g.connection.id,
      table([
        [`IMP-ARCH-${stamp}`, "x", "2000000000039", "350", "60", "40", "120"],
        [`IMP-LOOSE-${stamp}`, "x", "2000000000039", "350", "60", "40", "120"],
        [`IMP-HS-${stamp}`, "x", "bb-test-54202", "350", "60", "40", "120"],
      ]),
    );
    expect(more.rows.map((r) => r.action)).toEqual(["error", "error", "create"]);
    expect(more.rows[1]?.errors).toEqual(["at_warehouse_unlinked"]);
    expect(more.rows[0]?.errors).toEqual(["sku_archived"]);
    // The same file again: nothing new is created or queued twice.
    const before = await systemDb().outboundRequest.count({ where: { connectionId: g.connection.id } });
    const again = await applyImport(g.owner, {
      connectionId: g.connection.id,
      rows: plan.rows.map((x) => ({ row: x.row, values: x.values })),
    });
    expect(again).toMatchObject({ created: 0 });
    expect(await systemDb().outboundRequest.count({ where: { connectionId: g.connection.id } })).toBe(before);
    // Another group's member cannot use this warehouse.
    const stranger = await euTestGroup("import-other");
    await expect(planImport(stranger.owner, g.connection.id, parsed)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(planImport({ ...g.owner, role: "VIEWER" }, g.connection.id, parsed)).rejects.toThrow();
  });
});
