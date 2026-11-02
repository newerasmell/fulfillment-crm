import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { assertLineInScope, lineMembers, lockLine, type LineMembers, type ScopedActor } from "./lines";
import { linkItemInTx, type ItemKind } from "./suggestions";

/**
 * Excel/CSV export and import of a line's product mapping (P5-00). Columns: master SKU, name, then one column per
 * warehouse connection and one per store of the line. A header names its column with the id in brackets
 * ("Склад · FHB [id]"), so renaming a connection does not break an old file. Cells hold the warehouse product
 * ids / store variant SKUs linked to that master, comma-separated; a variant without a unique SKU is written as
 * its Shopify gid. Unlinked items are exported as rows with an empty master SKU, so they can be filled in.
 *
 * Import validates the whole file first (nothing is written while there is any error), stores the plan and shows
 * a preview; a person applies it. Only links are added or moved (an empty cell removes nothing). A row with a
 * new SKU and a name creates the master in the line. Applying re-checks that nothing changed meanwhile and is
 * audited; it runs in small transactions.
 */

type Tx = Prisma.TransactionClient;

export const MAX_ROWS = 5000;
/** Server actions accept 1 MB bodies (Next.js default); a line of 800+ products is ~150 KB as .xlsx or .csv. */
export const MAX_FILE_BYTES = 900 * 1024;
const APPLY_BATCH = 100;

export const HEADER_SKU = "SKU (основен продукт)";
export const HEADER_NAME = "Име";
const WAREHOUSE_LABEL = "Склад";
const STORE_LABEL = "Магазин";

const splitTokens = (cell: string) =>
  cell
    .split(/[,;\n]/)
    .map((t) => t.trim())
    .filter(Boolean);

interface Column {
  kind: ItemKind;
  /** connection or store id */
  id: string;
  name: string;
}

function columnsOf(m: LineMembers): Column[] {
  return [
    ...m.connections.map((c) => ({ kind: "vendor" as const, id: c.id, name: c.name })),
    ...m.stores.map((s) => ({ kind: "variant" as const, id: s.id, name: s.name })),
  ];
}

const headerOf = (c: Column) =>
  `${c.kind === "vendor" ? WAREHOUSE_LABEL : STORE_LABEL} · ${c.name} [${c.id}]`;

/** Variant tokens: the SKU when it is unique in its store, otherwise the Shopify gid. */
function variantToken(v: { sku: string | null; shopifyVariantGid: string }, skuCount: Map<string, number>) {
  const s = v.sku?.trim();
  return s && (skuCount.get(s.toLowerCase()) ?? 0) === 1 ? s : v.shopifyVariantGid;
}

/** The table of the export (first row = header). */
export async function exportMapping(
  actor: ScopedActor,
  lineId: string,
): Promise<{ name: string; rows: string[][] }> {
  assertCan(actor.role, "lines.catalogue");
  const line = await assertLineInScope(actor, lineId);
  const db = accountDb(actor.accountId);
  const m = await lineMembers(actor.accountId, lineId);
  const cols = columnsOf(m);
  const [masters, vps, vls] = await Promise.all([
    db.product.findMany({
      where: { lineId, archived: false },
      select: { id: true, sku: true, name: true },
      orderBy: { sku: "asc" },
    }),
    db.vendorProduct.findMany({
      where: { connectionId: { in: m.connections.map((c) => c.id) }, archived: false },
      select: { connectionId: true, vendorId: true, productId: true, raw: true },
      orderBy: { vendorId: "asc" },
    }),
    db.storeVariantLink.findMany({
      where: { storeId: { in: m.stores.map((s) => s.id) } },
      select: { storeId: true, sku: true, shopifyVariantGid: true, productId: true, title: true },
      orderBy: { title: "asc" },
    }),
  ]);
  const skuCounts = new Map<string, Map<string, number>>();
  for (const v of vls) {
    const s = v.sku?.trim().toLowerCase();
    if (!s) continue;
    const per = skuCounts.get(v.storeId) ?? new Map<string, number>();
    per.set(s, (per.get(s) ?? 0) + 1);
    skuCounts.set(v.storeId, per);
  }
  const colIdx = new Map(cols.map((c, i) => [`${c.kind}:${c.id}`, i]));
  const cells = new Map<string, string[][]>(masters.map((p) => [p.id, cols.map(() => [])]));
  const unlinked: string[][] = [];
  const nameOf = (raw: unknown, fallback: string) => {
    const n = (raw as { name?: unknown } | null)?.name;
    return typeof n === "string" && n.trim() ? n.trim() : fallback;
  };
  for (const v of vps) {
    const i = colIdx.get(`vendor:${v.connectionId}`)!;
    const target = v.productId ? cells.get(v.productId) : undefined;
    if (target) target[i]!.push(v.vendorId);
    else if (!v.productId) {
      const row = ["", nameOf(v.raw, v.vendorId), ...cols.map(() => "")];
      row[2 + i] = v.vendorId;
      unlinked.push(row);
    }
  }
  for (const v of vls) {
    const i = colIdx.get(`variant:${v.storeId}`)!;
    const token = variantToken(v, skuCounts.get(v.storeId) ?? new Map());
    const target = v.productId ? cells.get(v.productId) : undefined;
    if (target) target[i]!.push(token);
    else if (!v.productId) {
      const row = ["", v.title, ...cols.map(() => "")];
      row[2 + i] = token;
      unlinked.push(row);
    }
  }
  const rows = [
    [HEADER_SKU, HEADER_NAME, ...cols.map(headerOf)],
    ...masters.map((p) => [p.sku, p.name, ...cells.get(p.id)!.map((t) => t.join(", "))]),
    ...unlinked,
  ];
  return { name: line.name, rows };
}

// ───────────── import ─────────────

export interface ImportError {
  row: number;
  column?: string;
  code: string;
  value?: string;
}

export interface PlanLink {
  kind: ItemKind;
  itemId: string;
  token: string;
  column: string;
  /** Current link (null = unlinked); apply refuses when it changed meanwhile. */
  fromProductId: string | null;
  fromSku: string | null;
  toSku: string;
}

export interface ImportPlan {
  creates: { sku: string; name: string }[];
  adopts: { productId: string; sku: string }[];
  links: PlanLink[];
  unchanged: number;
  rows: number;
}

/** Validates a parsed table against the line (no writes). Pure apart from reads. */
export async function planImport(
  accountId: string,
  lineId: string,
  table: string[][],
): Promise<{ plan: ImportPlan; errors: ImportError[] }> {
  const db = accountDb(accountId);
  const m = await lineMembers(accountId, lineId);
  const cols = columnsOf(m);
  const errors: ImportError[] = [];
  const plan: ImportPlan = { creates: [], adopts: [], links: [], unchanged: 0, rows: 0 };
  const rows = table.filter((r, i) => i === 0 || r.some((c) => c.trim()));
  if (rows.length === 0) return { plan, errors: [{ row: 1, code: "empty_file" }] };
  if (rows.length - 1 > MAX_ROWS) return { plan, errors: [{ row: MAX_ROWS + 2, code: "too_many_rows" }] };

  // Header: column 1 = SKU, 2 = name, then "[id]" columns of the line's connections and stores.
  const header = rows[0]!.map((h) => h.trim());
  const colOf: (Column | null)[] = [];
  const seenCols = new Set<string>();
  header.forEach((h, i) => {
    if (i < 2) return void colOf.push(null);
    if (!h) return void colOf.push(null);
    const id = /\[([^\]]+)\]\s*$/.exec(h)?.[1];
    const c = id ? cols.find((x) => x.id === id) : undefined;
    if (!c) {
      errors.push({ row: 1, column: h, code: "unknown_column" });
      return void colOf.push(null);
    }
    if (seenCols.has(c.id)) errors.push({ row: 1, column: h, code: "duplicate_column" });
    seenCols.add(c.id);
    colOf.push(c);
  });

  // Everything the file may name, loaded once.
  const [products, vps, vls] = await Promise.all([
    db.product.findMany({ select: { id: true, sku: true, name: true, lineId: true, archived: true } }),
    db.vendorProduct.findMany({
      where: { connectionId: { in: m.connections.map((c) => c.id) }, archived: false },
      select: { id: true, connectionId: true, vendorId: true, productId: true },
    }),
    db.storeVariantLink.findMany({
      where: { storeId: { in: m.stores.map((s) => s.id) } },
      select: { id: true, storeId: true, sku: true, shopifyVariantGid: true, productId: true },
    }),
  ]);
  const productsByLower = new Map<string, typeof products>();
  for (const p of products)
    productsByLower.set(p.sku.toLowerCase(), [...(productsByLower.get(p.sku.toLowerCase()) ?? []), p]);
  const skuOfProduct = new Map(products.map((p) => [p.id, p.sku]));

  const vpIndex = new Map<string, Map<string, typeof vps>>();
  for (const v of vps) {
    const per = vpIndex.get(v.connectionId) ?? new Map<string, typeof vps>();
    const k = v.vendorId.toLowerCase();
    per.set(k, [...(per.get(k) ?? []), v]);
    vpIndex.set(v.connectionId, per);
  }
  const vlBySku = new Map<string, Map<string, typeof vls>>();
  const vlByGid = new Map<string, (typeof vls)[number]>();
  for (const v of vls) {
    vlByGid.set(v.shopifyVariantGid, v);
    const s = v.sku?.trim().toLowerCase();
    if (!s) continue;
    const per = vlBySku.get(v.storeId) ?? new Map<string, typeof vls>();
    per.set(s, [...(per.get(s) ?? []), v]);
    vlBySku.set(v.storeId, per);
  }
  const resolve = (
    c: Column,
    token: string,
  ): { id: string; productId: string | null } | "missing" | "ambiguous" => {
    if (c.kind === "vendor") {
      const list = vpIndex.get(c.id)?.get(token.toLowerCase()) ?? [];
      const exact = list.filter((v) => v.vendorId === token);
      const hit = exact.length === 1 ? exact : list;
      return hit.length === 1 ? hit[0]! : hit.length ? "ambiguous" : "missing";
    }
    const gid = /^\d+$/.test(token) ? `gid://shopify/ProductVariant/${token}` : token;
    const byGid = vlByGid.get(gid);
    if (byGid) return byGid.storeId === c.id ? byGid : "missing";
    const list = vlBySku.get(c.id)?.get(token.toLowerCase()) ?? [];
    return list.length === 1 ? list[0]! : list.length ? "ambiguous" : "missing";
  };

  const seenSku = new Map<string, number>();
  const seenItem = new Map<string, number>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const rowNo = r + 1;
    const sku = (row[0] ?? "").trim();
    const name = (row[1] ?? "").trim();
    if (!sku) continue; // unlinked items exported for reference: nothing to do
    plan.rows++;
    if (sku.length > 100) {
      errors.push({ row: rowNo, column: HEADER_SKU, code: "sku_too_long", value: sku.slice(0, 40) });
      continue;
    }
    const dup = seenSku.get(sku.toLowerCase());
    if (dup) {
      errors.push({ row: rowNo, column: HEADER_SKU, code: "duplicate_sku", value: sku });
      continue;
    }
    seenSku.set(sku.toLowerCase(), rowNo);
    const all = productsByLower.get(sku.toLowerCase()) ?? [];
    const inLine = all.filter((p) => p.lineId === lineId && !p.archived);
    let toSku = sku;
    if (inLine.length === 1) toSku = inLine[0]!.sku;
    else if (inLine.length > 1) {
      errors.push({ row: rowNo, column: HEADER_SKU, code: "ambiguous_sku", value: sku });
      continue;
    } else if (all.length === 1 && all[0]!.lineId === null && !all[0]!.archived) {
      plan.adopts.push({ productId: all[0]!.id, sku: all[0]!.sku });
      toSku = all[0]!.sku;
    } else if (all.length > 0) {
      errors.push({ row: rowNo, column: HEADER_SKU, code: "sku_in_other_line", value: sku });
      continue;
    } else if (!name) {
      errors.push({ row: rowNo, column: HEADER_NAME, code: "name_required", value: sku });
      continue;
    } else plan.creates.push({ sku, name: name.slice(0, 300) });
    const targetId = (inLine[0] ?? (all.length === 1 ? all[0] : undefined))?.id ?? null;

    for (let ci = 2; ci < row.length; ci++) {
      const c = colOf[ci];
      const cell = row[ci] ?? "";
      if (!cell.trim()) continue;
      if (!c) {
        if (ci >= header.length || !header[ci])
          errors.push({ row: rowNo, code: "value_without_column", value: cell.slice(0, 40) });
        continue;
      }
      for (const token of splitTokens(cell)) {
        const item = resolve(c, token);
        if (item === "missing" || item === "ambiguous") {
          errors.push({
            row: rowNo,
            column: headerOf(c),
            code: item === "missing" ? "item_not_found" : "item_ambiguous",
            value: token,
          });
          continue;
        }
        const key = `${c.kind}:${item.id}`;
        const prev = seenItem.get(key);
        if (prev) {
          errors.push({ row: rowNo, column: headerOf(c), code: "item_twice", value: token });
          continue;
        }
        seenItem.set(key, rowNo);
        if (targetId && item.productId === targetId) {
          plan.unchanged++;
          continue;
        }
        plan.links.push({
          kind: c.kind,
          itemId: item.id,
          token,
          column: c.name,
          fromProductId: item.productId,
          fromSku: item.productId ? (skuOfProduct.get(item.productId) ?? null) : null,
          toSku,
        });
      }
    }
  }
  return { plan, errors };
}

export const ImportFile = z.object({
  lineId: z.string().min(1).max(64),
  fileName: z.string().trim().min(1).max(200),
});

/** Validates the uploaded table and stores the plan (PREVIEW) or the errors (INVALID). Writes no links. */
export async function previewImport(actor: ScopedActor, raw: z.input<typeof ImportFile>, table: string[][]) {
  assertCan(actor.role, "lines.catalogue");
  const input = ImportFile.parse(raw);
  await assertLineInScope(actor, input.lineId);
  const { plan, errors } = await planImport(actor.accountId, input.lineId, table);
  return accountDb(actor.accountId).productMappingImport.create({
    data: {
      accountId: actor.accountId,
      lineId: input.lineId,
      fileName: input.fileName,
      status: errors.length ? "INVALID" : "PREVIEW",
      plan: plan as unknown as Prisma.InputJsonValue,
      errors: errors.slice(0, 500) as unknown as Prisma.InputJsonValue,
      createdById: actor.userId,
    },
  });
}

export async function getImport(actor: ScopedActor, importId: string) {
  const imp = await accountDb(actor.accountId).productMappingImport.findUnique({ where: { id: importId } });
  if (!imp) throw new DomainError("not_found");
  await assertLineInScope(actor, imp.lineId);
  return { ...imp, plan: imp.plan as unknown as ImportPlan, errors: imp.errors as unknown as ImportError[] };
}

/** Applies a previewed plan. Refuses (and writes nothing) when any link changed since the preview. */
export async function applyImport(actor: ScopedActor, importId: string) {
  assertCan(actor.role, "lines.catalogue");
  const imp = await getImport(actor, importId);
  if (imp.status !== "PREVIEW") throw new DomainError("import_not_ready");
  const { plan, lineId } = imp;
  const db = accountDb(actor.accountId);
  // Stale check first: every link's current state must still be what the preview showed.
  const vendorIds = plan.links.filter((l) => l.kind === "vendor").map((l) => l.itemId);
  const variantIds = plan.links.filter((l) => l.kind === "variant").map((l) => l.itemId);
  const [vpNow, vlNow] = await Promise.all([
    db.vendorProduct.findMany({ where: { id: { in: vendorIds } }, select: { id: true, productId: true } }),
    db.storeVariantLink.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, productId: true },
    }),
  ]);
  const now = new Map([...vpNow, ...vlNow].map((r) => [r.id, r.productId]));
  if (plan.links.some((l) => !now.has(l.itemId) || now.get(l.itemId) !== l.fromProductId)) {
    throw new DomainError("import_stale");
  }
  const claimed = await db.productMappingImport.updateMany({
    where: { id: importId, status: "PREVIEW" },
    data: { status: "APPLYING" },
  });
  if (claimed.count !== 1) throw new DomainError("import_not_ready");

  try {
    // Masters first (create / adopt), then the links in batches.
    for (let i = 0; i < Math.max(plan.creates.length, plan.adopts.length); i += APPLY_BATCH) {
      await withAccountTransaction(actor.accountId, async (tx, helpers) => {
        await lockLine(helpers, lineId);
        for (const c of plan.creates.slice(i, i + APPLY_BATCH)) {
          const exists = await tx.product.findFirst({
            where: { sku: { equals: c.sku, mode: "insensitive" } },
          });
          if (exists && exists.lineId !== lineId) throw new DomainError("import_stale");
          if (!exists)
            await tx.product.create({
              data: { accountId: actor.accountId, sku: c.sku, name: c.name, lineId },
            });
        }
        for (const a of plan.adopts.slice(i, i + APPLY_BATCH)) {
          const res = await tx.product.updateMany({
            where: { id: a.productId, lineId: null },
            data: { lineId },
          });
          if (!res.count) {
            const p = await tx.product.findUnique({ where: { id: a.productId }, select: { lineId: true } });
            if (p?.lineId !== lineId) throw new DomainError("import_stale");
          }
        }
      });
    }
    const skus = [...new Set(plan.links.map((l) => l.toSku))];
    const targets = skus.length
      ? await db.product.findMany({ where: { lineId, sku: { in: skus } }, select: { id: true, sku: true } })
      : [];
    const idOf = new Map(targets.map((t) => [t.sku, t.id]));
    let applied = 0;
    for (let i = 0; i < plan.links.length; i += APPLY_BATCH) {
      applied += await withAccountTransaction(actor.accountId, async (tx: Tx) => {
        let n = 0;
        for (const l of plan.links.slice(i, i + APPLY_BATCH)) {
          const productId = idOf.get(l.toSku);
          if (!productId) throw new DomainError("import_stale");
          if (
            !(await linkItemInTx(tx, l.kind, l.itemId, productId, {
              expectProductId: l.fromProductId,
              method: "import",
            }))
          )
            throw new DomainError("import_stale");
          n++;
        }
        return n;
      });
    }
    await db.productMappingImport.update({
      where: { id: importId },
      data: { status: "APPLIED", appliedAt: new Date() },
    });
    await recordAudit({
      accountId: actor.accountId,
      userId: actor.userId,
      action: "line.mapping_imported",
      entityType: "ProductMappingImport",
      entityId: importId,
      after: {
        lineId,
        fileName: imp.fileName,
        created: plan.creates.length,
        adopted: plan.adopts.length,
        linked: plan.links.filter((l) => !l.fromProductId).length,
        moved: plan.links.filter((l) => l.fromProductId).length,
        applied,
      },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return { applied };
  } catch (err) {
    // Batches already committed stay (each is consistent); the import is marked so it is not applied twice.
    await db.productMappingImport
      .update({ where: { id: importId }, data: { status: "FAILED" } })
      .catch(() => undefined);
    throw err;
  }
}
