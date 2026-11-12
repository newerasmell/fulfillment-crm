import { beforeAll, describe, expect, it, vi } from "vitest";
import { ShopifyClient, type ShopifyClientOptions } from "@/integrations/shopify/client";
import {
  customPhoneRule,
  effectivePhoneRule,
  normalisePhone,
  PHONE_RULES,
  PhoneRuleSchema,
} from "@/integrations/eushipments/phone";
import { normalisePhoneE164 } from "@/integrations/fhb-v3/phone";
import { estimateQueryCost } from "@/integrations/shopify/query-cost";
import { TokenProvider } from "@/integrations/shopify/token";
import {
  VARIANT_WEIGHT_READ_QUERY,
  VARIANT_WEIGHT_UPDATE_MUTATION,
  weightToGrams,
} from "@/integrations/shopify/weights";
import { ForbiddenError } from "@/server/auth/rbac";
import { checkOrder, latestOrderCheck, type Finding } from "@/server/checks";
import { recheckOpenOrders, ordersToCountry } from "@/server/checks/recheck";
import {
  listCountries,
  previewPhoneRule,
  saveCountrySetting,
  suggestPhoneRule,
} from "@/server/countries/phone-rules";
import { orderSourceFixes, productOfWeightFinding } from "@/server/countries/order-fixes";
import { systemDb } from "@/server/db/client";
import { euTestGroup, euTestOrder } from "@/server/eushipments/test-fixtures";
import type { StoreClientFactory } from "@/server/fulfill/writeback";
import { createRoutingRule } from "@/server/routing";
import { upsertVariant } from "@/server/shopify/products";
import type { ScopedActor } from "@/server/stores";
import {
  processWeightWrite,
  sweepWeightWrites,
  WEIGHT_WRITE_MAX_ATTEMPTS,
  WEIGHT_WRITE_STALE_MS,
} from "./shopify-weight";
import {
  fillWeightsFromWarehouse,
  productWeightView,
  queueShopifyWeight,
  setProductWeight,
  weightSuggestions,
} from "./weights";

// Synthetic data only (CY example numbers, example.com); Shopify is a mocked fetch; no vendor is called.

const CY_RULE = { style: "international" as const, cc: "357", trunk: "", lengths: [8] };
const VARIANT_GID = "gid://shopify/ProductVariant/7000001";
const PRODUCT_GID = "gid://shopify/Product/7100001";

type Group = Awaited<ReturnType<typeof euTestGroup>>;
const as = (g: Group, role: ScopedActor["role"]): ScopedActor => ({ ...g.owner, role });
const codes = (fs: readonly Finding[]) => fs.map((f) => f.code);

/** A CY order at the euShipments connection, pre-approval, routed by a rule; stock snapshot present. */
async function cyOrder(g: Group, over: { weightGrams?: number | null; phone?: string } = {}) {
  const { order, product } = await euTestOrder(g, {
    country: "CY",
    phone: over.phone ?? "+357 99 123456",
    cod: null,
    number: `#CY${Math.random().toString(36).slice(2, 7)}`,
  });
  await g.db.order.update({ where: { id: order.id }, data: { status: "NEEDS_REVIEW" } });
  if (over.weightGrams !== undefined)
    await g.db.product.update({ where: { id: product.id }, data: { weightGrams: over.weightGrams } });
  const vp = await g.db.vendorProduct.create({
    data: {
      accountId: g.accountId,
      connectionId: g.connection.id,
      productId: product.id,
      vendorId: `ref-${product.id}`,
      lastSyncAt: new Date(),
      raw: { weight: "0.45" },
    },
  });
  await g.db.stockLevel.create({
    data: {
      accountId: g.accountId,
      vendorProductId: vp.id,
      physical: 50,
      free: 50,
      sellable: 50,
      snapshotAt: new Date(),
      source: "POLL",
    },
  });
  return { order, product, vp };
}

async function cyGroup(label: string) {
  const g = await euTestGroup(label);
  await createRoutingRule(g.owner, {
    name: "CY",
    connectionId: g.connection.id,
    match: { countries: ["CY"] },
  });
  return g;
}

function fakeShopify(routes: Record<string, (vars: Record<string, unknown>) => unknown | Promise<unknown>>) {
  const ops: { op: string; vars: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/admin/oauth/access_token"))
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 86399 }), { status: 200 });
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const op = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "?";
    ops.push({ op, vars: body.variables });
    const h = routes[op];
    if (!h) throw new Error(`unexpected operation ${op}`);
    const out = await h(body.variables);
    // A handler may answer with a raw Response (5xx, 403, GraphQL errors) or throw (network failure).
    if (out instanceof Response) return out;
    return new Response(JSON.stringify({ data: out }), { status: 200 });
  });
  const tokens = new TokenProvider(fetchImpl);
  const clients: StoreClientFactory = async (_a, _s, opts: ShopifyClientOptions) => ({
    client: new ShopifyClient(
      "weights-test.myshopify.com",
      { clientId: "client-id-0002", clientSecret: "not-a-real-secret-0002" },
      { fetchImpl, tokens, sleep: async () => {}, ...opts },
    ),
    store: { notifyCustomer: false },
  });
  return { ops, clients, fetchImpl, count: (op: string) => ops.filter((o) => o.op === op).length };
}

const variantRead = (grams: number | null) => ({
  productVariant: {
    id: VARIANT_GID,
    product: { id: PRODUCT_GID },
    inventoryItem: {
      id: "gid://shopify/InventoryItem/7200001",
      measurement: { weight: grams === null ? null : { unit: "GRAMS", value: grams } },
    },
  },
});

describe("phone rules (pure): the group's own rule replaces the built-in euShipments rule", () => {
  it("a custom rule fills a country without a built-in rule only", () => {
    expect(normalisePhone("+357 99 123456", "CY")).toMatchObject({ ok: false, reason: "no_rule" });
    expect(normalisePhone("+357 99 123456", "CY", CY_RULE)).toMatchObject({
      ok: true,
      value: "+35799123456",
    });
    expect(normalisePhone("99 123456", "CY", CY_RULE)).toMatchObject({ ok: true, value: "+35799123456" });
    expect(normalisePhone("99 1234", "CY", CY_RULE)).toMatchObject({ ok: false, reason: "wrong_length" });
    // Without an own rule, BG and GR keep the guideline's national format.
    expect(normalisePhone("0888 123 456", "BG")).toMatchObject({ ok: true, value: "0888123456" });
    // A national number beginning with the code's digits (Italian mobiles start with 3: 39…) stays national.
    const IT_RULE = { style: "international" as const, cc: "39", trunk: "", lengths: [8, 9, 10] };
    expect(normalisePhone("3927838955", "IT", IT_RULE)).toMatchObject({ ok: true, value: "+393927838955" });
    expect(normalisePhone("393927838955", "IT", IT_RULE)).toMatchObject({ ok: true, value: "+393927838955" });
    expect(normalisePhone("+39 392 783 8955", "IT", IT_RULE)).toMatchObject({
      ok: true,
      value: "+393927838955",
    });
    // Several national prefixes (Lithuania: 8 until 2025, 0 since): "0, 8" is stored as "0,8"; both are stripped,
    // a national-style number is sent with the first.
    const LT = PhoneRuleSchema.parse({ style: "international", cc: "370", trunk: "0, 8", lengths: [8] });
    expect(LT.trunk).toBe("0,8");
    for (const raw of ["861234567", "061234567", "+370 612 34567", "37061234567"])
      expect(normalisePhone(raw, "LT", LT)).toMatchObject({ ok: true, value: "+37061234567" });
    const LTn = { ...LT, style: "national" as const };
    expect(normalisePhone("861234567", "LT", LTn)).toMatchObject({ ok: true, value: "061234567" });
    // One digit short, with either prefix: reported, never sent with the prefix inside.
    for (const raw of ["06123456", "86123456"])
      expect(normalisePhone(raw, "LT", LT)).toMatchObject({ ok: false, reason: "wrong_length" });
    expect(PhoneRuleSchema.parse({ ...LT, trunk: "0,0" }).trunk).toBe("0");
    expect(() => PhoneRuleSchema.parse({ ...LT, trunk: "0,8,9,7,6" })).toThrow();
    // The deliberate trade-off: a length that is both national and code + national is read as national.
    expect(normalisePhone("3912345678", "IT", IT_RULE)).toMatchObject({ ok: true, value: "+393912345678" });
    expect(effectivePhoneRule("BG", null)).toEqual({ rule: PHONE_RULES.BG, source: "builtin" });
    expect(normalisePhone("+30 698 092 8108", "GR")).toMatchObject({ ok: true, value: "6980928108" });
    // An own rule replaces it (owner decision 2026-11-06: ACS Greece accepts +30): GR goes out with +30.
    const GR_INTL = { style: "international" as const, cc: "30", trunk: "", lengths: [10] };
    expect(effectivePhoneRule("GR", GR_INTL)).toEqual({ rule: GR_INTL, source: "custom" });
    expect(normalisePhone("6980928108", "GR", GR_INTL)).toMatchObject({ ok: true, value: "+306980928108" });
    expect(normalisePhone("+30 698 092 8108", "GR", GR_INTL)).toMatchObject({
      ok: true,
      value: "+306980928108",
    });
    expect(effectivePhoneRule("CY", CY_RULE)).toEqual({ rule: CY_RULE, source: "custom" });
  });

  it("stored JSON: {} and malformed values are no rule, never a throw", () => {
    expect(customPhoneRule({})).toBeNull();
    expect(customPhoneRule(null)).toBeNull();
    expect(customPhoneRule({ style: "x", cc: "357" })).toBeNull();
    expect(customPhoneRule({ ...CY_RULE, lengths: [9, 8, 8] })).toEqual({ ...CY_RULE, lengths: [8, 9] });
  });

  it("FHB E.164: the ITU table wins; a custom calling code only for an unknown country", () => {
    expect(normalisePhoneE164("99 123456", "CY", { cc: "999", trunk: "" })).toBe("+35799123456");
    expect(normalisePhoneE164("44 123456", "XK")).toBeNull();
    expect(normalisePhoneE164("044 123456", "XK", { cc: "383", trunk: "0" })).toBe("+38344123456");
  });

  it("suggestion and preview from the order's phone", () => {
    expect(suggestPhoneRule("+357 99 123456", "CY")).toEqual(CY_RULE);
    expect(suggestPhoneRule("0035799123456", "CY")).toEqual(CY_RULE);
    expect(suggestPhoneRule("99123456", "CY")).toEqual(CY_RULE);
    expect(suggestPhoneRule("123", "ZZ")).toBeNull();
    const p = previewPhoneRule(CY_RULE, "+357 99 123456", "CY");
    expect(p.euShipments).toMatchObject({ ok: true, value: "+35799123456" });
    expect(p.fhb).toBe("+35799123456");
  });
});

describe("country phone rule: save, RBAC, audit, re-check of open orders", () => {
  let g: Group;
  let other: Group;
  beforeAll(async () => {
    g = await cyGroup("cy-rule");
    other = await cyGroup("cy-rule-other");
  });

  it("only OWNER/ADMIN; a built-in country can be replaced by an own rule; a new country needs its currency", async () => {
    await expect(
      saveCountrySetting(as(g, "OPERATOR"), { country: "CY", currency: "EUR", rule: CY_RULE }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // The calling code is still the country's own (ITU), also when replacing a built-in rule.
    await expect(
      saveCountrySetting(g.owner, { country: "BG", currency: "EUR", rule: CY_RULE }),
    ).rejects.toMatchObject({ code: "calling_code_mismatch" });
    // A country without a known default currency needs one (CY now defaults to EUR).
    await expect(
      saveCountrySetting(g.owner, { country: "MK", rule: { ...CY_RULE, cc: "389" } }),
    ).rejects.toMatchObject({ code: "currency_required" });
  });

  it("saving the CY rule removes the phone finding of every open CY order of the group, not of another group", async () => {
    const { order } = await cyOrder(g, { weightGrams: 400 });
    const { order: closed } = await cyOrder(g, { weightGrams: 400 });
    await g.db.order.update({ where: { id: closed.id }, data: { status: "ACCEPTED" } });
    const { order: foreign } = await cyOrder(other, { weightGrams: 400 });
    const first = await checkOrder(g.accountId, order.id, { actor: { kind: "system" } });
    expect(codes(first.findings)).toContain("eushipments.phone_invalid");
    await checkOrder(other.accountId, foreign.id, { actor: { kind: "system" } });

    // The order screen offers the rule, pre-filled from the order's phone.
    const fixes = await orderSourceFixes(g.owner, order, first.findings);
    expect(fixes.phone).toMatchObject({ country: "CY", initial: CY_RULE, needsCurrency: true });
    expect((await orderSourceFixes(as(g, "OPERATOR"), order, first.findings)).phone).toBeNull();

    const enqueue = vi.fn(async () => {});
    const r = await saveCountrySetting(
      g.owner,
      { country: "CY", currency: "EUR", rule: CY_RULE },
      { enqueue },
    );
    expect(r.recheck).toMatchObject({ total: 1, checked: 1, queued: 0 });
    expect(enqueue).not.toHaveBeenCalled();
    const after = await latestOrderCheck(g.accountId, order.id);
    expect(codes(after!.findings as unknown as Finding[])).not.toContain("eushipments.phone_invalid");
    expect(codes(after!.findings as unknown as Finding[])).not.toContain("order.phone_invalid");
    // The other group still has no CY rule and its order was not touched.
    const foreignCheck = await latestOrderCheck(other.accountId, foreign.id);
    expect(codes(foreignCheck!.findings as unknown as Finding[])).toContain("eushipments.phone_invalid");
    expect((await listCountries(other.owner)).find((c) => c.country === "CY")).toBeUndefined();

    const audit = await g.db.auditLog.findFirst({ where: { action: "country.settings" } });
    expect(audit?.after).toMatchObject({ country: "CY", currency: "EUR", phoneRules: CY_RULE });
    const row = (await listCountries(g.owner)).find((c) => c.country === "CY");
    expect(row).toMatchObject({ currency: "EUR", custom: CY_RULE, builtin: null });
    expect((await listCountries(g.owner)).find((c) => c.country === "BG")?.builtin).toEqual(PHONE_RULES.BG);
  });

  it("re-checks beyond the inline limit go to the background queue", async () => {
    await cyOrder(g, { weightGrams: 400 });
    await cyOrder(g, { weightGrams: 400 });
    const enqueue = vi.fn(async (_ids: string[]) => {});
    const r = await recheckOpenOrders(g.accountId, ordersToCountry("CY"), {
      actor: { kind: "system" },
      enqueue,
      inlineLimit: 1,
    });
    expect(r.checked).toBe(1);
    expect(r.queued).toBe(r.total - 1);
    expect(enqueue.mock.calls[0]![0]).toHaveLength(r.total - 1);
  });
});

describe("product weight: save once, all orders re-checked; suggestions; bulk fill", () => {
  let g: Group;
  beforeAll(async () => {
    g = await cyGroup("weights");
    await saveCountrySetting(g.owner, { country: "CY", currency: "EUR", rule: CY_RULE });
  });

  it("weight_missing names the product; saving the weight clears it on every open order", async () => {
    const { order, product } = await cyOrder(g, { weightGrams: null });
    const first = await checkOrder(g.accountId, order.id, { actor: { kind: "system" } });
    const wf = first.findings.find((f) => f.code === "eushipments.weight_missing")!;
    expect(wf.field).toBe(`product:${product.id}.weightGrams`);
    expect(productOfWeightFinding(wf)).toBe(product.id);
    const fixes = await orderSourceFixes(g.owner, order, first.findings);
    expect(fixes.weights.get(product.id)?.suggestions).toEqual([
      expect.objectContaining({ source: "eushipments", grams: 450 }),
    ]);

    await expect(setProductWeight(as(g, "WAREHOUSE"), product.id, { grams: 450 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(setProductWeight(g.owner, product.id, { grams: 0 })).rejects.toThrow();
    await expect(setProductWeight(g.owner, product.id, { grams: 100_001 })).rejects.toThrow();

    const r = await setProductWeight(as(g, "OPERATOR"), product.id, { grams: 450, source: "eushipments" });
    expect(r.recheck).toMatchObject({ checked: 1 });
    const after = await latestOrderCheck(g.accountId, order.id);
    expect(codes(after!.findings as unknown as Finding[])).not.toContain("eushipments.weight_missing");
    expect(after!.hardCount).toBe(0);
    const p = await g.db.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(p).toMatchObject({ weightGrams: 450, weightSource: "eushipments", weightSetById: g.owner.userId });
    const audit = await g.db.auditLog.findFirst({
      where: { action: "product.weight", entityId: product.id },
    });
    expect(audit?.before).toMatchObject({ weightGrams: null });
    expect(audit?.after).toMatchObject({ weightGrams: 450 });
  });

  it("another group cannot set this group's product weight (tenant scope)", async () => {
    const { product } = await cyOrder(g, { weightGrams: null });
    const stranger = await euTestGroup("weights-stranger");
    await expect(setProductWeight(stranger.owner, product.id, { grams: 300 })).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await weightSuggestions(stranger.accountId, [product.id])).size).toBe(0);
  });

  it("suggestions: euShipments kg, FHB (unit assumed), Shopify variant weight", async () => {
    const { product } = await cyOrder(g, { weightGrams: null });
    const fhb = await g.db.fulfillmentConnection.create({
      data: { accountId: g.accountId, type: "FHB_V3", name: "FHB test", liveMode: "READ_ONLY" },
    });
    await g.db.vendorProduct.create({
      data: {
        accountId: g.accountId,
        connectionId: fhb.id,
        productId: product.id,
        vendorId: `fhb-${product.id}`,
        raw: { id: "x", weight: 0.3 },
      },
    });
    await g.db.storeVariantLink.create({
      data: {
        accountId: g.accountId,
        storeId: g.store.id,
        shopifyVariantGid: `${VARIANT_GID}-s`,
        shopifyProductGid: PRODUCT_GID,
        title: "Sample",
        productId: product.id,
        shopifyWeightGrams: 460,
      },
    });
    const s = (await weightSuggestions(g.accountId, [product.id])).get(product.id)!;
    expect(s).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "eushipments", grams: 450 }),
        expect.objectContaining({ source: "fhb", grams: 300, unitAssumed: true }),
        expect.objectContaining({ source: "shopify", grams: 460 }),
      ]),
    );
  });

  it("bulk fill: only masters without a weight, never a weight a person entered, conflicts left alone", async () => {
    const { product: empty } = await cyOrder(g, { weightGrams: null });
    const { product: typed } = await cyOrder(g, { weightGrams: 999 });
    const { product: conflict } = await cyOrder(g, { weightGrams: null });
    const eu2 = await g.db.fulfillmentConnection.create({
      data: { accountId: g.accountId, type: "EUSHIPMENTS", name: "euShipments 2", liveMode: "READ_ONLY" },
    });
    await g.db.vendorProduct.create({
      data: {
        accountId: g.accountId,
        connectionId: eu2.id,
        productId: conflict.id,
        vendorId: `eu2-${conflict.id}`,
        raw: { weight: 0.7 },
      },
    });
    await expect(fillWeightsFromWarehouse(as(g, "WAREHOUSE"))).rejects.toBeInstanceOf(ForbiddenError);
    const r = await fillWeightsFromWarehouse(g.owner);
    expect(r.filled).toBeGreaterThanOrEqual(1);
    expect(r.conflicts).toBeGreaterThanOrEqual(1);
    const read = (id: string) => g.db.product.findUniqueOrThrow({ where: { id } });
    expect(await read(empty.id)).toMatchObject({ weightGrams: 450, weightSource: "eushipments" });
    expect((await read(typed.id)).weightGrams).toBe(999);
    expect((await read(conflict.id)).weightGrams).toBeNull();

    // A chosen main warehouse settles the disagreement with its own value (audited with the choice).
    const r2 = await fillWeightsFromWarehouse(g.owner, { preferConnectionId: eu2.id });
    expect(r2.fromPreferred).toBeGreaterThanOrEqual(1);
    expect(await read(conflict.id)).toMatchObject({ weightGrams: 700, weightSource: "eushipments" });
    // A main warehouse without a value for the product leaves the disagreement for a person.
    const { product: other } = await cyOrder(g, { weightGrams: null });
    await g.db.vendorProduct.create({
      data: {
        accountId: g.accountId,
        connectionId: eu2.id,
        productId: other.id,
        vendorId: `eu2b-${other.id}`,
        raw: { weight: 0.9 },
      },
    });
    const elsewhere = await g.db.fulfillmentConnection.create({
      data: { accountId: g.accountId, type: "EUSHIPMENTS", name: "euShipments 3", liveMode: "READ_ONLY" },
    });
    const r3 = await fillWeightsFromWarehouse(g.owner, { preferConnectionId: elsewhere.id });
    expect(r3.conflicts).toBeGreaterThanOrEqual(1);
    expect((await read(other.id)).weightGrams).toBeNull();
  });
});

describe("weight write-back to Shopify: mode gate in the sender, idempotent per (variant, weight)", () => {
  let g: Group;
  let productId: string;
  let linkId: string;
  beforeAll(async () => {
    g = await euTestGroup("weight-writeback");
    const p = await g.db.product.create({
      data: { accountId: g.accountId, sku: `W-${Date.now()}`, name: "Weight sample" },
    });
    productId = p.id;
    const link = await g.db.storeVariantLink.create({
      data: {
        accountId: g.accountId,
        storeId: g.store.id,
        shopifyVariantGid: VARIANT_GID,
        shopifyProductGid: PRODUCT_GID,
        title: "Weight sample",
        productId,
      },
    });
    linkId = link.id;
  });
  const setMode = (m: "DISABLED" | "DRY_RUN" | "LIVE") =>
    g.db.store.update({ where: { id: g.store.id }, data: { weightWriteMode: m } });
  const rows = () =>
    g.db.shopifyWeightWrite.findMany({ where: { productId }, orderBy: { createdAt: "asc" } });

  it("queries stay under the Shopify cost cap", () => {
    expect(estimateQueryCost(VARIANT_WEIGHT_READ_QUERY, {})).toBeLessThan(1000);
    expect(estimateQueryCost(VARIANT_WEIGHT_UPDATE_MUTATION, {})).toBeLessThan(1000);
    expect(weightToGrams({ unit: "KILOGRAMS", value: 0.45 })).toBe(450);
    expect(weightToGrams({ unit: "STONES", value: 1 })).toBeNull();
  });

  it("DISABLED (the default): nothing is recorded", async () => {
    const r = await setProductWeight(g.owner, productId, { grams: 450, writeToShopify: true });
    expect(r.shopify).toMatchObject({ queued: 0, skippedStores: ["S"] });
    expect(await rows()).toHaveLength(0);
  });

  it("DRY_RUN: the exact payload is recorded at once, Shopify is never called", async () => {
    await setMode("DRY_RUN");
    const shop = fakeShopify({});
    const r = await setProductWeight(
      g.owner,
      productId,
      { grams: 450, writeToShopify: true },
      { clients: shop.clients },
    );
    expect(r.shopify?.queued).toBe(1);
    const [row] = await rows();
    expect(row).toMatchObject({ status: "DRY_RUN_RECORDED", evaluatedMode: "DRY_RUN", weightGrams: 450 });
    expect((row!.request as { variables: unknown }).variables).toEqual({
      productId: PRODUCT_GID,
      variants: [
        { id: VARIANT_GID, inventoryItem: { measurement: { weight: { unit: "GRAMS", value: 450 } } } },
      ],
    });
    expect(shop.fetchImpl).not.toHaveBeenCalled();
    // The same weight again: still one row (idempotent per variant + weight).
    await setProductWeight(
      g.owner,
      productId,
      { grams: 450, writeToShopify: true },
      { clients: shop.clients },
    );
    expect(await rows()).toHaveLength(1);
  });

  it("LIVE: the web gate leaves it to the worker; the sender reads back, sends once, never twice", async () => {
    await setMode("LIVE");
    const shop = fakeShopify({
      VariantWeightRead: () => variantRead(null),
      VariantWeightUpdate: (vars) => ({
        productVariantsBulkUpdate: {
          productVariants: [
            { id: VARIANT_GID, inventoryItem: { measurement: { weight: { unit: "GRAMS", value: 450 } } } },
          ],
          userErrors: [],
          echo: vars,
        },
      }),
    });
    const r = await setProductWeight(
      g.owner,
      productId,
      { grams: 450, writeToShopify: true },
      { clients: shop.clients },
    );
    const id = r.shopify!.writeIds[0]!;
    expect((await rows())[0]!.status).toBe("PENDING"); // offline gate does not send
    expect(shop.fetchImpl).not.toHaveBeenCalled();
    expect((await sweepWeightWrites()).ready).toContain(id);
    expect(await processWeightWrite(id, shop.clients)).toBe("SENT");
    expect(shop.count("VariantWeightUpdate")).toBe(1);
    expect(await processWeightWrite(id, shop.clients)).toBe("skipped");

    // Saved again with the same weight: Shopify already has it → done by read-back, no second mutation.
    const again = fakeShopify({ VariantWeightRead: () => variantRead(450) });
    await queueShopifyWeight(g.owner, productId, 450);
    expect(await processWeightWrite(id, again.clients)).toBe("SENT");
    expect(again.count("VariantWeightUpdate")).toBe(0);
    const audit = await g.db.auditLog.findFirst({
      where: { action: "shopify.weight.sent", entityId: productId },
    });
    expect(audit).not.toBeNull();
  });

  it("userErrors fail visibly; a lowered mode refuses in the sender; a newer weight supersedes", async () => {
    const shop = fakeShopify({
      VariantWeightRead: () => variantRead(450),
      VariantWeightUpdate: () => ({
        productVariantsBulkUpdate: {
          productVariants: null,
          userErrors: [{ field: ["variants"], message: "Access denied", code: null }],
        },
      }),
    });
    // queueShopifyWeight is called by setProductWeight after the master is saved; mirror that here.
    const master = (grams: number) =>
      g.db.product.update({ where: { id: productId }, data: { weightGrams: grams } });
    await master(500);
    const q = await queueShopifyWeight(g.owner, productId, 500);
    expect(await processWeightWrite(q.writeIds[0]!, shop.clients)).toBe("FAILED");
    expect(
      await g.db.alert.findFirst({ where: { kind: "shopify_weight_failed", entityId: productId } }),
    ).not.toBeNull();

    await master(510);
    const q2 = await queueShopifyWeight(g.owner, productId, 510);
    await master(520);
    const q3 = await queueShopifyWeight(g.owner, productId, 520);
    const superseded = await g.db.shopifyWeightWrite.findUniqueOrThrow({ where: { id: q2.writeIds[0]! } });
    expect(superseded).toMatchObject({ status: "REFUSED", lastError: "superseded" });
    await setMode("DISABLED");
    expect(await processWeightWrite(q3.writeIds[0]!, shop.clients)).toBe("REFUSED");
    expect(shop.count("VariantWeightUpdate")).toBe(1);
  });

  it("RBAC: WAREHOUSE / VIEWER cannot queue a weight write", async () => {
    await expect(queueShopifyWeight(as(g, "WAREHOUSE"), productId, 450)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(queueShopifyWeight(as(g, "VIEWER"), productId, 450)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("variant sync keeps the Shopify weight as a suggestion", async () => {
    await upsertVariant(
      g.accountId,
      { id: g.store.id, skuPrefix: null, lineId: null },
      {
        id: VARIANT_GID,
        sku: null,
        title: "Default",
        displayName: "Weight sample",
        updatedAt: "2026-11-01T00:00:00Z",
        barcodes: { nodes: [] },
        inventoryItem: { measurement: { weight: { unit: "KILOGRAMS", value: 0.455 } } },
        product: { id: PRODUCT_GID, title: "Weight sample", vendor: "V", status: "ACTIVE" },
      },
    );
    const link = await systemDb().storeVariantLink.findUniqueOrThrow({ where: { id: linkId } });
    expect(link.shopifyWeightGrams).toBe(455);
    expect(link.productId).toBe(productId); // never re-pointed
  });
});

describe("weight write-back: outcome unknown, crash recovery, definite rejection, superseded rows", () => {
  let g: Group;
  beforeAll(async () => {
    g = await euTestGroup("weight-recovery");
    await g.db.store.update({ where: { id: g.store.id }, data: { weightWriteMode: "LIVE" } });
  });
  let n = 0;
  /** A fresh master + linked variant (own gid), master weight already saved as `grams`. */
  async function variant(grams: number) {
    n++;
    const p = await g.db.product.create({
      data: {
        accountId: g.accountId,
        sku: `WR-${n}-${Date.now()}`,
        name: "Recovery sample",
        weightGrams: grams,
      },
    });
    await g.db.storeVariantLink.create({
      data: {
        accountId: g.accountId,
        storeId: g.store.id,
        shopifyVariantGid: `${VARIANT_GID}${n}`,
        shopifyProductGid: PRODUCT_GID,
        title: "Recovery sample",
        productId: p.id,
      },
    });
    return p.id;
  }
  const row = (id: string) => g.db.shopifyWeightWrite.findUniqueOrThrow({ where: { id } });
  const unavailable = () => new Response("{}", { status: 503 });
  /** Shopify with one variant weight; `onUpdate` decides what the mutation does. */
  function shopWith(
    start: number | null,
    onUpdate: (grams: number, state: { grams: number | null }) => unknown,
    onRead?: (state: { grams: number | null }) => unknown,
  ) {
    const state = { grams: start };
    const shop = fakeShopify({
      VariantWeightRead: async () => {
        const out = onRead ? await onRead(state) : undefined;
        return out instanceof Response ? out : variantRead(state.grams);
      },
      VariantWeightUpdate: (vars) => {
        const grams = (
          vars as { variants: { inventoryItem: { measurement: { weight: { value: number } } } }[] }
        ).variants[0]!.inventoryItem.measurement.weight.value;
        return onUpdate(grams, state);
      },
    });
    const sentWeights = () =>
      shop.ops
        .filter((o) => o.op === "VariantWeightUpdate")
        .map(
          (o) =>
            (o.vars as { variants: { inventoryItem: { measurement: { weight: { value: number } } } }[] })
              .variants[0]!.inventoryItem.measurement.weight.value,
        );
    return { ...shop, state, sentWeights };
  }
  const applied = (grams: number, state: { grams: number | null }) => {
    state.grams = grams;
    return { productVariantsBulkUpdate: { productVariants: [{ id: VARIANT_GID }], userErrors: [] } };
  };

  it("5xx on the mutation but Shopify applied it: the read-back finishes it, exactly one mutation", async () => {
    const productId = await variant(450);
    const shop = shopWith(null, (grams, state) => {
      state.grams = grams; // applied, then the answer is lost
      return unavailable();
    });
    const q = await queueShopifyWeight(g.owner, productId, 450);
    expect(await processWeightWrite(q.writeIds[0]!, shop.clients)).toBe("SENT");
    expect(shop.count("VariantWeightUpdate")).toBe(1);
    expect((await row(q.writeIds[0]!)).lastError).toMatch(/^recovered by read-back/);
  });

  it("network failure and the read-back shows the old weight: PENDING with a backoff, FAILED + task after the max", async () => {
    const productId = await variant(460);
    const shop = shopWith(300, () => {
      throw new Error("socket hang up");
    });
    const q = await queueShopifyWeight(g.owner, productId, 460);
    const id = q.writeIds[0]!;
    let now = new Date();
    expect(await processWeightWrite(id, shop.clients, now)).toBe("PENDING");
    const r1 = await row(id);
    expect(r1.attempts).toBe(1);
    expect(r1.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());
    // Not due yet: nothing is sent.
    expect(await processWeightWrite(id, shop.clients, now)).toBe("skipped");
    expect(shop.count("VariantWeightUpdate")).toBe(1);
    for (let i = 2; i <= WEIGHT_WRITE_MAX_ATTEMPTS; i++) {
      now = new Date((await row(id)).nextAttemptAt!.getTime() + 1000);
      const s = await processWeightWrite(id, shop.clients, now);
      expect(s).toBe(i < WEIGHT_WRITE_MAX_ATTEMPTS ? "PENDING" : "FAILED");
    }
    expect(shop.count("VariantWeightUpdate")).toBe(WEIGHT_WRITE_MAX_ATTEMPTS);
    expect((await row(id)).lastError).toMatch(/^max attempts/);
    expect(
      await g.db.alert.findFirst({ where: { kind: "shopify_weight_failed", entityId: productId } }),
    ).not.toBeNull();
  });

  it("a crashed send (stale SENDING) is reset by the sweep and re-sent only after a read-back", async () => {
    const pDone = await variant(470);
    const pTodo = await variant(480);
    const qDone = await queueShopifyWeight(g.owner, pDone, 470);
    const qTodo = await queueShopifyWeight(g.owner, pTodo, 480);
    const old = new Date(Date.now() - WEIGHT_WRITE_STALE_MS - 60_000);
    const fresh = new Date();
    for (const id of [qDone.writeIds[0]!, qTodo.writeIds[0]!])
      await g.db.shopifyWeightWrite.update({
        where: { id },
        data: { status: "SENDING", lockedAt: old, attempts: 1 },
      });
    const {
      writeIds: [freshId],
    } = await queueShopifyWeight(g.owner, await variant(490), 490);
    await g.db.shopifyWeightWrite.update({
      where: { id: freshId! },
      data: { status: "SENDING", lockedAt: fresh },
    });

    const sw = await sweepWeightWrites();
    expect(sw.ready).toEqual(expect.arrayContaining([qDone.writeIds[0], qTodo.writeIds[0]]));
    expect((await row(qDone.writeIds[0]!)).status).toBe("PENDING");
    expect((await row(freshId!)).status).toBe("SENDING"); // a send in progress is left alone

    // The crashed call had reached Shopify: the read-back sees it, nothing is sent again.
    const doneShop = shopWith(470, applied);
    expect(await processWeightWrite(qDone.writeIds[0]!, doneShop.clients)).toBe("SENT");
    expect(doneShop.count("VariantWeightUpdate")).toBe(0);
    // It had not: read first, then exactly one mutation.
    const todoShop = shopWith(100, applied);
    expect(await processWeightWrite(qTodo.writeIds[0]!, todoShop.clients)).toBe("SENT");
    expect(todoShop.ops.map((o) => o.op)).toEqual(["VariantWeightRead", "VariantWeightUpdate"]);
  });

  it("a stale SENDING row whose weight was replaced meanwhile is REFUSED by the sweep, not re-sent", async () => {
    const productId = await variant(500);
    const q = await queueShopifyWeight(g.owner, productId, 500);
    const old = new Date(Date.now() - WEIGHT_WRITE_STALE_MS - 60_000);
    await g.db.shopifyWeightWrite.update({
      where: { id: q.writeIds[0]! },
      data: { status: "SENDING", lockedAt: old },
    });
    await g.db.product.update({ where: { id: productId }, data: { weightGrams: 600 } });
    const sw = await sweepWeightWrites();
    expect(sw.ready).not.toContain(q.writeIds[0]);
    expect(await row(q.writeIds[0]!)).toMatchObject({ status: "REFUSED", lastError: "superseded" });
  });

  it("definite rejection (auth_failed, GraphQL ACCESS_DENIED): FAILED at once, never retried", async () => {
    for (const answer of [
      () => new Response("{}", { status: 403 }),
      () =>
        new Response(
          JSON.stringify({ errors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }] }),
          { status: 200 },
        ),
    ]) {
      const productId = await variant(510);
      const shop = shopWith(100, answer);
      const q = await queueShopifyWeight(g.owner, productId, 510);
      const id = q.writeIds[0]!;
      expect(await processWeightWrite(id, shop.clients)).toBe("FAILED");
      const r = await row(id);
      expect(r.attempts).toBe(1);
      expect(r.nextAttemptAt).toBeNull();
      expect(await processWeightWrite(id, shop.clients, new Date(Date.now() + 86_400_000))).toBe("skipped");
      expect((await sweepWeightWrites(new Date(Date.now() + 86_400_000))).ready).not.toContain(id);
      expect(shop.count("VariantWeightUpdate")).toBe(1);
    }
  });

  it("an older weight never overwrites a newer one: A sending, B queued, A retried later → A REFUSED, no mutation", async () => {
    const productId = await variant(500);
    const a = (await queueShopifyWeight(g.owner, productId, 500)).writeIds[0]!;
    let bId: string | null = null;
    const shop = shopWith(null, async (grams, state) => {
      if (grams === 500 && !bId) {
        // While A's mutation is in flight a person saves 600 g; A's answer is lost and Shopify did not apply it.
        await setProductWeight(g.owner, productId, { grams: 600, writeToShopify: true });
        bId = (await g.db.shopifyWeightWrite.findFirstOrThrow({ where: { productId, weightGrams: 600 } })).id;
        return unavailable();
      }
      return applied(grams, state);
    });
    expect(await processWeightWrite(a, shop.clients)).toBe("PENDING"); // retryLater with a backoff
    expect(await processWeightWrite(bId!, shop.clients)).toBe("SENT");
    expect(shop.state.grams).toBe(600);
    const later = new Date((await row(a)).nextAttemptAt!.getTime() + 1000);
    expect(await processWeightWrite(a, shop.clients, later)).toBe("REFUSED");
    expect(await row(a)).toMatchObject({ status: "REFUSED", lastError: "superseded" });
    expect(shop.sentWeights()).toEqual([500, 600]);
    expect(shop.state.grams).toBe(600);
  });

  it("a newer weight saved during the read-back stops the older row before its mutation", async () => {
    const productId = await variant(700);
    const a = (await queueShopifyWeight(g.owner, productId, 700)).writeIds[0]!;
    let once = false;
    const shop = shopWith(100, applied, async () => {
      if (once) return;
      once = true;
      await setProductWeight(g.owner, productId, { grams: 710, writeToShopify: true });
    });
    expect(await processWeightWrite(a, shop.clients)).toBe("REFUSED");
    expect(shop.count("VariantWeightUpdate")).toBe(0);
  });

  it("back to an earlier weight: the re-armed older row is the latest intent and is sent", async () => {
    const productId = await variant(800);
    const a = (await queueShopifyWeight(g.owner, productId, 800)).writeIds[0]!;
    const shop = shopWith(100, applied);
    expect(await processWeightWrite(a, shop.clients)).toBe("SENT");
    await setProductWeight(g.owner, productId, { grams: 810, writeToShopify: true });
    const b = (await g.db.shopifyWeightWrite.findFirstOrThrow({ where: { productId, weightGrams: 810 } })).id;
    expect(await processWeightWrite(b, shop.clients)).toBe("SENT");
    await setProductWeight(g.owner, productId, { grams: 800, writeToShopify: true });
    expect(await processWeightWrite(a, shop.clients)).toBe("SENT");
    expect(shop.state.grams).toBe(800);
  });
});

describe("company scope: a restricted member works only on the masters of their lines", () => {
  it("setProductWeight / productWeightView / queueShopifyWeight / bulk fill stay inside the member's lines", async () => {
    const g = await euTestGroup("weight-scope");
    const otherCompany = await g.db.company.create({ data: { accountId: g.accountId, name: "Other Co" } });
    const mine = await g.db.productLine.create({ data: { accountId: g.accountId, name: "Mine" } });
    const theirs = await g.db.productLine.create({ data: { accountId: g.accountId, name: "Theirs" } });
    await g.db.company.update({ where: { id: g.company.id }, data: { lineId: mine.id } });
    await g.db.company.update({ where: { id: otherCompany.id }, data: { lineId: theirs.id } });
    const restricted: ScopedActor = { ...g.owner, role: "OPERATOR", companyScope: [g.company.id] };
    const mk = (lineId: string | null, sku: string) =>
      g.db.product.create({
        data: { accountId: g.accountId, sku: `${sku}-${Date.now()}`, name: sku, lineId },
      });
    const own = await mk(mine.id, "OWN");
    const foreign = await mk(theirs.id, "FOREIGN");
    const unassigned = await mk(null, "NOLINE");
    for (const p of [own, foreign, unassigned])
      await g.db.vendorProduct.create({
        data: {
          accountId: g.accountId,
          connectionId: g.connection.id,
          productId: p.id,
          vendorId: `v-${p.id}`,
          raw: { weight: 0.25 },
        },
      });

    await expect(setProductWeight(restricted, foreign.id, { grams: 300 })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(productWeightView(restricted, foreign.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(queueShopifyWeight(restricted, foreign.id, 300)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await g.db.product.findUniqueOrThrow({ where: { id: foreign.id } })).weightGrams).toBeNull();

    await setProductWeight(restricted, own.id, { grams: 300 });
    expect((await productWeightView(restricted, unassigned.id)).product.id).toBe(unassigned.id);

    const r = await fillWeightsFromWarehouse(restricted);
    expect(r.filled).toBe(1); // only the unassigned master was still empty in scope
    const read = (id: string) => g.db.product.findUniqueOrThrow({ where: { id } });
    expect((await read(unassigned.id)).weightGrams).toBe(250);
    expect((await read(foreign.id)).weightGrams).toBeNull();
    // An unscoped member still fills the whole group.
    expect((await fillWeightsFromWarehouse(g.owner)).filled).toBe(1);
    expect((await read(foreign.id)).weightGrams).toBe(250);
  });
});

describe("country rule: the calling code is fixed by the country", () => {
  it("CY with another calling code is refused; an unknown country keeps its own code", async () => {
    const g = await euTestGroup("cc-mismatch");
    for (const cc of ["30", "359"])
      await expect(
        saveCountrySetting(g.owner, { country: "CY", currency: "EUR", rule: { ...CY_RULE, cc } }),
      ).rejects.toMatchObject({ code: "calling_code_mismatch" });
    expect((await listCountries(g.owner)).find((c) => c.country === "CY")).toBeUndefined();
    await expect(
      saveCountrySetting(g.owner, { country: "CY", currency: "EUR", rule: CY_RULE }),
    ).resolves.toMatchObject({ rule: CY_RULE });
  });

  it("an open order whose address stores the country in lower case is re-checked too", async () => {
    const g = await cyGroup("cy-lower");
    const { order } = await cyOrder(g, { weightGrams: 400 });
    const addr = order.shippingAddress as Record<string, unknown>;
    await g.db.order.update({
      where: { id: order.id },
      data: { shippingAddress: { ...addr, countryCode: "cy" }, countryCode: null },
    });
    const r = await saveCountrySetting(g.owner, { country: "CY", currency: "EUR", rule: CY_RULE });
    expect(r.recheck.total).toBe(1);
  });
});
