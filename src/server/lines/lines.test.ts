import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/auth/rbac";
import { bootstrapOwner } from "@/server/auth/users";
import { companyFilter } from "@/server/companies";
import { accountDb, systemDb } from "@/server/db/client";
import { evaluateRouting, type RoutingConnection } from "@/server/routing/engine";
import { matchBySku } from "@/server/shopify/products";
import { withAccountTransaction } from "@/server/db/client";
import { SpreadsheetError, readCsv, readTable, readXlsx, writeCsv, writeXlsx, zip } from "@/lib/xlsx";
import { autoLinkLine, mastersBatch, processCatalogueRun, startMasterCatalogue } from "./catalogue";
import { lineCoverage } from "./coverage";
import {
  lineConnectionsWhere,
  companiesForLine,
  createLine,
  pickActiveLine,
  setCompanyLine,
  setLineArchived,
  skuAfterPrefix,
  updateLine,
  visibleLines,
  type ScopedActor,
} from "./lines";
import { applyImport, exportMapping, planImport, previewImport } from "./mapping";
import {
  confirmSuggestion,
  dismissSuggestion,
  linkItemToSku,
  listSuggestions,
  nameSimilarity,
  rankCandidates,
} from "./suggestions";

// Synthetic data only.
const PASSWORD = "correct horse battery staple";

describe("pure helpers", () => {
  it("strips the prefix case-insensitively and never leaves an empty SKU", () => {
    expect(skuAfterPrefix("R-ABC1", "r-")).toBe("ABC1");
    expect(skuAfterPrefix("ABC1", "R-")).toBe("ABC1");
    expect(skuAfterPrefix("R-", "R-")).toBe("R-");
    expect(skuAfterPrefix("  ", "R-")).toBeNull();
  });

  it("line filter: only owners/admins may stay on all lines", () => {
    const lines = [{ id: "a" }, { id: "b" }];
    expect(pickActiveLine(lines, "b", false)).toBe("b");
    expect(pickActiveLine(lines, undefined, true)).toBeNull();
    expect(pickActiveLine(lines, "zzz", false)).toBe("a");
    expect(pickActiveLine([], undefined, false)).toBeNull();
  });

  it("restricted members see only lines of their companies", () => {
    const all = [
      { id: "a", name: "A", color: "rose", sortOrder: 0, archivedAt: null, companyIds: ["c1"] },
      { id: "b", name: "B", color: "slate", sortOrder: 1, archivedAt: null, companyIds: ["c2"] },
      { id: "x", name: "X", color: "ink", sortOrder: 2, archivedAt: new Date(), companyIds: ["c1"] },
    ];
    expect(visibleLines(all, ["c1"], false).map((l) => l.id)).toEqual(["a"]);
    expect(visibleLines(all, [], true).map((l) => l.id)).toEqual(["a", "b"]);
  });

  it("companyFilter narrows to the sidebar line's companies", () => {
    expect(companyFilter({ companyScope: null, activeCompanyId: null, lineCompanyIds: ["c1"] })).toEqual({
      companyId: { in: ["c1"] },
    });
    expect(
      companyFilter({ companyScope: null, activeCompanyId: "c1", lineCompanyIds: ["c1", "c2"] }),
    ).toEqual({
      companyId: "c1",
    });
  });

  it("name similarity and barcodes are hints, SKU is the key", () => {
    expect(nameSimilarity("Крем за ръце 50 ml", "крем за ръце 50ml")).toBeGreaterThan(0.8);
    expect(nameSimilarity("Тениска синя M", "Крем за ръце")).toBeLessThan(0.3);
    const masters = [
      { id: "p1", sku: "HC-50", name: "Крем за ръце 50 ml", barcodes: ["111"] },
      { id: "p2", sku: "HC-100", name: "Крем за ръце 100 ml", barcodes: [] },
      { id: "p3", sku: "TS-M", name: "Тениска синя M", barcodes: ["999"] },
    ];
    const bySku = rankCandidates({ sku: "hc-50", name: "whatever", barcode: null }, masters);
    expect(bySku[0]).toMatchObject({ productId: "p1", score: 1 });
    const byName = rankCandidates({ sku: "OTHER", name: "Крем за ръце 50мл", barcode: null }, masters);
    expect(byName[0]!.productId).toBe("p1");
    expect(byName[0]!.score).toBeLessThan(1);
    // A barcode alone never makes a match certain (warehouse "EAN" fields are internal codes).
    const byBarcode = rankCandidates({ sku: null, name: "Нещо съвсем друго", barcode: "999" }, masters);
    expect(byBarcode.every((c) => c.score < 0.5)).toBe(true);
    const dismissed = rankCandidates({ sku: "hc-50", name: "x", barcode: null }, masters, {
      exclude: new Set(["p1"]),
    });
    expect(dismissed.find((c) => c.productId === "p1")).toBeUndefined();
  });

  it("routing stock fallback only considers warehouses of the order's line", () => {
    const conn = (id: string, companyId: string, lineId: string | null): RoutingConnection => ({
      id,
      name: id,
      type: "FHB_V3",
      companyId,
      lineId,
      enabled: true,
    });
    const ok = { status: "ok" as const, lines: [] };
    const decision = evaluateRouting({
      order: {
        companyId: "c1",
        lineId: "L1",
        storeId: null,
        countryCode: "BG",
        paymentMethod: "COD",
        tags: [],
        lines: [{ productId: "p", quantity: 1, title: "x" }],
      },
      rules: [],
      connections: [conn("A-other-line", "c3", "L2"), conn("B-same-line", "c2", "L1")],
      stock: new Map([
        ["A-other-line", ok],
        ["B-same-line", ok],
      ]),
      storeCodes: new Map(),
    });
    expect(decision).toMatchObject({
      connectionId: "B-same-line",
      via: "stock_fallback",
      crossCompany: true,
    });
    const none = evaluateRouting({
      order: {
        companyId: "c1",
        lineId: "L1",
        storeId: null,
        countryCode: "BG",
        paymentMethod: "COD",
        tags: [],
        lines: [{ productId: "p", quantity: 1, title: "x" }],
      },
      rules: [],
      connections: [conn("A-other-line", "c3", "L2")],
      stock: new Map([["A-other-line", ok]]),
      storeCodes: new Map(),
    });
    expect(none.via).toBe("none");
  });

  it("xlsx and csv round-trip text tables (Cyrillic, commas, quotes, empty cells)", () => {
    const rows = [
      ["SKU", "Име", "Склад · A [c1]"],
      ["A-1", 'Крем "мек", 50 ml', "R-A-1, R-A-1B"],
      ["", "Несвързан", ""],
      ["B-2", "x<y&z", ""],
    ];
    const x = readXlsx(writeXlsx(rows, "Козметика"));
    expect(x[0]).toEqual(rows[0]);
    expect(x[1]).toEqual(rows[1]);
    expect(x[2]).toEqual(["", "Несвързан"]);
    expect(x[3]).toEqual(["B-2", "x<y&z"]);
    expect(readTable(writeXlsx(rows))[1]![1]).toBe('Крем "мек", 50 ml');
    const c = readCsv(writeCsv(rows));
    expect(c[1]).toEqual(rows[1]);
    expect(readTable(Buffer.from("SKU,Име\nA-1,Крем\n"))).toEqual([
      ["SKU", "Име"],
      ["A-1", "Крем"],
    ]);
  });

  const sheetXlsx = (sheetData: string, opts: { rid?: string; relsId?: string } = {}) =>
    zip([
      {
        name: "xl/workbook.xml",
        data: Buffer.from(
          `<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="${opts.rid ?? "rId1"}"/></sheets></workbook>`,
        ),
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: Buffer.from(
          `<Relationships><Relationship Id="${opts.relsId ?? opts.rid ?? "rId1"}" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>`,
        ),
      },
      {
        name: "xl/worksheets/sheet1.xml",
        data: Buffer.from(`<worksheet><sheetData>${sheetData}</sheetData></worksheet>`),
      },
    ]);
  const code = (fn: () => unknown) => {
    try {
      fn();
      return "ok";
    } catch (err) {
      return err instanceof SpreadsheetError ? err.code : `other:${(err as Error).name}`;
    }
  };

  it("xlsx: row / column indexes from the file are capped (no memory blow-up)", () => {
    const cell = (ref: string) => `<c r="${ref}" t="inlineStr"><is><t>x</t></is></c>`;
    expect(code(() => readXlsx(sheetXlsx(`<row r="99999999">${cell("A99999999")}</row>`)))).toBe(
      "too_many_rows",
    );
    expect(code(() => readXlsx(sheetXlsx(`<row r="1">${cell("XFD1")}</row>`)))).toBe("too_many_columns");
    // Many rows without an r attribute are counted too.
    expect(code(() => readXlsx(sheetXlsx("<row><c><v>1</v></c></row>".repeat(6000))))).toBe("too_many_rows");
    expect(readXlsx(sheetXlsx(`<row r="3">${cell("B3")}</row>`))).toEqual([[], [], ["", "x"]]);
  });

  it("xlsx: a crafted r:id or character reference is a bad file, never a crash", () => {
    const ok = `<row r="1"><c r="A1" t="inlineStr"><is><t>a&#x110000;b</t></is></c></row>`;
    expect(readXlsx(sheetXlsx(ok, { rid: "(a+)+$[" }))).toEqual([["ab"]]);
    expect(code(() => readXlsx(sheetXlsx(ok, { rid: "rId1", relsId: "rId9" })))).toBe("ok");
    expect(code(() => readXlsx(Buffer.from("PK\u0003\u0004garbage")))).not.toMatch(/^other:/);
  });

  it("csv: formula-like cells are neutralised on export and restored on import", () => {
    const rows = [
      ["SKU", "Име"],
      ["A-1", '=HYPERLINK("http://x","y")'],
      ["A-2", "+cmd|' /C calc'!A0"],
      ["A-3", "-5"],
      ["A-4", "@SUM(1)"],
      ["A-5", "'quoted"],
    ];
    const csv = writeCsv(rows);
    for (const line of csv.split("\r\n").slice(1, 5)) expect(line).toMatch(/^A-\d;"'[=+\-@]/);
    expect(readCsv(csv)).toEqual(rows);
  });

  it("partial rollout: restricted members keep their companies without a line", () => {
    const cos = [
      { id: "a", lineId: "L" },
      { id: "c", lineId: null },
      { id: "t", lineId: "T" },
    ];
    expect(companiesForLine(cos, "L", false).map((c) => c.id)).toEqual(["a", "c"]);
    expect(companiesForLine(cos, "L", true).map((c) => c.id)).toEqual(["a"]);
    expect(companiesForLine(cos, null, false)).toHaveLength(3);
  });

  it("routing stock fallback keeps shared (company-less) warehouses for every line", () => {
    const ok = { status: "ok" as const, lines: [] };
    const order = {
      companyId: "c1",
      lineId: "L1",
      storeId: null,
      countryCode: "BG",
      paymentMethod: "COD" as const,
      tags: [],
      lines: [{ productId: "p", quantity: 1, title: "x" }],
    };
    const shared: RoutingConnection = {
      id: "shared",
      name: "Shared",
      type: "FHB_V3",
      companyId: null,
      lineId: null,
      enabled: true,
    };
    const unassigned: RoutingConnection = {
      ...shared,
      id: "unassigned",
      name: "A-unassigned",
      companyId: "c9",
    };
    const d = evaluateRouting({
      order,
      rules: [],
      connections: [unassigned, shared],
      stock: new Map([
        ["shared", ok],
        ["unassigned", ok],
      ]),
      storeCodes: new Map(),
    });
    expect(d).toMatchObject({ connectionId: "shared", via: "stock_fallback" });
  });
});

describe("product lines (database)", () => {
  let owner: ScopedActor;
  let cosmetics: string;
  let textiles: string;
  let coA: string;
  let coB: string;
  let coT: string;
  let fhbA: string;
  let euB: string;
  let fhbT: string;
  let storeA: string;

  beforeAll(async () => {
    const r = await bootstrapOwner({
      email: `lines-${Date.now()}@example.com`,
      name: "O",
      accountName: "Група линии",
      password: PASSWORD,
    });
    owner = { userId: r.user.id, accountId: r.account.id, role: "OWNER", companyScope: null };
    const db = systemDb();
    coA = (await db.company.findFirstOrThrow({ where: { accountId: r.account.id } })).id;
    coB = (await db.company.create({ data: { accountId: r.account.id, name: "Фирма Б" } })).id;
    coT = (await db.company.create({ data: { accountId: r.account.id, name: "Фирма Т" } })).id;
    const conn = (name: string, type: "FHB_V3" | "EUSHIPMENTS", companyId: string, prefix: string) =>
      db.fulfillmentConnection.create({
        data: { accountId: r.account.id, name, type, companyId, skuPrefixRule: { prefix } },
      });
    fhbA = (await conn("FHB А", "FHB_V3", coA, "RA-")).id;
    euB = (await conn("euShipments Б", "EUSHIPMENTS", coB, "EB-")).id;
    fhbT = (await conn("FHB Т", "FHB_V3", coT, "RT-")).id;
    storeA = (
      await db.store.create({
        data: {
          accountId: r.account.id,
          companyId: coA,
          domain: `lines-${Date.now()}.myshopify.com`,
          code: "LA",
          name: "Магазин А",
          currency: "EUR",
          skuPrefix: "SA-",
        },
      })
    ).id;
    const vp = (connectionId: string, vendorId: string, name: string, vendorEan?: string) =>
      db.vendorProduct.create({
        data: { accountId: r.account.id, connectionId, vendorId, vendorEan, raw: { name } },
      });
    // Warehouse A: 7 products (one duplicate in different case, one with a SKU textiles already use).
    for (let i = 1; i <= 5; i++) await vp(fhbA, `RA-K${i}`, `Козметика ${i}`);
    await vp(fhbA, "ra-k1", "Козметика 1 (дубликат)");
    await vp(fhbA, "RA-SHARED", "Споделен SKU");
    // Warehouse B of the same line: same goods under its own prefix + one unknown.
    await vp(euB, "EB-k2", "Козметика 2");
    await vp(euB, "EB-K3", "Козметика 3");
    await vp(euB, "EB-XYZ", "Крем Козметика 4 вариант", "4444");
    // Textiles warehouse: its own catalogue, with a SKU equal to cosmetics' K4.
    await vp(fhbT, "RT-K4", "Тениска");
    await vp(fhbT, "RT-SHARED", "Споделен");
    const variant = (gid: string, sku: string | null, title: string) =>
      db.storeVariantLink.create({
        data: {
          accountId: r.account.id,
          storeId: storeA,
          shopifyVariantGid: `gid://shopify/ProductVariant/${gid}`,
          shopifyProductGid: "gid://shopify/Product/1",
          sku,
          title,
        },
      });
    await variant("1", "SA-K1", "Козметика 1 - Default Title");
    await variant("2", "SA-K5", "Козметика 5");
    await variant("3", null, "Козметика 3 без SKU");
  });

  it("owners/admins manage lines and put companies in them (audited); others cannot", async () => {
    await expect(
      createLine({ ...owner, role: "OPERATOR" }, { name: "Козметика", color: "rose" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    cosmetics = (await createLine(owner, { name: "Козметика", color: "rose", sortOrder: 1 })).id;
    textiles = (
      await createLine({ ...owner, role: "ADMIN" }, { name: "Текстил", color: "slate", sortOrder: 2 })
    ).id;
    await expect(createLine(owner, { name: "Козметика", color: "rose" })).rejects.toMatchObject({
      code: "line_exists",
    });
    await updateLine(owner, textiles, { name: "Текстил", color: "olive", sortOrder: 2 });
    await setCompanyLine(owner, coA, cosmetics);
    await setCompanyLine(owner, coB, cosmetics);
    await setCompanyLine(owner, coT, textiles);
    const audit = await accountDb(owner.accountId).auditLog.findMany({ where: { action: "company.line" } });
    expect(audit).toHaveLength(3);
    const tmp = await createLine(owner, { name: "Временна", color: "ink" });
    await setLineArchived(owner, tmp.id, true);
    await expect(setCompanyLine(owner, coA, tmp.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("a SKU used by textiles exists before the run (it must not be reused by cosmetics)", async () => {
    await accountDb(owner.accountId).product.create({
      data: { accountId: owner.accountId, sku: "SHARED", name: "Текстил споделен", lineId: textiles },
    });
  });

  it("master catalogue run: creates masters from warehouse A, no duplicates, links, auto-links the line", async () => {
    const queued: unknown[] = [];
    await expect(
      startMasterCatalogue(owner, { lineId: textiles, connectionId: fhbA }, async (d) => queued.push(d)),
    ).rejects.toMatchObject({ code: "connection_not_in_line" });
    const run = await startMasterCatalogue(owner, { lineId: cosmetics, connectionId: fhbA }, async (d) =>
      queued.push(d),
    );
    expect(queued).toHaveLength(1);
    // Starting again while it waits returns the same run.
    const again = await startMasterCatalogue(owner, { lineId: cosmetics, connectionId: fhbA }, async () => 0);
    expect(again.id).toBe(run.id);
    const done = await processCatalogueRun(owner.accountId, run.id, { batchSize: 3 });
    expect(done).toMatchObject({
      status: "DONE",
      total: 7,
      processed: 7,
      created: 5,
      linked: 6,
      conflicts: 1,
    });
    expect(done!.conflictSamples).toEqual(["SHARED"]);
    const db = accountDb(owner.accountId);
    const masters = await db.product.findMany({ where: { lineId: cosmetics }, orderBy: { sku: "asc" } });
    expect(masters.map((m) => m.sku)).toEqual(["K1", "K2", "K3", "K4", "K5"]);
    expect(masters[0]!.name).toBe("Козметика 1");
    // Other warehouse of the line + store variants: auto-linked by SKU after prefix (case-insensitive).
    const eu = await db.vendorProduct.findMany({
      where: { connectionId: euB },
      orderBy: { vendorId: "asc" },
    });
    expect(eu.find((v) => v.vendorId === "EB-k2")!.productId).toBe(masters[1]!.id);
    expect(eu.find((v) => v.vendorId === "EB-XYZ")!.productId).toBeNull();
    const variants = await db.storeVariantLink.findMany({ where: { storeId: storeA } });
    expect(variants.filter((v) => v.productId).length).toBe(2);
    expect(done!.autoLinked).toBe(4);
    // Textiles are never touched: its K4 stays unlinked to the cosmetics K4.
    expect((await db.vendorProduct.findFirstOrThrow({ where: { vendorId: "RT-K4" } })).productId).toBeNull();
    // Idempotent: a second run creates nothing.
    const second = await startMasterCatalogue(
      owner,
      { lineId: cosmetics, connectionId: fhbA },
      async () => 0,
    );
    const done2 = await processCatalogueRun(owner.accountId, second.id);
    expect(done2).toMatchObject({ created: 0, linked: 0, alreadyLinked: 6, autoLinked: 0 });
  });

  it("a run resumes after its cursor (a retried job does not start over)", async () => {
    const db = accountDb(owner.accountId);
    const run = await db.masterCatalogueRun.create({
      data: { accountId: owner.accountId, lineId: textiles, connectionId: fhbT, total: 2 },
    });
    const first = await db.vendorProduct.findFirstOrThrow({
      where: { connectionId: fhbT },
      orderBy: { id: "asc" },
    });
    await db.masterCatalogueRun.update({ where: { id: run.id }, data: { cursor: first.id, processed: 1 } });
    const done = await processCatalogueRun(owner.accountId, run.id);
    expect(done!.processed).toBe(2);
  });

  it("automatic sync matching stays in the line (and keeps unassigned masters)", async () => {
    const db = accountDb(owner.accountId);
    await db.product.create({ data: { accountId: owner.accountId, sku: "LEGACY-1", name: "Без линия" } });
    await withAccountTransaction(owner.accountId, async (tx) => {
      expect(await matchBySku(tx, "SA-LEGACY-1", "SA-", cosmetics)).not.toBeNull();
      // K4 of cosmetics is never matched for a textiles store.
      expect(await matchBySku(tx, "K4", null, textiles)).toBeNull();
      expect(await matchBySku(tx, "K4", null, cosmetics)).not.toBeNull();
    });
  });

  it("suggestions: within the line only, with score; confirm / other / dismiss", async () => {
    const s = await listSuggestions(owner, cosmetics);
    const xyz = s.items.find((i) => i.code === "EB-XYZ")!;
    expect(xyz.candidates[0]!.sku).toBe("K4");
    expect(xyz.candidates[0]!.score).toBeLessThan(1);
    expect(s.items.every((i) => i.candidates.every((c) => c.sku !== "SHARED"))).toBe(true);
    // Dismiss hides it for this item.
    await dismissSuggestion(owner, {
      lineId: cosmetics,
      kind: "vendor",
      itemId: xyz.id,
      productId: xyz.candidates[0]!.productId,
    });
    const after = await listSuggestions(owner, cosmetics);
    expect(after.items.find((i) => i.id === xyz.id)!.candidates.find((c) => c.sku === "K4")).toBeUndefined();
    // Another SKU of the line.
    await linkItemToSku(owner, { lineId: cosmetics, kind: "vendor", itemId: xyz.id, sku: "k4" });
    await expect(
      linkItemToSku(owner, { lineId: cosmetics, kind: "vendor", itemId: xyz.id, sku: "K5" }),
    ).rejects.toMatchObject({ code: "already_linked" });
    // A master of another line is never accepted.
    const noSku = after.items.find((i) => i.kind === "variant")!;
    await expect(
      linkItemToSku(owner, { lineId: cosmetics, kind: "variant", itemId: noSku.id, sku: "SHARED" }),
    ).rejects.toMatchObject({ code: "product_not_found" });
    const k3 = await accountDb(owner.accountId).product.findFirstOrThrow({ where: { sku: "K3" } });
    await confirmSuggestion(owner, {
      lineId: cosmetics,
      kind: "variant",
      itemId: noSku.id,
      productId: k3.id,
    });
    // An item of another line is not found from this line.
    const rt = await accountDb(owner.accountId).vendorProduct.findFirstOrThrow({
      where: { vendorId: "RT-K4" },
    });
    await expect(
      confirmSuggestion(owner, { lineId: cosmetics, kind: "vendor", itemId: rt.id, productId: k3.id }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("coverage per line", async () => {
    const c = await lineCoverage(owner.accountId, cosmetics);
    // A: 6 of 7 (SHARED conflict), B: 3 of 3, store: 3 of 3.
    expect(c.warehouses).toEqual({ total: 10, linked: 9 });
    expect(c.stores).toEqual({ total: 3, linked: 3 });
    expect(c.meetsTarget).toBe(false);
  });

  it("export → edit → import preview → apply (validates everything first, audited)", async () => {
    const exp = await exportMapping(owner, cosmetics);
    const header = exp.rows[0]!;
    expect(header.length).toBe(2 + 2 + 1);
    const k1 = exp.rows.find((r) => r[0] === "K1")!;
    expect(k1[header.findIndex((h) => h.includes(fhbA))]!.split(", ").sort()).toEqual(["RA-K1", "ra-k1"]);
    expect(k1[header.findIndex((h) => h.includes(storeA))]).toBe("SA-K1");
    const unlinked = exp.rows.find((r) => r[0] === "" && r.includes("RA-SHARED"))!;
    expect(unlinked).toBeDefined();

    const fhbCol = header.findIndex((h) => h.includes(fhbA));
    // Errors: unknown item, item twice, SKU of another line, new SKU without name → nothing is planned.
    const bad = [
      header,
      ["K1", "", "RA-NOPE"],
      ["K2", "", "RA-K2"],
      ["K3", "", "RA-K2"],
      ["SHARED", "", ""],
      ["NEW-1", "", ""],
    ].map((r) => {
      const row = [...r];
      if (r.length === 3) {
        const v = row.pop()!;
        while (row.length < fhbCol) row.push("");
        row[fhbCol] = v;
      }
      return row;
    });
    const badPlan = await planImport(owner.accountId, cosmetics, bad);
    expect(badPlan.errors.map((e) => e.code).sort()).toEqual(
      ["item_not_found", "item_twice", "name_required", "sku_in_other_line"].sort(),
    );
    const invalid = await previewImport(owner, { lineId: cosmetics, fileName: "bad.xlsx" }, bad);
    expect(invalid.status).toBe("INVALID");
    await expect(applyImport(owner, invalid.id)).rejects.toMatchObject({ code: "import_not_ready" });

    // Good: move RA-SHARED into a new master, create it; via a real xlsx round-trip.
    const good = [
      header,
      ["K-NEW", "Нов продукт", ...header.slice(2).map((_, i) => (i + 2 === fhbCol ? "RA-SHARED" : ""))],
    ];
    const table = readTable(writeXlsx(good));
    const preview = await previewImport(owner, { lineId: cosmetics, fileName: "map.xlsx" }, table);
    expect(preview.status).toBe("PREVIEW");
    const plan = preview.plan as { creates: unknown[]; links: { fromProductId: string | null }[] };
    expect(plan.creates).toHaveLength(1);
    expect(plan.links).toHaveLength(1);
    const res = await applyImport(owner, preview.id);
    expect(res.applied).toBe(1);
    const db = accountDb(owner.accountId);
    const created = await db.product.findFirstOrThrow({ where: { sku: "K-NEW" } });
    expect(created.lineId).toBe(cosmetics);
    expect((await db.vendorProduct.findFirstOrThrow({ where: { vendorId: "RA-SHARED" } })).productId).toBe(
      created.id,
    );
    expect(await db.auditLog.count({ where: { action: "line.mapping_imported" } })).toBe(1);
    await expect(applyImport(owner, preview.id)).rejects.toMatchObject({ code: "import_not_ready" });
    expect((await lineCoverage(owner.accountId, cosmetics)).warehouses).toEqual({ total: 10, linked: 10 });
  });

  it("a stale preview is refused (a link changed after the preview)", async () => {
    const exp = await exportMapping(owner, cosmetics);
    const header = exp.rows[0]!;
    const fhbCol = header.findIndex((h) => h.includes(fhbA));
    const row = ["K2", "", ...header.slice(2).map((_, i) => (i + 2 === fhbCol ? "RA-K3" : ""))];
    const preview = await previewImport(owner, { lineId: cosmetics, fileName: "m.csv" }, [header, row]);
    const db = accountDb(owner.accountId);
    const k5 = await db.product.findFirstOrThrow({ where: { sku: "K5" } });
    await db.vendorProduct.updateMany({ where: { vendorId: "RA-K3" }, data: { productId: k5.id } });
    await expect(applyImport(owner, preview.id)).rejects.toMatchObject({ code: "import_stale" });
  });

  it("restricted members only reach lines of their companies", async () => {
    const restricted: ScopedActor = { ...owner, role: "OPERATOR", companyScope: [coT] };
    await expect(listSuggestions(restricted, cosmetics)).rejects.toMatchObject({ code: "not_found" });
    await expect(exportMapping(restricted, cosmetics)).rejects.toMatchObject({ code: "not_found" });
    const s = await listSuggestions(restricted, textiles);
    const unlinkedT = await accountDb(owner.accountId).vendorProduct.findMany({
      where: { connectionId: fhbT, archived: false, productId: null },
      orderBy: { vendorId: "asc" },
    });
    expect(unlinkedT.length).toBeGreaterThan(0);
    expect(s.total).toBe(unlinkedT.length);
    expect(s.items.map((i) => i.code).sort()).toEqual(unlinkedT.map((v) => v.vendorId).sort());
    expect(s.items.every((i) => i.source === "FHB Т")).toBe(true);
  });

  it("restricted member inside a multi-company line sees and touches only their own companies", async () => {
    const db = systemDb();
    const newVp = (connectionId: string, vendorId: string) =>
      db.vendorProduct.create({
        data: { accountId: owner.accountId, connectionId, vendorId, raw: { name: `Нов ${vendorId}` } },
      });
    const raNew = await newVp(fhbA, "RA-NEW");
    const ebNew = await newVp(euB, "EB-NEW");
    const onlyA: ScopedActor = { ...owner, role: "OPERATOR", companyScope: [coA] };

    // Export: no column, id or code of company B.
    const exp = await exportMapping(onlyA, cosmetics);
    expect(exp.rows[0]).toHaveLength(2 + 1 + 1);
    expect(exp.rows.flat().some((c) => c.includes(euB) || c.includes("EB-"))).toBe(false);
    const ownerHeader = (await exportMapping(owner, cosmetics)).rows[0]!;
    const euCol = ownerHeader.find((h) => h.includes(euB))!;

    // Import naming B's column is refused before anything is planned.
    const { errors } = await planImport(
      owner.accountId,
      cosmetics,
      [[...exp.rows[0]!, euCol], ["K1"]],
      [coA],
    );
    expect(errors.map((e) => e.code)).toEqual(["unknown_column"]);
    const inv = await previewImport(onlyA, { lineId: cosmetics, fileName: "b.csv" }, [
      ["SKU", "Име", euCol],
      ["K1", "", "EB-NEW"],
    ]);
    expect(inv.status).toBe("INVALID");

    // Suggestions and coverage: A only.
    const sug = await listSuggestions(onlyA, cosmetics);
    expect(sug.items.map((i) => i.code)).toEqual(["RA-NEW"]);
    expect(sug.total).toBe(1);
    expect((await listSuggestions(owner, cosmetics)).items.map((i) => i.code).sort()).toEqual([
      "EB-NEW",
      "RA-NEW",
    ]);
    const cov = await lineCoverage(owner.accountId, cosmetics, [coA]);
    expect(cov.parts.map((p) => p.id).sort()).toEqual([fhbA, storeA].sort());

    // A plan that touches B (previewed by the owner) is refused when a member scoped to A applies it.
    const ownerPlan = await previewImport(owner, { lineId: cosmetics, fileName: "o.csv" }, [
      ["SKU", "Име", euCol],
      ["K1", "", "EB-NEW"],
    ]);
    expect(ownerPlan.status).toBe("PREVIEW");
    await expect(applyImport(onlyA, ownerPlan.id)).rejects.toMatchObject({ code: "import_stale" });
    expect((await db.vendorProduct.findUniqueOrThrow({ where: { id: ebNew.id } })).productId).toBeNull();
    expect((await db.productMappingImport.findUniqueOrThrow({ where: { id: ownerPlan.id } })).status).toBe(
      "PREVIEW",
    );

    // Double click on Apply: one applies, the other is not ready.
    const fhbHeader = exp.rows[0]!.find((h) => h.includes(fhbA))!;
    const mine = await previewImport(onlyA, { lineId: cosmetics, fileName: "a.csv" }, [
      ["SKU", "Име", fhbHeader],
      ["K1", "", "RA-NEW"],
    ]);
    expect(mine.status).toBe("PREVIEW");
    const results = await Promise.allSettled([applyImport(onlyA, mine.id), applyImport(onlyA, mine.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "import_not_ready" });
    const k1 = await accountDb(owner.accountId).product.findFirstOrThrow({
      where: { sku: "K1", lineId: cosmetics },
    });
    expect((await db.vendorProduct.findUniqueOrThrow({ where: { id: raNew.id } })).productId).toBe(k1.id);
  });

  it("catalogue batch never overwrites a link made after the batch was read", async () => {
    const db = accountDb(owner.accountId);
    const k1 = await db.product.findFirstOrThrow({ where: { sku: "K1", lineId: cosmetics } });
    // "Ra-K2" maps to master K2 by SKU after prefix …
    const vp = await systemDb().vendorProduct.create({
      data: { accountId: owner.accountId, connectionId: fhbA, vendorId: "Ra-K2", raw: { name: "late" } },
    });
    // … but after the batch read it as unlinked, a person linked it by hand to K1.
    await db.vendorProduct.update({ where: { id: vp.id }, data: { productId: k1.id } });
    const c = {
      processed: 0,
      created: 0,
      linked: 0,
      adopted: 0,
      alreadyLinked: 0,
      conflicts: 0,
      samples: [],
    };
    const stale = [{ id: vp.id, vendorId: "Ra-K2", productId: null, raw: { name: "late" } }];
    await withAccountTransaction(owner.accountId, (tx, helpers) =>
      mastersBatch(tx, helpers, owner.accountId, cosmetics, "RA-", stale, c),
    );
    expect(c).toMatchObject({ processed: 1, linked: 0, alreadyLinked: 1, created: 0 });
    expect((await db.vendorProduct.findUniqueOrThrow({ where: { id: vp.id } })).productId).toBe(k1.id);
  });

  it("starting the catalogue twice at once creates one run", async () => {
    const enq = async () => 0;
    const [a, b] = await Promise.all([
      startMasterCatalogue(owner, { lineId: cosmetics, connectionId: euB }, enq),
      startMasterCatalogue(owner, { lineId: cosmetics, connectionId: euB }, enq),
    ]);
    expect(a.id).toBe(b.id);
    expect(await accountDb(owner.accountId).masterCatalogueRun.count({ where: { connectionId: euB } })).toBe(
      1,
    );
    expect(
      await accountDb(owner.accountId).auditLog.count({
        where: { action: "line.catalogue_started", entityId: a.id },
      }),
    ).toBe(1);
  });

  it("autoLinkLine is safe to run again", async () => {
    expect(await autoLinkLine(owner.accountId, cosmetics)).toBe(0);
  });

  it("order page warehouse columns: only the line's warehouses, plus one the order already uses", async () => {
    const db = accountDb(owner.accountId);
    const names = async (lineId: string | null, also: string[] = []) =>
      (
        await db.fulfillmentConnection.findMany({
          where: lineConnectionsWhere(lineId, also),
          select: { id: true },
        })
      ).map((c) => c.id);
    const cos = await names(cosmetics);
    expect(cos).toEqual(expect.arrayContaining([fhbA, euB]));
    expect(cos).not.toContain(fhbT);
    expect(await names(textiles)).toEqual([fhbT]);
    expect(await names(textiles, [euB])).toEqual(expect.arrayContaining([fhbT, euB]));
    expect((await names(null)).length).toBeGreaterThanOrEqual(3);
  });

  it("lines of one group are invisible to another group (RLS + scoping)", async () => {
    const other = await bootstrapOwner({
      email: `lines-other-${Date.now()}@example.com`,
      name: "X",
      accountName: "Друга група",
      password: PASSWORD,
    });
    expect(await accountDb(other.account.id).productLine.count()).toBe(0);
    expect(await accountDb(other.account.id).masterCatalogueRun.count()).toBe(0);
    await expect(
      setCompanyLine({ userId: other.user.id, accountId: other.account.id, role: "OWNER" }, coA, null),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
