import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { PRE_APPROVAL } from "@/server/shopify/statuses";
import { assertLineInScope, connectionPrefix, lineMembers, skuAfterPrefix, type ScopedActor } from "./lines";
import { refreshSuspiciousLinksSafe } from "@/server/products/suspicious";

/**
 * Match suggestions inside one line (P5-00). SKU after prefix (exact, case-insensitive) is the only key — those
 * are auto-linked by the catalogue tool. Barcode/EAN and name similarity are HINTS ONLY (warehouse "EAN" fields
 * are often internal codes): shown with a confidence score and Потвърди / Друго, never applied by themselves.
 * Suggestions never cross lines: candidates are masters of the item's line only.
 */

type Tx = Prisma.TransactionClient;
const RELINKABLE = [...PRE_APPROVAL];

export type ItemKind = "vendor" | "variant";

// ───────────── pure scoring ─────────────

/** Lower-case, accents and punctuation removed, spaces collapsed (Cyrillic kept). */
export function normaliseName(s: string) {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+-\s+default title$/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function bigrams(s: string) {
  const out = new Map<string, number>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Sørensen–Dice similarity of character bigrams, 0..1. */
export function nameSimilarity(a: string, b: string) {
  const x = normaliseName(a);
  const y = normaliseName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = bigrams(x);
  const B = bigrams(y);
  let inter = 0;
  let total = 0;
  for (const [g, n] of A) {
    inter += Math.min(n, B.get(g) ?? 0);
    total += n;
  }
  for (const n of B.values()) total += n;
  return total ? (2 * inter) / total : 0;
}

export interface MasterForMatch {
  id: string;
  sku: string;
  name: string;
  barcodes: string[];
}

export interface Candidate {
  productId: string;
  sku: string;
  name: string;
  /** 0..1 */
  score: number;
  reasons: { kind: "sku" | "barcode" | "name"; value?: number }[];
}

export const MIN_SCORE = 0.35;

/**
 * Ranked candidates for one item. SKU (after prefix) = 1.0 (the key); otherwise name similarity weighted 0.75 plus
 * 0.25 when a barcode matches — so a barcode alone can never reach "certain", it only lifts a similar name.
 */
export function rankCandidates(
  item: { sku: string | null; name: string; barcode: string | null },
  masters: MasterForMatch[],
  opts: { exclude?: Set<string>; limit?: number } = {},
): Candidate[] {
  const sku = item.sku?.toLowerCase() ?? null;
  const barcode = item.barcode?.trim() || null;
  const out: Candidate[] = [];
  for (const m of masters) {
    if (opts.exclude?.has(m.id)) continue;
    if (sku && m.sku.toLowerCase() === sku) {
      out.push({ productId: m.id, sku: m.sku, name: m.name, score: 1, reasons: [{ kind: "sku" }] });
      continue;
    }
    const sim = nameSimilarity(item.name, m.name);
    const bc = !!barcode && m.barcodes.includes(barcode);
    const score = Math.min(0.95, 0.75 * sim + (bc ? 0.25 : 0));
    if (score < MIN_SCORE) continue;
    const reasons: Candidate["reasons"] = [];
    if (bc) reasons.push({ kind: "barcode" });
    if (sim > 0) reasons.push({ kind: "name", value: Math.round(sim * 100) / 100 });
    out.push({ productId: m.id, sku: m.sku, name: m.name, score: Math.round(score * 100) / 100, reasons });
  }
  return out.sort((a, b) => b.score - a.score || a.sku.localeCompare(b.sku)).slice(0, opts.limit ?? 3);
}

// ───────────── listing ─────────────

export interface SuggestionItem {
  kind: ItemKind;
  id: string;
  /** Connection or store name. */
  source: string;
  sourceType: "FHB_V3" | "EUSHIPMENTS" | "STORE";
  code: string;
  name: string;
  barcode: string | null;
  candidates: Candidate[];
}

/** Masters of the line with every barcode we know for them (hints only). */
async function lineMasters(accountId: string, lineId: string): Promise<MasterForMatch[]> {
  const db = accountDb(accountId);
  const products = await db.product.findMany({
    where: { lineId, archived: false },
    select: {
      id: true,
      sku: true,
      name: true,
      eans: { select: { ean: true } },
      vendorProducts: { select: { vendorEan: true } },
      variantLinks: { select: { barcode: true } },
    },
    orderBy: { sku: "asc" },
  });
  return products.map((p) => ({
    id: p.id,
    sku: p.sku,
    name: p.name,
    barcodes: [
      ...new Set(
        [
          ...p.eans.map((e) => e.ean),
          ...p.vendorProducts.map((v) => v.vendorEan),
          ...p.variantLinks.map((v) => v.barcode),
        ].filter((b): b is string => !!b && !!b.trim()),
      ),
    ],
  }));
}

export const SUGGESTIONS_PAGE = 50;

/** Unlinked items of the line (warehouse products, store variants) with their candidates, one page at a time. */
export async function listSuggestions(actor: ScopedActor, lineId: string, page = 1) {
  await assertLineInScope(actor, lineId);
  const db = accountDb(actor.accountId);
  const members = await lineMembers(actor.accountId, lineId, actor.companyScope);
  const connIds = members.connections.map((c) => c.id);
  const storeIds = members.stores.map((s) => s.id);
  const vpWhere = { connectionId: { in: connIds }, archived: false, productId: null };
  const vlWhere = { storeId: { in: storeIds }, productId: null };
  const [vpCount, vlCount] = await Promise.all([
    db.vendorProduct.count({ where: vpWhere }),
    db.storeVariantLink.count({ where: vlWhere }),
  ]);
  const total = vpCount + vlCount;
  const skip = (Math.max(1, page) - 1) * SUGGESTIONS_PAGE;
  const vps =
    skip < vpCount
      ? await db.vendorProduct.findMany({
          where: vpWhere,
          select: { id: true, connectionId: true, vendorId: true, vendorEan: true, raw: true },
          orderBy: [{ connectionId: "asc" }, { vendorId: "asc" }],
          skip,
          take: SUGGESTIONS_PAGE,
        })
      : [];
  const vlTake = SUGGESTIONS_PAGE - vps.length;
  const vls =
    vlTake > 0
      ? await db.storeVariantLink.findMany({
          where: vlWhere,
          select: { id: true, storeId: true, sku: true, barcode: true, title: true },
          orderBy: [{ storeId: "asc" }, { title: "asc" }],
          skip: Math.max(0, skip - vpCount),
          take: vlTake,
        })
      : [];
  const masters = await lineMasters(actor.accountId, lineId);
  const itemIds = [...vps.map((v) => v.id), ...vls.map((v) => v.id)];
  const dismissed = itemIds.length
    ? await db.productMatchDismissal.findMany({ where: { lineId, itemId: { in: itemIds } } })
    : [];
  const excludeOf = (kind: ItemKind, id: string) =>
    new Set(dismissed.filter((d) => d.kind === kind && d.itemId === id).map((d) => d.productId));
  const connOf = new Map(members.connections.map((c) => [c.id, c]));
  const storeOf = new Map(members.stores.map((s) => [s.id, s]));
  const items: SuggestionItem[] = [];
  for (const v of vps) {
    const c = connOf.get(v.connectionId)!;
    const name = (v.raw as { name?: unknown } | null)?.name;
    const display = typeof name === "string" && name.trim() ? name.trim() : v.vendorId;
    items.push({
      kind: "vendor",
      id: v.id,
      source: c.name,
      sourceType: c.type as "FHB_V3" | "EUSHIPMENTS",
      code: v.vendorId,
      name: display,
      barcode: v.vendorEan,
      candidates: rankCandidates(
        {
          sku: skuAfterPrefix(v.vendorId, connectionPrefix(c.skuPrefixRule)),
          name: display,
          barcode: v.vendorEan,
        },
        masters,
        { exclude: excludeOf("vendor", v.id) },
      ),
    });
  }
  for (const v of vls) {
    const s = storeOf.get(v.storeId)!;
    items.push({
      kind: "variant",
      id: v.id,
      source: s.name,
      sourceType: "STORE",
      code: v.sku ?? "—",
      name: v.title,
      barcode: v.barcode,
      candidates: rankCandidates(
        { sku: skuAfterPrefix(v.sku, s.skuPrefix), name: v.title, barcode: v.barcode },
        masters,
        { exclude: excludeOf("variant", v.id) },
      ),
    });
  }
  return { items, total, page: Math.max(1, page), pages: Math.max(1, Math.ceil(total / SUGGESTIONS_PAGE)) };
}

// ───────────── decisions ─────────────

export const DecisionInput = z.object({
  lineId: z.string().min(1).max(64),
  kind: z.enum(["vendor", "variant"]),
  itemId: z.string().min(1).max(64),
});

/** The item, checked to belong to the line (its connection's / store's company is in the line and in scope). */
async function lineItem(tx: Tx, actor: ScopedActor, lineId: string, kind: ItemKind, itemId: string) {
  const companyId =
    kind === "vendor"
      ? (
          await tx.vendorProduct.findUnique({
            where: { id: itemId },
            select: { connection: { select: { companyId: true, company: { select: { lineId: true } } } } },
          })
        )?.connection
      : (
          await tx.storeVariantLink.findUnique({
            where: { id: itemId },
            select: { store: { select: { companyId: true, company: { select: { lineId: true } } } } },
          })
        )?.store;
  if (!companyId || companyId.company?.lineId !== lineId) throw new DomainError("not_found");
  if (actor.companyScope && !actor.companyScope.includes(companyId.companyId ?? "")) {
    throw new DomainError("not_found");
  }
}

/**
 * Links an item to a master of the same line. `expectUnlinked`: a suggestion confirmed on a stale page must not
 * silently replace a link someone made meanwhile.
 */
export async function linkItemInTx(
  tx: Tx,
  kind: ItemKind,
  itemId: string,
  productId: string,
  opts: { expectProductId?: string | null; method: string },
) {
  if (kind === "vendor") {
    const res = await tx.vendorProduct.updateMany({
      where: {
        id: itemId,
        ...(opts.expectProductId !== undefined ? { productId: opts.expectProductId } : {}),
      },
      // A person's link (suggestion, manual, import) clears an earlier "unlinked by person".
      data: { productId, unlinkedAt: null },
    });
    return res.count === 1;
  }
  const res = await tx.storeVariantLink.updateMany({
    where: { id: itemId, ...(opts.expectProductId !== undefined ? { productId: opts.expectProductId } : {}) },
    data: { productId, matchMethod: opts.method, matchedAt: new Date() },
  });
  if (res.count !== 1) return false;
  // A person's decision re-points the lines of orders not sent anywhere yet (same as the matching queue).
  await tx.orderLine.updateMany({
    where: { variantLinkId: itemId, order: { status: { in: RELINKABLE } } },
    data: { productId },
  });
  return true;
}

async function masterInLine(tx: Tx, lineId: string, where: Prisma.ProductWhereInput) {
  const products = await tx.product.findMany({
    where: { ...where, lineId, archived: false },
    select: { id: true, sku: true },
    take: 2,
  });
  if (products.length !== 1) throw new DomainError("product_not_found");
  return products[0]!;
}

async function auditDecision(
  actor: ScopedActor,
  action: string,
  input: z.infer<typeof DecisionInput>,
  after: object,
) {
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action,
    entityType: input.kind === "vendor" ? "VendorProduct" : "StoreVariantLink",
    entityId: input.itemId,
    after: { lineId: input.lineId, ...after },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}

/** "Потвърди": link the item to the suggested master (both in the line; item still unlinked). */
export async function confirmSuggestion(
  actor: ScopedActor,
  raw: z.input<typeof DecisionInput> & { productId: string },
) {
  assertCan(actor.role, "products.match");
  const input = DecisionInput.parse(raw);
  const productId = z.string().min(1).max(64).parse(raw.productId);
  await assertLineInScope(actor, input.lineId);
  const product = await withAccountTransaction(actor.accountId, async (tx) => {
    await lineItem(tx, actor, input.lineId, input.kind, input.itemId);
    const p = await masterInLine(tx, input.lineId, { id: productId });
    if (
      !(await linkItemInTx(tx, input.kind, input.itemId, p.id, {
        expectProductId: null,
        method: "suggestion",
      }))
    )
      throw new DomainError("already_linked");
    return p;
  });
  await auditDecision(actor, "product.match_confirmed", input, { productId: product.id, sku: product.sku });
  await refreshSuspiciousLinksSafe(
    actor.accountId,
    input.kind === "vendor" ? { vendors: { id: input.itemId } } : { variants: { id: input.itemId } },
    "suggestion",
  );
}

/** "Друго" with a SKU: link to another master of the line, and hide the rejected suggestion. */
export async function linkItemToSku(
  actor: ScopedActor,
  raw: z.input<typeof DecisionInput> & { sku: string; rejectedProductId?: string | null },
) {
  assertCan(actor.role, "products.match");
  const input = DecisionInput.parse(raw);
  const sku = z.string().trim().min(1).max(100).parse(raw.sku);
  await assertLineInScope(actor, input.lineId);
  const product = await withAccountTransaction(actor.accountId, async (tx) => {
    await lineItem(tx, actor, input.lineId, input.kind, input.itemId);
    const p = await masterInLine(tx, input.lineId, { sku: { equals: sku, mode: "insensitive" } });
    if (
      !(await linkItemInTx(tx, input.kind, input.itemId, p.id, { expectProductId: null, method: "manual" }))
    )
      throw new DomainError("already_linked");
    if (raw.rejectedProductId && raw.rejectedProductId !== p.id) {
      await dismissInTx(tx, actor, input, raw.rejectedProductId);
    }
    return p;
  });
  await auditDecision(actor, "product.match_other", input, { productId: product.id, sku: product.sku });
  await refreshSuspiciousLinksSafe(
    actor.accountId,
    input.kind === "vendor" ? { vendors: { id: input.itemId } } : { variants: { id: input.itemId } },
    "suggestion",
  );
}

async function dismissInTx(
  tx: Tx,
  actor: ScopedActor,
  input: z.infer<typeof DecisionInput>,
  productId: string,
) {
  await tx.productMatchDismissal.upsert({
    where: {
      accountId_kind_itemId_productId: {
        accountId: actor.accountId,
        kind: input.kind,
        itemId: input.itemId,
        productId,
      },
    },
    create: {
      accountId: actor.accountId,
      lineId: input.lineId,
      kind: input.kind,
      itemId: input.itemId,
      productId,
      createdById: actor.userId,
    },
    update: {},
  });
}

/** "Друго" without a SKU: this suggestion is wrong — never show it again for this item. */
export async function dismissSuggestion(
  actor: ScopedActor,
  raw: z.input<typeof DecisionInput> & { productId: string },
) {
  assertCan(actor.role, "products.match");
  const input = DecisionInput.parse(raw);
  const productId = z.string().min(1).max(64).parse(raw.productId);
  await assertLineInScope(actor, input.lineId);
  await withAccountTransaction(actor.accountId, async (tx) => {
    await lineItem(tx, actor, input.lineId, input.kind, input.itemId);
    await dismissInTx(tx, actor, input, productId);
  });
  await auditDecision(actor, "product.match_dismissed", input, { productId });
}
