import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";
import { queueProductsToWarehouse, TO_WAREHOUSE_MAX, TO_WAREHOUSE_TYPES } from "./to-warehouse";

/**
 * Products from an Excel file into a warehouse (owner request 2026-11-23): one row per product with exactly what that
 * warehouse requires, checked row by row before anything is written. Each row becomes a master product of the
 * warehouse's line (created, or the existing one with its empty fields filled) and is then created in the warehouse
 * through the existing writers — the outbox and the connection's live mode decide what is sent.
 *
 *   FHB (POST /product):           SKU*, Име*, EAN, Снимка (URL), HS код, Държава на произход
 *   euShipments (create-product):  SKU*, Име*, Баркод*, Тегло (г)*, Дължина (мм)*, Ширина (мм)*, Височина (мм)*, HS код
 *
 * Sizes are in the CRM's units (grams, millimetres); the euShipments writer converts them to kg / cm.
 */

export type ImportType = (typeof TO_WAREHOUSE_TYPES)[number];
export const IMPORT_MAX_ROWS = TO_WAREHOUSE_MAX;

type Field = "sku" | "name" | "ean" | "photo" | "hsCode" | "country" | "weight" | "length" | "width" | "height";
export interface ColumnSpec {
  field: Field;
  header: string;
  required: boolean;
}

export const IMPORT_COLUMNS: Record<ImportType, ColumnSpec[]> = {
  FHB_V3: [
    { field: "sku", header: "SKU", required: true },
    { field: "name", header: "Име", required: true },
    { field: "ean", header: "EAN", required: false },
    { field: "photo", header: "Снимка (URL)", required: false },
    { field: "hsCode", header: "HS код", required: false },
    { field: "country", header: "Държава на произход", required: false },
  ],
  EUSHIPMENTS: [
    { field: "sku", header: "SKU", required: true },
    { field: "name", header: "Име", required: true },
    { field: "ean", header: "Баркод (EAN)", required: true },
    { field: "weight", header: "Тегло (г)", required: true },
    { field: "length", header: "Дължина (мм)", required: true },
    { field: "width", header: "Ширина (мм)", required: true },
    { field: "height", header: "Височина (мм)", required: true },
    { field: "hsCode", header: "HS код", required: false },
  ],
};

/** Header aliases (lower case, spaces and punctuation dropped) → field. */
const ALIASES: Record<string, Field> = {
  sku: "sku",
  код: "sku",
  име: "name",
  name: "name",
  наименование: "name",
  ean: "ean",
  баркод: "ean",
  баркодean: "ean",
  barcode: "ean",
  снимка: "photo",
  снимкаurl: "photo",
  photo: "photo",
  image: "photo",
  hs: "hsCode",
  hsкод: "hsCode",
  hscode: "hsCode",
  държава: "country",
  държаванапроизход: "country",
  country: "country",
  countryoforigin: "country",
  теглог: "weight",
  тегло: "weight",
  weight: "weight",
  weightg: "weight",
  дължинамм: "length",
  дължина: "length",
  length: "length",
  lengthmm: "length",
  ширинамм: "width",
  ширина: "width",
  width: "width",
  widthmm: "width",
  височинамм: "height",
  височина: "height",
  height: "height",
  heightmm: "height",
};
const norm = (h: string) => h.toLowerCase().replace(/[\s()._\-*:/]+/g, "");

/** The template's first row (and nothing else: the rules are on the screen). */
export function importTemplate(type: ImportType): string[][] {
  return [IMPORT_COLUMNS[type].map((c) => c.header)];
}

export interface ImportRowValues {
  sku: string;
  name: string;
  ean: string | null;
  photo: string | null;
  hsCode: string | null;
  country: string | null;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
}

export interface ParsedImportRow {
  row: number;
  values: ImportRowValues;
  errors: string[];
}

const int = (v: string) => (/^\d+([.,]0+)?$/.test(v) ? Number.parseInt(v, 10) : Number.NaN);

/** Pure: the rows of a sheet, each checked against what the warehouse requires. */
export function parseImportTable(type: ImportType, table: string[][]) {
  const rows = table.map((r, i) => ({ r, i })).filter(({ r }) => r.some((c) => c.trim() !== ""));
  if (!rows.length) return { rows: [] as ParsedImportRow[], fileErrors: ["empty"] };
  const head = rows[0]!.r.map((h) => ALIASES[norm(h)] ?? null);
  const col = (f: Field) => head.indexOf(f);
  const missingCols = IMPORT_COLUMNS[type].filter((c) => c.required && col(c.field) < 0).map((c) => c.header);
  if (missingCols.length) return { rows: [] as ParsedImportRow[], fileErrors: ["missing_columns"], missingCols };
  const data = rows.slice(1);
  const fileErrors: string[] = [];
  if (data.length > IMPORT_MAX_ROWS) fileErrors.push("too_many_rows");
  const seen = new Map<string, number>();
  const out = data.slice(0, IMPORT_MAX_ROWS).map(({ r, i }): ParsedImportRow => {
    const get = (f: Field) => (col(f) >= 0 ? (r[col(f)] ?? "").trim() : "");
    const errors: string[] = [];
    const sku = get("sku");
    const name = get("name").replace(/\s+/g, " ");
    const ean = get("ean").replace(/\s/g, "") || null;
    const photo = get("photo") || null;
    const hsCode = get("hsCode").replace(/\s/g, "") || null;
    const country = get("country").toUpperCase() || null;
    const num = (f: Field): number | null => (get(f) ? int(get(f).replace(/\s/g, "")) : null);
    const weightGrams = num("weight");
    const lengthMm = num("length");
    const widthMm = num("width");
    const heightMm = num("height");
    if (!sku) errors.push("sku_missing");
    else if (sku.length > 60 || /[#&%\s]/.test(sku)) errors.push("sku_invalid");
    else {
      const key = sku.toUpperCase();
      if (seen.has(key)) errors.push("sku_duplicate");
      seen.set(key, i + 1);
    }
    if (!name) errors.push("name_missing");
    else if (name.length > (type === "FHB_V3" ? 150 : 200)) errors.push("name_too_long");
    if (ean && !/^\d{8,14}$/.test(ean)) errors.push("ean_invalid");
    if (photo && (!/^https:\/\/\S+$/.test(photo) || photo.length > 255)) errors.push("photo_invalid");
    if (hsCode && !/^\d{4,10}$/.test(hsCode)) errors.push("hs_invalid");
    if (country && !/^[A-Z]{2}$/.test(country)) errors.push("country_invalid");
    if (type === "EUSHIPMENTS") {
      if (!ean) errors.push("ean_missing");
      // euShipments: weight 0.01–999 kg, each side 0.1–999 cm.
      if (weightGrams === null) errors.push("weight_missing");
      else if (!(weightGrams >= 10 && weightGrams <= 999_000)) errors.push("weight_invalid");
      for (const [v, k] of [
        [lengthMm, "length"],
        [widthMm, "width"],
        [heightMm, "height"],
      ] as const) {
        if (v === null) errors.push(`${k}_missing`);
        else if (!(v >= 1 && v <= 9_990)) errors.push(`${k}_invalid`);
      }
    }
    return {
      row: i + 1,
      values: { sku, name, ean, photo, hsCode, country, weightGrams, lengthMm, widthMm, heightMm },
      errors,
    };
  });
  return { rows: out, fileErrors };
}

export type PlanAction = "create" | "update" | "already" | "error";
export interface PlannedRow extends ParsedImportRow {
  action: PlanAction;
  productId: string | null;
}

async function target(actor: ScopedActor, connectionId: string) {
  const conn = await accountDb(actor.accountId).fulfillmentConnection.findFirst({
    where: {
      id: connectionId,
      type: { in: [...TO_WAREHOUSE_TYPES] },
      enabled: true,
      ...(actor.companyScope ? { companyId: { in: actor.companyScope } } : {}),
    },
    select: { id: true, type: true, company: { select: { lineId: true } } },
  });
  if (!conn) throw new DomainError("not_found");
  return { id: conn.id, type: conn.type as ImportType, lineId: conn.company?.lineId ?? null };
}

/** What each row would do: a new product, an existing one (its empty fields filled), one the warehouse has already. */
export async function planImport(actor: ScopedActor, connectionId: string, parsed: ParsedImportRow[]) {
  assertCan(actor.role, "vendorProducts.write");
  const conn = await target(actor, connectionId);
  const db = accountDb(actor.accountId);
  const skus = parsed.filter((p) => p.values.sku).map((p) => p.values.sku);
  const masters = skus.length
    ? await db.product.findMany({
        where: { OR: skus.map((s) => ({ sku: { equals: s, mode: "insensitive" as const } })) },
        select: {
          id: true,
          sku: true,
          lineId: true,
          archived: true,
          vendorProducts: { where: { connectionId: conn.id, archived: false }, select: { id: true } },
        },
      })
    : [];
  const bySku = new Map<string, typeof masters>();
  for (const m of masters) bySku.set(m.sku.toUpperCase(), [...(bySku.get(m.sku.toUpperCase()) ?? []), m]);
  const rows: PlannedRow[] = parsed.map((p) => {
    if (p.errors.length) return { ...p, action: "error", productId: null };
    const found = (bySku.get(p.values.sku.toUpperCase()) ?? []).filter((m) => !m.archived);
    // A master of this line (or of no line yet); a SKU another line uses is for a person to sort out.
    const mine = found.filter((m) => m.lineId === conn.lineId || m.lineId === null);
    if (found.length && !mine.length) return { ...p, errors: ["sku_other_line"], action: "error", productId: null };
    if (mine.length > 1) return { ...p, errors: ["sku_ambiguous"], action: "error", productId: null };
    const m = mine[0];
    if (!m) return { ...p, action: "create", productId: null };
    if (m.vendorProducts.length) return { ...p, action: "already", productId: m.id };
    return { ...p, action: "update", productId: m.id };
  });
  return { connection: conn, rows };
}

const RowValues = z.object({
  sku: z.string().min(1).max(60),
  name: z.string().min(1).max(200),
  ean: z.string().max(50).nullable(),
  photo: z.string().max(255).nullable(),
  hsCode: z.string().max(10).nullable(),
  country: z.string().max(2).nullable(),
  weightGrams: z.number().int().nullable(),
  lengthMm: z.number().int().nullable(),
  widthMm: z.number().int().nullable(),
  heightMm: z.number().int().nullable(),
});
export const ApplyImportInput = z.object({
  connectionId: z.string().min(1).max(64),
  rows: z.array(z.object({ row: z.number().int(), values: RowValues })).min(1).max(IMPORT_MAX_ROWS),
});

/**
 * Creates / completes the master products and queues their create in the warehouse. The rows are checked again here
 * (never trusted from the browser); a row with a problem is reported and skipped, the others go on.
 */
export async function applyImport(actor: ScopedActor, raw: z.input<typeof ApplyImportInput>) {
  assertCan(actor.role, "vendorProducts.write");
  const input = ApplyImportInput.parse(raw);
  const conn = await target(actor, input.connectionId);
  // The same checks as the preview, on the values sent back.
  const recheck = parseImportTable(conn.type, [
    IMPORT_COLUMNS[conn.type].map((c) => c.header),
    ...input.rows.map((r) =>
      IMPORT_COLUMNS[conn.type].map((c) => {
        const v = r.values;
        const byField: Record<Field, string | number | null> = {
          sku: v.sku,
          name: v.name,
          ean: v.ean,
          photo: v.photo,
          hsCode: v.hsCode,
          country: v.country,
          weight: v.weightGrams,
          length: v.lengthMm,
          width: v.widthMm,
          height: v.heightMm,
        };
        return byField[c.field] === null ? "" : String(byField[c.field]);
      }),
    ),
  ]);
  const plan = await planImport(
    actor,
    conn.id,
    recheck.rows.map((r, i) => ({ ...r, row: input.rows[i]!.row })),
  );
  const result = { created: 0, updated: 0, already: 0, queued: 0, failed: [] as { row: number; code: string }[] };
  const toQueue: { row: number; productId: string }[] = [];
  for (const p of plan.rows) {
    if (p.action === "error") {
      for (const code of p.errors) result.failed.push({ row: p.row, code });
      continue;
    }
    if (p.action === "already") {
      result.already++;
      continue;
    }
    const v = p.values;
    const productId = await withAccountTransaction(actor.accountId, async (tx) => {
      if (p.action === "create") {
        const created = await tx.product.create({
          data: {
            accountId: actor.accountId,
            sku: v.sku,
            name: v.name,
            lineId: conn.lineId,
            weightGrams: v.weightGrams,
            weightSource: v.weightGrams ? "manual" : null,
            weightSetAt: v.weightGrams ? new Date() : null,
            weightSetById: v.weightGrams ? actor.userId : null,
            lengthMm: v.lengthMm,
            widthMm: v.widthMm,
            heightMm: v.heightMm,
            hsCode: v.hsCode,
            countryOfOrigin: v.country,
            images: v.photo ? [v.photo] : [],
          },
          select: { id: true },
        });
        if (v.ean)
          await tx.productEan.create({
            data: { accountId: actor.accountId, productId: created.id, ean: v.ean, source: "import" },
          });
        result.created++;
        return created.id;
      }
      // An existing master: only its empty fields are filled (what a person set is never overwritten).
      const m = await tx.product.findUniqueOrThrow({
        where: { id: p.productId! },
        select: {
          id: true,
          weightGrams: true,
          lengthMm: true,
          widthMm: true,
          heightMm: true,
          hsCode: true,
          countryOfOrigin: true,
          images: true,
          lineId: true,
          eans: { select: { ean: true } },
        },
      });
      await tx.product.update({
        where: { id: m.id },
        data: {
          ...(m.lineId === null && conn.lineId ? { lineId: conn.lineId } : {}),
          ...(m.weightGrams === null && v.weightGrams
            ? { weightGrams: v.weightGrams, weightSource: "manual", weightSetAt: new Date(), weightSetById: actor.userId }
            : {}),
          ...(m.lengthMm === null && v.lengthMm ? { lengthMm: v.lengthMm } : {}),
          ...(m.widthMm === null && v.widthMm ? { widthMm: v.widthMm } : {}),
          ...(m.heightMm === null && v.heightMm ? { heightMm: v.heightMm } : {}),
          ...(!m.hsCode && v.hsCode ? { hsCode: v.hsCode } : {}),
          ...(!m.countryOfOrigin && v.country ? { countryOfOrigin: v.country } : {}),
          ...(!m.images.length && v.photo ? { images: [v.photo] } : {}),
        },
      });
      if (v.ean && !m.eans.length)
        await tx.productEan.create({
          data: { accountId: actor.accountId, productId: m.id, ean: v.ean, source: "import" },
        });
      result.updated++;
      return m.id;
    });
    toQueue.push({ row: p.row, productId });
  }
  if (toQueue.length) {
    const q = await queueProductsToWarehouse(actor, {
      connectionId: conn.id,
      productIds: toQueue.map((x) => x.productId),
    });
    result.queued = q.queued;
    result.already += q.already;
    for (const f of q.failed)
      result.failed.push({ row: toQueue.find((x) => x.productId === f.productId)?.row ?? 0, code: f.code });
  }
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "products.import",
    entityType: "FulfillmentConnection",
    entityId: conn.id,
    after: { rows: input.rows.length, created: result.created, updated: result.updated, queued: result.queued },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return result;
}
