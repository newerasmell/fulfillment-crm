import { beforeAll, describe, expect, it, vi } from "vitest";
import { ShopifyClient, type ShopifyClientOptions } from "@/integrations/shopify/client";
import {
  customPhoneRule,
  effectivePhoneRule,
  normalisePhone,
  PHONE_RULES,
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
import { processWeightWrite, sweepWeightWrites } from "./shopify-weight";
import { fillWeightsFromWarehouse, queueShopifyWeight, setProductWeight, weightSuggestions } from "./weights";

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

function fakeShopify(routes: Record<string, (vars: Record<string, unknown>) => unknown>) {
  const ops: { op: string; vars: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/admin/oauth/access_token"))
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 86399 }), { status: 200 });
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const op = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "?";
    ops.push({ op, vars: body.variables });
    const h = routes[op];
    if (!h) throw new Error(`unexpected operation ${op}`);
    return new Response(JSON.stringify({ data: h(body.variables) }), { status: 200 });
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

describe("phone rules (pure): built-in euShipments rules always win", () => {
  it("a custom rule fills a country without a built-in rule only", () => {
    expect(normalisePhone("+357 99 123456", "CY")).toMatchObject({ ok: false, reason: "no_rule" });
    expect(normalisePhone("+357 99 123456", "CY", CY_RULE)).toMatchObject({
      ok: true,
      value: "+35799123456",
    });
    expect(normalisePhone("99 123456", "CY", CY_RULE)).toMatchObject({ ok: true, value: "+35799123456" });
    expect(normalisePhone("99 1234", "CY", CY_RULE)).toMatchObject({ ok: false, reason: "wrong_length" });
    // BG keeps the guideline's national format even when a (wrong) custom rule is passed.
    const bogus = { style: "international" as const, cc: "359", trunk: "", lengths: [5] };
    expect(normalisePhone("0888 123 456", "BG", bogus)).toMatchObject({ ok: true, value: "0888123456" });
    expect(effectivePhoneRule("BG", bogus)).toEqual({ rule: PHONE_RULES.BG, source: "builtin" });
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

  it("only OWNER/ADMIN; built-in countries refused; a new country needs its currency", async () => {
    await expect(
      saveCountrySetting(as(g, "OPERATOR"), { country: "CY", currency: "EUR", rule: CY_RULE }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      saveCountrySetting(g.owner, { country: "BG", currency: "EUR", rule: CY_RULE }),
    ).rejects.toMatchObject({ code: "builtin_phone_rule" });
    await expect(saveCountrySetting(g.owner, { country: "CY", rule: CY_RULE })).rejects.toMatchObject({
      code: "currency_required",
    });
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
    const q = await queueShopifyWeight(g.owner, productId, 500);
    expect(await processWeightWrite(q.writeIds[0]!, shop.clients)).toBe("FAILED");
    expect(
      await g.db.alert.findFirst({ where: { kind: "shopify_weight_failed", entityId: productId } }),
    ).not.toBeNull();

    const q2 = await queueShopifyWeight(g.owner, productId, 510);
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
