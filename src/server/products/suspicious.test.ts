import { beforeAll, describe, expect, it } from "vitest";
import type { ShopifyClient } from "@/integrations/shopify/client";
import type { ShopifyVariant } from "@/integrations/shopify/products";
import { ForbiddenError } from "@/server/auth/rbac";
import { bootstrapOwner } from "@/server/auth/users";
import { orderLevelFindings, type CheckOrder, type OrderCheckContext } from "@/server/checks/order-checks";
import { validateOrder } from "@/server/checks/validate";
import { accountDb, systemDb } from "@/server/db/client";
import type { ScopedActor } from "@/server/lines/lines";
import { syncStoreProducts } from "@/server/shopify/products";
import { planInventoryPush } from "@/server/stock/push";
import { AGREEMENT_THRESHOLD, nameAgreement, wordWeights } from "./name-agreement";
import { listSuspiciousLinks, refreshSuspiciousLinks, suspiciousItemIds, ALL_LINKS } from "./suspicious";
import { confirmSuspiciousLink, unlinkSuspiciousLink } from "./suspicious-decisions";

// Synthetic data only: every product and brand name below is invented.

describe("name agreement (pure)", () => {
  const flags = (a: string, b: string, brand?: string) => nameAgreement(a, b, { brand }).flagged;

  it("the same perfume in different wording does NOT flag", () => {
    expect(
      flags("Maison Lumen Alpha Bloom Eau de Parfum 15 ml - Default Title", "Decant Alpha Bloom EDP 15ml"),
    ).toBe(false);
    expect(flags("Alpha Bloom EDP - 15ml", "Decant Alpha Bloom EDP 15 ml", "Maison Lumen")).toBe(false);
    expect(flags("Tester Alpha Bloom 7,5 ml", "Alpha Bloom 7.5ml")).toBe(false);
    // Cyrillic store title vs Latin warehouse name.
    expect(flags("Алфа Блум парфюмна вода 15 мл", "Decant Alpha Bloom EDP 15ml")).toBe(false);
    // A typo.
    expect(flags("Alpha Blom EDP 15ml", "Decant Alpha Bloom EDP 15ml")).toBe(false);
    expect(flags("Velvet Oud Intense - 10ml", "Decant Velvet Oud Intense EDP 10 ml")).toBe(false);
    expect(flags("Козметика 1 - Default Title", "Козметика 1")).toBe(false);
  });

  it("a different perfume behind the same SKU MUST flag", () => {
    const a = nameAgreement("Alpha Bloom EDP 15ml", "Decant Beta Noir EDP 15ml");
    expect(a.flagged).toBe(true);
    expect(a.reasons).toEqual(["name"]);
    expect(a.score!).toBeLessThan(AGREEMENT_THRESHOLD);
    expect(flags("Velvet Oud - 10ml", "Decant Rose Velvet EDP 10 ml")).toBe(true);
    // Same brand, other perfume: the brand is removed when known …
    expect(
      flags("Maison Lumen Beta Noir 15ml", "Decant Maison Lumen Alpha Bloom EDP 15ml", "Maison Lumen"),
    ).toBe(true);
    // … and still flagged when it is not (shared brand words alone are not agreement).
    expect(flags("Maison Lumen Beta Noir 15ml", "Decant Maison Lumen Alpha Bloom EDP 15ml")).toBe(true);
  });

  it("a different volume MUST flag, whatever the names", () => {
    const a = nameAgreement("Alpha Bloom EDP 15ml", "Alpha Bloom EDP 100ml");
    expect(a).toMatchObject({ flagged: true, reasons: ["volume"], volumes: { a: [15], b: [100] } });
    expect(flags("Alpha Bloom EDT 50ml", "Alpha Bloom EDP 50ml")).toBe(true);
  });

  it("no usable name (only the SKU, only Default Title) is no signal, never a flag", () => {
    expect(nameAgreement("SYN-1", "Synthetic name", { skus: ["SYN-1"] })).toMatchObject({
      score: null,
      flagged: false,
    });
    expect(nameAgreement("Default Title", "Alpha").score).toBeNull();
  });

  it("word weights: brand-like words shared by many masters count less", () => {
    const masters = [
      ...["Alpha Bloom", "Beta Noir", "Gamma Rose", "Delta Musk", "Sigma Iris"].map((n) => ({
        name: `Maison Lumen ${n} EDP`,
      })),
    ];
    const weight = wordWeights(masters);
    expect(weight("maison")).toBeLessThan(weight("alfa"));
    const r = nameAgreement("Maison Lumen Gamma Rose", "Maison Lumen Alpha Bloom", { weight });
    expect(r.flagged).toBe(true);
    expect(nameAgreement("Maison Lumen Alpha Bloom Limited", "Alpha Bloom", { weight }).flagged).toBe(false);
  });

  it("order check: a flagged line gets a SOFT, acknowledgeable finding, never a hard block", () => {
    const order: CheckOrder = {
      number: "T-1",
      customerName: "Тест Тестов",
      email: "t@example.com",
      phone: "+359888000000",
      shippingAddress: { name: "Т", address1: "ул. 1", city: "София", zip: "1000", countryCode: "BG" },
      countryCode: "BG",
      currency: "EUR",
      total: 10,
      paymentMethod: "PREPAID",
      codAmount: null,
      codLocalAmount: null,
      codLocalCurrency: null,
      tags: [],
      lines: [{ title: "Alpha Bloom", sku: "SYN-1", productId: "p1", quantity: 1, suspiciousLink: true }],
    };
    const ctx = {
      localCurrency: "EUR",
      routing: { connectionId: "c1" },
      stock: null,
      duplicates: [],
    } as unknown as OrderCheckContext;
    const f = orderLevelFindings(order, ctx).findings.filter((x) => x.code === "order.line_name_mismatch");
    expect(f).toEqual([expect.objectContaining({ severity: "soft", field: "lines[0].product" })]);
    expect(f[0]!.message_bg).toContain("Името в магазина и в склада се различават — проверете връзката");
    const clean = orderLevelFindings(
      { ...order, lines: [{ ...order.lines[0]!, suspiciousLink: false }] },
      ctx,
    );
    expect(clean.findings.some((x) => x.code === "order.line_name_mismatch")).toBe(false);
  });
});

// ───────────── database ─────────────

const LOC = "gid://shopify/Location/9001";

async function group(label: string) {
  const r = await bootstrapOwner({
    email: `sus-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    name: "O",
    accountName: `Suspicious ${label}`,
    password: "correct horse battery staple",
  });
  const accountId = r.account.id;
  const db = accountDb(accountId);
  const company = await systemDb().company.findFirstOrThrow({ where: { accountId } });
  const owner: ScopedActor = { userId: r.user.id, accountId, role: "OWNER", companyScope: null };
  const fhb = await db.fulfillmentConnection.create({
    data: { accountId, companyId: company.id, type: "FHB_V3", name: "FHB syn", liveMode: "LIVE" },
  });
  const store = await db.store.create({
    data: {
      accountId,
      companyId: company.id,
      domain: `sus-${label}-${Date.now()}.myshopify.com`,
      code: "SU",
      name: "Магазин syn",
      currency: "EUR",
      skuPrefix: "",
      connectionStatus: { ok: true },
    },
  });
  await db.storeLocation.create({
    data: {
      accountId,
      storeId: store.id,
      shopifyLocationGid: LOC,
      name: "Склад",
      connectionId: fhb.id,
      fetchedAt: new Date(),
    },
  });
  return { accountId, db, company, owner, fhb, store };
}
type G = Awaited<ReturnType<typeof group>>;

/** Master + FHB product (with stock) + store variant (with a Shopify level), all linked by the same SKU. */
async function linked(
  g: G,
  n: number,
  sku: string,
  names: { master: string; vendor: string; variant: string },
) {
  const product = await g.db.product.create({ data: { accountId: g.accountId, sku, name: names.master } });
  const vp = await g.db.vendorProduct.create({
    data: {
      accountId: g.accountId,
      connectionId: g.fhb.id,
      productId: product.id,
      vendorId: `SK${sku}`,
      raw: { name: names.vendor },
      stockLevel: {
        create: { physical: 9, free: 9, sellable: 9, snapshotAt: new Date(), source: "POLL" },
      },
    },
  });
  const variant = await g.db.storeVariantLink.create({
    data: {
      accountId: g.accountId,
      storeId: g.store.id,
      shopifyVariantGid: `gid://shopify/ProductVariant/${n}`,
      shopifyProductGid: `gid://shopify/Product/${n}`,
      sku,
      title: names.variant,
      productId: product.id,
      matchMethod: "sku",
    },
  });
  await g.db.shopifyInventoryLevel.create({
    data: {
      accountId: g.accountId,
      storeId: g.store.id,
      variantLinkId: variant.id,
      locationGid: LOC,
      inventoryItemGid: `gid://shopify/InventoryItem/${n}`,
      available: 1,
      fetchedAt: new Date(),
    },
  });
  return { product, vp, variant };
}

const shopifyVariant = (n: number, sku: string, displayName: string): ShopifyVariant => ({
  id: `gid://shopify/ProductVariant/${n}`,
  sku,
  title: "Default Title",
  displayName,
  updatedAt: new Date().toISOString(),
  barcodes: { nodes: [] },
  inventoryItem: null,
  product: { id: `gid://shopify/Product/${n}`, title: displayName, vendor: "syn", status: "ACTIVE" },
});
const fakeClient = (variants: ShopifyVariant[]) =>
  ({
    query: async () => ({
      productVariants: { nodes: variants, pageInfo: { hasNextPage: false, endCursor: null } },
    }),
  }) as unknown as ShopifyClient;

describe("suspicious links (database)", () => {
  let g: G;
  let good: Awaited<ReturnType<typeof linked>>;
  let bad: Awaited<ReturnType<typeof linked>>;
  let other: G;

  beforeAll(async () => {
    g = await group("main");
    other = await group("other");
    good = await linked(g, 1, "5900000000001", {
      master: "Decant Alpha Bloom EDP 15ml",
      vendor: "Decant Alpha Bloom EDP 15ml",
      variant: "Alpha Bloom Eau de Parfum 15 ml - Default Title",
    });
    // The owner's case: the SKU was reused — the store variant now names another perfume.
    bad = await linked(g, 2, "5900000000007", {
      master: "Decant Beta Noir EDP 15ml",
      vendor: "Decant Beta Noir EDP 15ml",
      variant: "Gamma Rose EDP 15ml - Default Title",
    });
    await refreshSuspiciousLinks(g.accountId, ALL_LINKS);
  });

  it("flags only the link whose names disagree, and lists it with both names", async () => {
    const list = await listSuspiciousLinks({ accountId: g.accountId, companyScope: null });
    expect(list.total).toBe(1);
    expect(list.rows[0]).toMatchObject({
      kind: "variant",
      itemId: bad.variant.id,
      productSku: "5900000000007",
      productName: "Decant Beta Noir EDP 15ml",
      itemName: "Gamma Rose EDP 15ml - Default Title",
      source: "Магазин syn",
      reasons: ["name"],
    });
    expect(list.rows[0]!.score!).toBeLessThan(AGREEMENT_THRESHOLD);
  });

  it("Shopify push: the flagged variant is skipped as suspicious_link, the good one is pushed", async () => {
    const plan = await planInventoryPush(g.accountId, g.store.id);
    expect(plan.lines.map((l) => l.variantLinkId)).toEqual([good.variant.id]);
    expect(plan.skipped.suspicious_link).toBe(1);
  });

  it("order check: a line on the flagged variant gets the soft finding (not hard)", async () => {
    const order = await g.db.order.create({
      data: {
        accountId: g.accountId,
        companyId: g.company.id,
        storeId: g.store.id,
        source: "MANUAL",
        number: `S-${Math.random().toString(36).slice(2, 7)}`,
        status: "NEEDS_REVIEW",
        currency: "EUR",
        subtotal: 1,
        total: 1,
        paymentMethod: "PREPAID",
        placedAt: new Date(),
        lines: {
          create: [
            {
              productId: bad.product.id,
              variantLinkId: bad.variant.id,
              sku: "5900000000007",
              title: "Gamma Rose",
              quantity: 1,
              unitPrice: 1,
            },
            {
              productId: good.product.id,
              variantLinkId: good.variant.id,
              sku: "5900000000001",
              title: "Alpha Bloom",
              quantity: 1,
              unitPrice: 1,
            },
          ],
        },
      },
    });
    const r = await validateOrder(g.accountId, order.id, { persist: false });
    const f = r.findings.filter((x) => x.code === "order.line_name_mismatch");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "soft" });
    expect(f[0]!.message_bg).toContain("5900000000007");
  });

  it("RBAC: WAREHOUSE and VIEWER may not confirm or unlink", async () => {
    const [row] = (await listSuspiciousLinks({ accountId: g.accountId, companyScope: null })).rows;
    for (const role of ["WAREHOUSE", "VIEWER"] as const) {
      await expect(confirmSuspiciousLink({ ...g.owner, role }, row!.id)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(unlinkSuspiciousLink({ ...g.owner, role }, row!.id)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
  });

  it("tenant and company scope: another account or another company's member sees nothing and cannot act", async () => {
    const [row] = (await listSuspiciousLinks({ accountId: g.accountId, companyScope: null })).rows;
    expect((await listSuspiciousLinks({ accountId: other.accountId, companyScope: null })).total).toBe(0);
    await expect(confirmSuspiciousLink(other.owner, row!.id)).rejects.toMatchObject({ code: "not_found" });
    expect(
      (await listSuspiciousLinks({ accountId: g.accountId, companyScope: ["no-such-company"] })).total,
    ).toBe(0);
    await expect(
      confirmSuspiciousLink({ ...g.owner, role: "OPERATOR", companyScope: ["no-such-company"] }, row!.id),
    ).rejects.toMatchObject({ code: "not_found" });
    // The other account's push and checks are unaffected by this account's flags.
    expect((await suspiciousItemIds(other.accountId, ALL_LINKS)).size).toBe(0);
  });

  it("confirm (OPERATOR): never flagged again while the names stay; pushed again; audited", async () => {
    const [row] = (await listSuspiciousLinks({ accountId: g.accountId, companyScope: null })).rows;
    await confirmSuspiciousLink({ ...g.owner, role: "OPERATOR" }, row!.id);
    await refreshSuspiciousLinks(g.accountId, ALL_LINKS);
    expect((await listSuspiciousLinks({ accountId: g.accountId, companyScope: null })).total).toBe(0);
    const plan = await planInventoryPush(g.accountId, g.store.id);
    expect(plan.skipped.suspicious_link).toBe(0);
    expect(plan.lines).toHaveLength(2);
    const audit = await g.db.auditLog.findMany({ where: { action: "product.suspicious_link_confirmed" } });
    expect(audit).toHaveLength(1);
  });

  it("a name change (Shopify product sync) voids the confirmation and flags again", async () => {
    await syncStoreProducts(
      g.accountId,
      { id: g.store.id, skuPrefix: "", lineId: null },
      fakeClient([
        shopifyVariant(1, "5900000000001", "Alpha Bloom Eau de Parfum 15 ml - Default Title"),
        shopifyVariant(2, "5900000000007", "Delta Musk EDP 15ml - Default Title"),
      ]),
    );
    const list = await listSuspiciousLinks({ accountId: g.accountId, companyScope: null });
    expect(list.rows.map((r) => r.itemName)).toEqual(["Delta Musk EDP 15ml - Default Title"]);
    expect((await planInventoryPush(g.accountId, g.store.id)).skipped.suspicious_link).toBe(1);
  });

  it("a renamed warehouse product (another volume) is flagged on the warehouse side too", async () => {
    await g.db.vendorProduct.update({
      where: { id: good.vp.id },
      data: { raw: { name: "Decant Alpha Bloom EDP 100ml" } },
    });
    await refreshSuspiciousLinks(g.accountId, { vendors: { connectionId: g.fhb.id } });
    const rows = (await listSuspiciousLinks({ accountId: g.accountId, companyScope: null })).rows;
    expect(rows.find((r) => r.kind === "vendor")).toMatchObject({
      itemId: good.vp.id,
      source: "FHB syn",
      reasons: ["volume"],
    });
    // The push of that product's variant uses the flagged warehouse product: skipped as well.
    expect((await planInventoryPush(g.accountId, g.store.id)).skipped.suspicious_link).toBe(2);
    await g.db.vendorProduct.update({
      where: { id: good.vp.id },
      data: { raw: { name: "Decant Alpha Bloom EDP 15ml" } },
    });
    await refreshSuspiciousLinks(g.accountId, { vendors: { connectionId: g.fhb.id } });
    expect(
      (await listSuspiciousLinks({ accountId: g.accountId, companyScope: null })).rows.some(
        (r) => r.kind === "vendor",
      ),
    ).toBe(false);
  });

  it("unlink: removes the link (audited), order lines lose the product, the next sync does not re-link by SKU", async () => {
    const [row] = (await listSuspiciousLinks({ accountId: g.accountId, companyScope: null })).rows;
    expect(row!.itemId).toBe(bad.variant.id);
    await unlinkSuspiciousLink({ ...g.owner, role: "ADMIN" }, row!.id);
    const v = await g.db.storeVariantLink.findUniqueOrThrow({ where: { id: bad.variant.id } });
    expect(v).toMatchObject({ productId: null, matchMethod: "unlinked" });
    const lines = await g.db.orderLine.findMany({ where: { variantLinkId: bad.variant.id } });
    expect(lines.every((l) => l.productId === null)).toBe(true);
    expect(
      await g.db.auditLog.count({
        where: { action: "product.suspicious_link_unlinked", entityId: bad.variant.id },
      }),
    ).toBe(1);
    await syncStoreProducts(
      g.accountId,
      { id: g.store.id, skuPrefix: "", lineId: null },
      fakeClient([shopifyVariant(2, "5900000000007", "Delta Musk EDP 15ml - Default Title")]),
    );
    expect(
      (await g.db.storeVariantLink.findUniqueOrThrow({ where: { id: bad.variant.id } })).productId,
    ).toBeNull();
    expect((await listSuspiciousLinks({ accountId: g.accountId, companyScope: null })).total).toBe(0);
    // A stale second click is refused, never applied twice.
    await expect(unlinkSuspiciousLink(g.owner, row!.id)).rejects.toMatchObject({ code: "not_found" });
  });
});
