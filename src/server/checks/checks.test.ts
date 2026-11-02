import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/auth/rbac";
import { euTestGroup, euTestOrder } from "@/server/eushipments/test-fixtures";
import { transitionOrder } from "@/server/pipeline";
import type { RoutingDecision } from "@/server/routing";
import { createRoutingRule } from "@/server/routing";
import {
  checkOrder,
  checkOrderAs,
  latestOrderCheck,
  orderLevelFindings,
  ordersDueForCheck,
  validateOrder,
  type CheckOrder,
  type OrderCheckContext,
} from "./index";

// Synthetic data only; no vendor is called (validators are pure, the preview functions only read).

const routed: RoutingDecision = {
  connectionId: "c1",
  connectionName: "FHB",
  connectionType: "FHB_V3",
  via: "rule",
  ruleId: "r1",
  ruleNumber: 1,
  ruleName: "r",
  crossCompany: false,
  carrier: null,
  stock: { status: "ok", lines: [{ productId: "p1", title: "SKU-1", need: 1, available: 3 }] },
  explanation: { bg: "Правило 1", en: "Rule 1" },
  steps: [],
};
const clean: CheckOrder = {
  number: "#1",
  customerName: "Test Buyer",
  email: "buyer@example.com",
  phone: "0888 123 456",
  shippingAddress: {
    name: "Test Buyer",
    address1: "Example Street 1",
    city: "Sofia",
    zip: "1000",
    countryCode: "BG",
  },
  countryCode: "BG",
  currency: "EUR",
  total: 40,
  paymentMethod: "COD",
  codAmount: 40,
  codLocalAmount: null,
  codLocalCurrency: null,
  tags: [],
  lines: [{ title: "Sample", sku: "SKU-1", productId: "p1", quantity: 1 }],
};
const ctx: OrderCheckContext = { localCurrency: "EUR", routing: routed, stock: routed.stock, duplicates: [] };
const codes = (o: Partial<CheckOrder>, c: Partial<OrderCheckContext> = {}) =>
  orderLevelFindings({ ...clean, ...o }, { ...ctx, ...c }).findings.map((f) => `${f.severity}:${f.code}`);

describe("order-level checks (pure)", () => {
  it("a clean order has no findings and gets an E.164 phone", () => {
    const r = orderLevelFindings(clean, ctx);
    expect(r.findings).toEqual([]);
    expect(r.normalised).toEqual({ phone: "+359888123456", country: "BG" });
  });

  it("address completeness, with a suggested fix where one is known", () => {
    expect(codes({ shippingAddress: { ...clean.shippingAddress, zip: " ", city: null } })).toEqual([
      "hard:order.address.city_missing",
      "hard:order.address.zip_missing",
    ]);
    const r = orderLevelFindings({ ...clean, shippingAddress: { ...clean.shippingAddress, name: "" } }, ctx);
    expect(r.findings[0]).toMatchObject({
      code: "order.address.name_missing",
      severity: "soft",
      suggestedFix: { field: "shippingAddress.name", value: "Test Buyer" },
    });
    expect(codes({ shippingAddress: { ...clean.shippingAddress, name: null }, customerName: null })).toEqual([
      "hard:order.address.name_missing",
    ]);
    expect(
      codes({ shippingAddress: { ...clean.shippingAddress, countryCode: null }, countryCode: null }),
    ).toContain("hard:order.address.country_invalid");
  });

  it("phone normalisation", () => {
    expect(codes({ phone: null, shippingAddress: { ...clean.shippingAddress, phone: null } })).toEqual([
      "hard:order.phone_missing",
    ]);
    expect(codes({ phone: "call me" })).toEqual(["hard:order.phone_invalid"]);
    expect(orderLevelFindings({ ...clean, phone: "+359 888 123 456" }, ctx).normalised.phone).toBe(
      "+359888123456",
    );
  });

  it("unmatched lines, no lines, Shopify test orders", () => {
    expect(codes({ lines: [{ title: "X", sku: "X", productId: null, quantity: 1 }] })).toContain(
      "hard:order.line_unmatched",
    );
    expect(codes({ lines: [] })).toContain("hard:order.no_lines");
    expect(codes({ tags: ["shopify-test"] })).toContain("hard:order.test_order");
  });

  it("COD rules: amount, not above the total, local currency known and used", () => {
    expect(codes({ codAmount: null })).toEqual(["hard:order.cod_amount_missing"]);
    const fix = orderLevelFindings({ ...clean, codAmount: 0 }, ctx).findings[0];
    expect(fix?.suggestedFix).toEqual({ field: "codAmount", value: "40.00" });
    expect(codes({ codAmount: 45 })).toEqual(["soft:order.cod_exceeds_total"]);
    expect(codes({}, { localCurrency: null })).toEqual(["hard:order.cod_country_setting_missing"]);
    expect(codes({ currency: "EUR" }, { localCurrency: "RON" })).toEqual([
      "hard:order.cod_not_local_currency",
    ]);
    expect(
      codes({ currency: "EUR", codLocalAmount: 199, codLocalCurrency: "RON" }, { localCurrency: "RON" }),
    ).toEqual([]);
    expect(codes({ paymentMethod: "PREPAID", codAmount: null }, { localCurrency: null })).toEqual([]);
  });

  it("stock and routing", () => {
    const short = {
      status: "insufficient" as const,
      lines: [{ productId: "p1", title: "SKU-1", need: 3, available: 1 }],
    };
    expect(codes({}, { stock: short })).toEqual(["hard:stock.insufficient"]);
    const unknown = {
      status: "unknown" as const,
      lines: [{ productId: "p1", title: "SKU-1", need: 1, available: null }],
    };
    expect(codes({}, { stock: unknown })).toEqual(["soft:stock.unknown"]);
    expect(codes({}, { routing: { ...routed, connectionId: null }, stock: null })).toEqual([
      "hard:routing.no_connection",
    ]);
    expect(codes({}, { duplicates: [{ number: "#0" }] })).toEqual(["soft:order.possible_duplicate"]);
  });
});

describe("validateOrder / checkOrder (database)", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  const mapProduct = async (productId: string, free = 100) => {
    const vp = await g.db.vendorProduct.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        productId,
        vendorId: `ref-${productId}`,
      },
    });
    await g.db.stockLevel.create({
      data: {
        accountId: g.accountId,
        vendorProductId: vp.id,
        physical: free,
        free,
        sellable: free,
        snapshotAt: new Date(),
        source: "POLL",
      },
    });
  };
  const fresh = async (number: string) => {
    const { order, product } = await euTestOrder(g, { number });
    await g.db.order.update({
      where: { id: order.id },
      data: { status: "IMPORTED", email: "buyer@example.com" },
    });
    return { order, product };
  };

  beforeAll(async () => {
    g = await euTestGroup("checks");
    await g.db.countrySetting.create({ data: { accountId: g.accountId, country: "BG", currency: "EUR" } });
  });

  it("a clean order is routed by stock, has no findings, goes IMPORTED → CHECKING → READY and can be approved", async () => {
    const { order, product } = await fresh("#2001");
    await mapProduct(product.id);
    const r = await checkOrder(g.accountId, order.id, { actor: { kind: "system" } });
    expect(r.findings).toEqual([]);
    expect(r).toMatchObject({ status: "READY", moved: true, connectionId: g.connection.id, hardCount: 0 });
    expect(r.routing.via).toBe("stock_fallback");
    const stored = await latestOrderCheck(g.accountId, order.id);
    expect(stored).toMatchObject({ connectionId: g.connection.id, hardCount: 0, softCount: 0 });
    expect((stored!.routing as { explanation: { bg: string } }).explanation.bg).toContain("наличност OK");
    const events = await g.db.orderEvent.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => `${e.fromStatus}→${e.toStatus}:${e.cause}`)).toEqual([
      "IMPORTED→CHECKING:check_start",
      "CHECKING→READY:check_result",
    ]);
    await expect(
      transitionOrder(g.accountId, {
        orderId: order.id,
        to: "APPROVED",
        cause: "approve",
        actor: { kind: "user", userId: g.owner.userId },
      }),
    ).resolves.toMatchObject({ changed: true });
  });

  it("the routed rule decides the connection; the vendor validators run for it", async () => {
    const { order, product } = await fresh("#2002");
    await mapProduct(product.id);
    const rule = await createRoutingRule(g.owner, {
      name: "BG COD",
      connectionId: g.connection.id,
      match: { countries: ["BG"], payment: "COD" },
    });
    const r = await validateOrder(g.accountId, order.id);
    expect(r.routing).toMatchObject({ via: "rule", ruleId: rule.id, ruleNumber: 1 });
    expect(r.routing.explanation.bg).toBe("Правило 1: BG + COD → euShipments test; наличност OK");
    await g.db.routingRule.delete({ where: { id: rule.id } });
  });

  it("problems → NEEDS_REVIEW with vendor findings; approval is refused while a hard finding exists", async () => {
    const { order } = await fresh("#2003"); // product not linked at euShipments, no stock anywhere
    const r = await checkOrder(g.accountId, order.id, {
      actor: { kind: "system" },
      connectionId: g.connection.id,
    });
    expect(r.status).toBe("NEEDS_REVIEW");
    const all = r.findings.map((f) => `${f.source}:${f.code}`);
    expect(all).toEqual(
      expect.arrayContaining(["eushipments:eushipments.product_not_mapped", "stock:stock.unknown"]),
    );
    expect(r.findings[0]!.severity).toBe("hard"); // hard first
    await expect(
      transitionOrder(g.accountId, {
        orderId: order.id,
        to: "APPROVED",
        cause: "approve",
        actor: { kind: "user", userId: g.owner.userId },
      }),
    ).rejects.toMatchObject({ code: "transition_guard:hard_findings" });
    // Without an explicit connection nothing can ship it: routing says so.
    const routedOnly = await validateOrder(g.accountId, order.id, { persist: false });
    expect(routedOnly.findings.map((f) => f.code)).toContain("routing.no_connection");
  });

  it("FHB preview runs the FHB validators without consuming a variable symbol or creating a shipment", async () => {
    const { order } = await fresh("#2004");
    const fhb = await g.db.fulfillmentConnection.create({
      data: { accountId: g.accountId, companyId: g.company.id, type: "FHB_V3", name: "FHB test" },
    });
    const r = await validateOrder(g.accountId, order.id, { connectionId: fhb.id });
    expect(r.findings.some((f) => f.source === "fhb" && f.severity === "hard")).toBe(true);
    const after = await g.db.fulfillmentConnection.findUniqueOrThrow({ where: { id: fhb.id } });
    expect(after.variableSymbolNext).toBe(fhb.variableSymbolNext);
    expect(await g.db.fulfillment.count({ where: { orderId: order.id } })).toBe(0);
    expect(await g.db.outboundRequest.count({ where: { connectionId: fhb.id } })).toBe(0);
  });

  it("an order already at the warehouse is validated but its status is left alone", async () => {
    const { order } = await fresh("#2005");
    await g.db.order.update({ where: { id: order.id }, data: { status: "SHIPPED" } });
    const r = await checkOrder(g.accountId, order.id, { actor: { kind: "system" } });
    expect(r).toMatchObject({ status: "SHIPPED", moved: false });
  });

  it("people need orders.review and the order in their companies", async () => {
    const { order } = await fresh("#2006");
    await expect(checkOrderAs({ ...g.owner, role: "VIEWER" }, order.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      checkOrderAs({ ...g.owner, role: "OPERATOR", companyScope: ["other"] }, order.id),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    const r = await checkOrderAs({ ...g.owner, role: "OPERATOR" }, order.id);
    expect(r.moved).toBe(true);
    const ev = await g.db.orderEvent.findFirst({ where: { orderId: order.id, cause: "check_start" } });
    expect(ev).toMatchObject({ actorType: "user", userId: g.owner.userId });
  });

  it("the sweep finds IMPORTED orders and orders stuck in CHECKING", async () => {
    const { order } = await fresh("#2007");
    const stuck = await fresh("#2008");
    await g.db.order.update({ where: { id: stuck.order.id }, data: { status: "CHECKING" } });
    const due = (await ordersDueForCheck(new Date(Date.now() + 11 * 60_000))).map((o) => o.id);
    expect(due).toEqual(expect.arrayContaining([order.id, stuck.order.id]));
    const soon = (await ordersDueForCheck()).map((o) => o.id);
    expect(soon).toContain(order.id);
    expect(soon).not.toContain(stuck.order.id);
  });
});
