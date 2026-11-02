import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapOwner } from "@/server/auth/users";
import { ForbiddenError } from "@/server/auth/rbac";
import { accountDb, systemDb } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";
import {
  checkStock,
  createRoutingRule,
  deleteRoutingRule,
  evaluateRouting,
  listRoutingRules,
  moveRoutingRule,
  routeOrder,
  updateRoutingRule,
  type RoutingConnection,
  type RoutingOrder,
  type RoutingRuleRow,
  type StockCheck,
} from "./index";

// Synthetic data only.
const conn = (id: string, name: string, over: Partial<RoutingConnection> = {}): RoutingConnection => ({
  id,
  name,
  type: "FHB_V3",
  companyId: "co1",
  enabled: true,
  ...over,
});
const rule = (
  id: string,
  priority: number,
  connectionId: string,
  match: unknown = {},
  over: Partial<RoutingRuleRow> = {},
): RoutingRuleRow => ({
  id,
  name: id,
  priority,
  enabled: true,
  match,
  connectionId,
  parcelService: null,
  courierId: null,
  serviceName: null,
  deliveryPointPolicy: null,
  ...over,
});
const order = (over: Partial<RoutingOrder> = {}): RoutingOrder => ({
  companyId: "co1",
  storeId: "s1",
  countryCode: "BG",
  paymentMethod: "COD",
  tags: [],
  lines: [{ productId: "p1", quantity: 2, title: "SKU-1" }],
  ...over,
});
const ok: StockCheck = { status: "ok", lines: [] };
const none: StockCheck = { status: "insufficient", lines: [] };

describe("routing engine (pure)", () => {
  const connections = [conn("fhb", "FHB Main"), conn("eu", "euShipments BG", { type: "EUSHIPMENTS" })];
  const storeCodes = new Map([["s1", "DM"]]);

  it("first match wins, rule number = position, explanation names conditions, warehouse and stock", () => {
    const d = evaluateRouting({
      order: order(),
      rules: [
        rule("r-ro", 10, "eu", { countries: ["RO"] }),
        rule("r-prepaid", 20, "eu", { payment: "PREPAID" }),
        rule("r-bg-cod", 30, "fhb", { countries: ["BG"], payment: "COD" }),
        rule("r-all", 40, "eu"),
      ],
      connections,
      stock: new Map([
        ["fhb", ok],
        ["eu", ok],
      ]),
      storeCodes,
    });
    expect(d).toMatchObject({
      connectionId: "fhb",
      ruleId: "r-bg-cod",
      ruleNumber: 3,
      via: "rule",
      crossCompany: false,
    });
    expect(d.explanation.bg).toBe("Правило 3: BG + COD → FHB Main; наличност OK");
    expect(d.explanation.en).toBe("Rule 3: BG + COD → FHB Main; stock OK");
    expect(d.steps.map((s) => [s.number, s.outcome, s.failed])).toEqual([
      [1, "no_match", "country"],
      [2, "no_match", "payment"],
      [3, "matched", undefined],
    ]);
  });

  it("matches on store and tags (any, case-insensitive), excludes tags, product set", () => {
    const rules = [
      rule("r", 10, "eu", { storeIds: ["s1"], tags: ["VIP"], excludeTags: ["b2b"], productIds: ["p1"] }),
    ];
    const stock = new Map([["eu", ok]]);
    expect(
      evaluateRouting({ order: order({ tags: ["vip"] }), rules, connections, stock, storeCodes }).ruleId,
    ).toBe("r");
    expect(
      evaluateRouting({ order: order({ tags: ["vip", "B2B"] }), rules, connections, stock, storeCodes })
        .steps[0],
    ).toMatchObject({ failed: "excludeTags" });
    expect(
      evaluateRouting({ order: order({ tags: [] }), rules, connections, stock, storeCodes }).steps[0],
    ).toMatchObject({ failed: "tags" });
    expect(
      evaluateRouting({
        order: order({ storeId: "s2", tags: ["vip"] }),
        rules,
        connections,
        stock,
        storeCodes,
      }).steps[0],
    ).toMatchObject({ failed: "store" });
    expect(
      evaluateRouting({
        order: order({ tags: ["vip"], lines: [{ productId: "p9", quantity: 1, title: "x" }] }),
        rules,
        connections,
        stock,
        storeCodes,
      }).steps[0],
    ).toMatchObject({ failed: "products" });
    const d = evaluateRouting({ order: order({ tags: ["vip"] }), rules, connections, stock, storeCodes });
    expect(d.explanation.bg).toBe(
      "Правило 1: магазин DM + #VIP + без #b2b + 1 продукт(а) → euShipments BG; наличност OK",
    );
  });

  it("requireStock skips a rule without stock; then the stock fallback prefers the own company", () => {
    const cs = [
      conn("fhb", "FHB Main"),
      conn("eu-other", "A euShipments other", { type: "EUSHIPMENTS", companyId: "co2" }),
      conn("eu-own", "Z euShipments own", { type: "EUSHIPMENTS" }),
    ];
    const d = evaluateRouting({
      order: order(),
      rules: [rule("r1", 10, "fhb", { countries: ["BG"], requireStock: true })],
      connections: cs,
      stock: new Map([
        ["fhb", none],
        ["eu-other", ok],
        ["eu-own", ok],
      ]),
      storeCodes,
    });
    expect(d).toMatchObject({ via: "stock_fallback", connectionId: "eu-own", ruleId: null });
    expect(d.steps[0]).toMatchObject({ outcome: "no_stock" });
    expect(d.explanation.bg).toBe("Без съвпадащо правило, по наличност → Z euShipments own; наличност OK");
  });

  it("a matching rule without requireStock wins even without stock (the validator reports it)", () => {
    const d = evaluateRouting({
      order: order(),
      rules: [rule("r1", 10, "fhb")],
      connections,
      stock: new Map([
        ["fhb", none],
        ["eu", ok],
      ]),
      storeCodes,
    });
    expect(d).toMatchObject({ connectionId: "fhb", via: "rule" });
    expect(d.explanation.bg).toContain("няма достатъчна наличност");
  });

  it("cross-company shipping is allowed and said", () => {
    const d = evaluateRouting({
      order: order({ companyId: "co1" }),
      rules: [rule("r1", 10, "x")],
      connections: [conn("x", "FHB Other", { companyId: "co2" })],
      stock: new Map([["x", ok]]),
      storeCodes,
    });
    expect(d.crossCompany).toBe(true);
    expect(d.explanation.bg).toContain("склад на друга фирма");
  });

  it("disabled rules, disabled/label-only connections and invalid matches are skipped; none → no decision", () => {
    const d = evaluateRouting({
      order: order(),
      rules: [
        rule("off", 10, "fhb", {}, { enabled: false }),
        rule("bad", 20, "fhb", { countries: "BG" }),
        rule("joy", 30, "joy"),
        rule("dis", 40, "dis"),
      ],
      connections: [
        conn("fhb", "FHB"),
        conn("joy", "Joy", { type: "FHB_JOY" }),
        conn("dis", "Off", { enabled: false }),
      ],
      stock: new Map([["fhb", none]]),
      storeCodes,
    });
    expect(d.steps.map((s) => s.outcome)).toEqual([
      "disabled",
      "invalid",
      "connection_disabled",
      "connection_disabled",
    ]);
    expect(d).toMatchObject({ via: "none", connectionId: null });
  });

  it("checkStock sums lines of the same product, unknown when not mapped", () => {
    const lines = [
      { productId: "p1", quantity: 2, title: "A" },
      { productId: "p1", quantity: 1, title: "A" },
      { productId: "p2", quantity: 1, title: "B" },
    ];
    expect(
      checkStock(
        lines,
        new Map([
          ["p1", 3],
          ["p2", 1],
        ]),
      ).status,
    ).toBe("ok");
    expect(
      checkStock(
        lines,
        new Map([
          ["p1", 2],
          ["p2", 1],
        ]),
      ).status,
    ).toBe("insufficient");
    expect(checkStock(lines, new Map([["p1", 3]])).status).toBe("unknown");
    expect(checkStock([{ productId: null, quantity: 1, title: "?" }], new Map()).status).toBe("unknown");
  });
});

describe("routing rules (database)", () => {
  let g: {
    accountId: string;
    owner: ScopedActor;
    company: string;
    otherCompany: string;
    store: string;
    fhb: string;
    eu: string;
    other: string;
    product: string;
  };

  beforeAll(async () => {
    const r = await bootstrapOwner({
      email: `routing-${Date.now()}@example.com`,
      name: "O",
      accountName: "Routing test",
      password: "correct horse battery staple",
    });
    const accountId = r.account.id;
    const db = accountDb(accountId);
    const company = await systemDb().company.findFirstOrThrow({ where: { accountId } });
    const other = await db.company.create({ data: { accountId, name: "Other Co" } });
    const store = await db.store.create({
      data: {
        accountId,
        companyId: company.id,
        domain: `r-${Date.now()}.example`,
        code: "RT",
        name: "S",
        currency: "EUR",
      },
    });
    const mk = (name: string, type: "FHB_V3" | "EUSHIPMENTS", companyId: string) =>
      db.fulfillmentConnection.create({ data: { accountId, companyId, type, name } });
    const fhb = await mk("FHB Main", "FHB_V3", company.id);
    const eu = await mk("euShipments BG", "EUSHIPMENTS", company.id);
    const otherConn = await mk("FHB Other", "FHB_V3", other.id);
    const product = await db.product.create({ data: { accountId, sku: "R-1", name: "Sample" } });
    const vp = await db.vendorProduct.create({
      data: { accountId, connectionId: eu.id, productId: product.id, vendorId: "R-1" },
    });
    await db.stockLevel.create({
      data: {
        accountId,
        vendorProductId: vp.id,
        physical: 5,
        free: 5,
        sellable: 5,
        snapshotAt: new Date(),
        source: "POLL",
      },
    });
    g = {
      accountId,
      owner: { userId: r.user.id, accountId, role: "OWNER", companyScope: null },
      company: company.id,
      otherCompany: other.id,
      store: store.id,
      fhb: fhb.id,
      eu: eu.id,
      other: otherConn.id,
      product: product.id,
    };
  });

  it("create / update / move / delete are audited and keep the order", async () => {
    const a = await createRoutingRule(g.owner, {
      name: "BG COD",
      connectionId: g.fhb,
      match: { countries: ["bg"], payment: "COD", tags: [] },
    });
    const b = await createRoutingRule(g.owner, { name: "Everything else", connectionId: g.eu });
    expect(a.match).toEqual({ countries: ["BG"], payment: "COD" }); // empty lists are not stored
    expect(b.priority).toBeGreaterThan(a.priority);
    await updateRoutingRule(g.owner, a.id, {
      name: "BG COD + stock",
      connectionId: g.fhb,
      match: { countries: ["BG"], payment: "COD", requireStock: true },
    });
    expect(await moveRoutingRule(g.owner, b.id, "up")).toEqual({ from: 2, to: 1 });
    expect(await moveRoutingRule(g.owner, b.id, "up")).toBeNull(); // already first
    const listed = await listRoutingRules(g.owner);
    expect(listed.map((r) => [r.number, r.name])).toEqual([
      [1, "Everything else"],
      [2, "BG COD + stock"],
    ]);
    await deleteRoutingRule(g.owner, b.id);
    await deleteRoutingRule(g.owner, a.id);
    const actions = (
      await accountDb(g.accountId).auditLog.findMany({
        where: { entityType: "RoutingRule" },
        orderBy: { createdAt: "asc" },
      })
    ).map((x) => x.action);
    expect(actions).toEqual([
      "routing.rule_created",
      "routing.rule_created",
      "routing.rule_updated",
      "routing.rule_moved",
      "routing.rule_deleted",
      "routing.rule_deleted",
    ]);
  });

  it("only OWNER/ADMIN; a restricted admin sees and edits only rules inside their companies", async () => {
    await expect(
      createRoutingRule({ ...g.owner, role: "OPERATOR" }, { name: "x", connectionId: g.fhb }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listRoutingRules({ ...g.owner, role: "VIEWER" })).rejects.toBeInstanceOf(ForbiddenError);
    const foreign = await createRoutingRule(g.owner, { name: "Other company", connectionId: g.other });
    const scoped: ScopedActor = { ...g.owner, role: "ADMIN", companyScope: [g.company] };
    expect((await listRoutingRules(scoped)).map((r) => r.id)).not.toContain(foreign.id);
    await expect(deleteRoutingRule(scoped, foreign.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(createRoutingRule(scoped, { name: "x", connectionId: g.other })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      createRoutingRule(g.owner, { name: "x", connectionId: g.fhb, match: { storeIds: ["nope"] } }),
    ).rejects.toMatchObject({ code: "routing_unknown_store" });
    await deleteRoutingRule(g.owner, foreign.id);
  });

  it("a restricted admin cannot touch a rule that routes another company's store, even to their warehouse", async () => {
    const otherStore = await accountDb(g.accountId).store.create({
      data: {
        accountId: g.accountId,
        companyId: g.otherCompany,
        domain: `ro-${Date.now()}.example`,
        code: "RO",
        name: "Other store",
        currency: "EUR",
      },
    });
    const scoped: ScopedActor = { ...g.owner, role: "ADMIN", companyScope: [g.company] };
    const rule = await createRoutingRule(g.owner, {
      name: "Other store to our warehouse",
      connectionId: g.fhb,
      match: { storeIds: [otherStore.id] },
    });
    expect((await listRoutingRules(scoped)).map((r) => r.id)).not.toContain(rule.id);
    await expect(deleteRoutingRule(scoped, rule.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(
      updateRoutingRule(scoped, rule.id, { name: "mine now", connectionId: g.fhb }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(moveRoutingRule(scoped, rule.id, "up")).rejects.toMatchObject({ code: "not_found" });
    expect(await accountDb(g.accountId).routingRule.count({ where: { id: rule.id } })).toBe(1);
    await deleteRoutingRule(g.owner, rule.id);
  });

  it("a restricted admin cannot move their rule past another company's rule", async () => {
    const scoped: ScopedActor = { ...g.owner, role: "ADMIN", companyScope: [g.company] };
    const foreign = await createRoutingRule(g.owner, { name: "Other company first", connectionId: g.other });
    const mine = await createRoutingRule(g.owner, { name: "Catch-all of ours", connectionId: g.fhb });
    const mine2 = await createRoutingRule(g.owner, { name: "Second of ours", connectionId: g.eu });
    await expect(moveRoutingRule(scoped, mine.id, "up")).rejects.toMatchObject({
      code: "routing_out_of_scope",
    });
    const order = async () =>
      (await listRoutingRules(g.owner))
        .filter((r) => [foreign.id, mine.id, mine2.id].includes(r.id))
        .map((r) => r.id);
    expect(await order()).toEqual([foreign.id, mine.id, mine2.id]);
    // Between two of their own rules the move is fine.
    expect(await moveRoutingRule(scoped, mine2.id, "up")).toMatchObject({ from: 3, to: 2 });
    expect(await order()).toEqual([foreign.id, mine2.id, mine.id]);
    // An unrestricted owner may still move across companies.
    expect(await moveRoutingRule(g.owner, mine2.id, "up")).toMatchObject({ from: 2, to: 1 });
    for (const r of [foreign, mine, mine2]) await deleteRoutingRule(g.owner, r.id);
  });

  it("routeOrder uses the stored rules and the mirrored stock", async () => {
    const db = accountDb(g.accountId);
    const o = await db.order.create({
      data: {
        accountId: g.accountId,
        companyId: g.company,
        source: "MANUAL",
        storeId: g.store,
        number: "R-1",
        currency: "EUR",
        subtotal: "10.00",
        total: "10.00",
        paymentMethod: "COD",
        countryCode: "BG",
        placedAt: new Date(),
        lines: {
          create: [
            {
              productId: g.product,
              sku: "R-1",
              title: "Sample",
              quantity: 2,
              unitPrice: "5.00",
            },
          ],
        },
      },
    });
    const r1 = await createRoutingRule(g.owner, {
      name: "BG to FHB if stock",
      connectionId: g.fhb,
      match: { countries: ["BG"], requireStock: true },
    });
    const d = await routeOrder(g.accountId, o.id);
    expect(d).toMatchObject({ via: "stock_fallback", connectionId: g.eu });
    expect(d.stock?.lines).toEqual([{ productId: g.product, title: "R-1", need: 2, available: 5 }]);
    const r2 = await createRoutingRule(g.owner, {
      name: "COD to euShipments",
      connectionId: g.eu,
      match: { payment: "COD" },
    });
    expect((await routeOrder(g.accountId, o.id)).explanation.bg).toBe(
      "Правило 2: COD → euShipments BG; наличност OK",
    );
    await deleteRoutingRule(g.owner, r1.id);
    await deleteRoutingRule(g.owner, r2.id);
  });
});
