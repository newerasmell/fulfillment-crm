"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { SpreadsheetError, readTable } from "@/lib/xlsx";
import { DomainError } from "@/server/accounts";
import { assertCan, ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import {
  applyImport,
  parseImportTable,
  planImport,
  type ApplyImportInput,
  type PlannedRow,
} from "@/server/products/import";
import { accountDb } from "@/server/db/client";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

function toError(err: unknown): { error: string } {
  if (err instanceof ForbiddenError) return { error: "forbidden" };
  if (err instanceof DomainError) return { error: err.code };
  if (err instanceof SpreadsheetError) return { error: "bad_file" };
  if (err instanceof z.ZodError) return { error: "invalid" };
  throw err;
}

export type ImportPreview =
  | { ok: true; rows: PlannedRow[]; fileErrors: string[]; missingCols?: string[] }
  | { ok: false; error: string };

/** The file read and every row checked (nothing is written yet). */
export async function previewProductImportAction(
  connectionId: string,
  form: FormData,
): Promise<ImportPreview> {
  const ctx = await requireAccountContext();
  try {
    const actor = actorFrom(ctx);
    assertCan(actor.role, "vendorProducts.write");
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "no_file" };
    if (file.size > MAX_FILE_BYTES) return { ok: false, error: "file_too_large" };
    const conn = await accountDb(ctx.accountId).fulfillmentConnection.findFirst({
      where: {
        id: z.string().min(1).max(64).parse(connectionId),
        enabled: true,
        ...(actor.companyScope ? { companyId: { in: actor.companyScope } } : {}),
      },
      select: { type: true },
    });
    if (!conn || (conn.type !== "FHB_V3" && conn.type !== "EUSHIPMENTS"))
      return { ok: false, error: "not_found" };
    const parsed = parseImportTable(conn.type, readTable(Buffer.from(await file.arrayBuffer())));
    const plan = await planImport(actor, connectionId, parsed.rows);
    return { ok: true, rows: plan.rows, fileErrors: parsed.fileErrors, missingCols: parsed.missingCols };
  } catch (err) {
    const r = toError(err);
    return { ok: false, error: r.error };
  }
}

export type ImportResult =
  | {
      ok: true;
      created: number;
      updated: number;
      already: number;
      queued: number;
      failed: { row: number; code: string }[];
    }
  | { ok: false; error: string };

/** Creates / completes the products and queues them at the warehouse (the rows are checked again on the server). */
export async function applyProductImportAction(
  input: z.input<typeof ApplyImportInput>,
): Promise<ImportResult> {
  const ctx = await requireAccountContext();
  try {
    const r = await applyImport(actorFrom(ctx), input);
    revalidatePath("/products/to-warehouse");
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: toError(err).error };
  }
}
