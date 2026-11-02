"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { SpreadsheetError, readTable } from "@/lib/xlsx";
import { DomainError } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, COMPANY_COOKIE, LINE_COOKIE, requireAccountContext } from "@/server/auth/session";
import { webBoss } from "@/server/jobs/boss";
import { startMasterCatalogue } from "@/server/lines/catalogue";
import { enqueueCatalogueRun } from "@/server/lines/jobs";
import { createLine, setCompanyLine, setLineArchived, updateLine } from "@/server/lines/lines";
import { applyImport, MAX_FILE_BYTES, previewImport } from "@/server/lines/mapping";
import { confirmSuggestion, dismissSuggestion, linkItemToSku } from "@/server/lines/suggestions";

type Result = { ok?: boolean; error?: string } | undefined;

function toError(err: unknown): Result {
  if (err instanceof ForbiddenError) return { error: "forbidden" };
  if (err instanceof DomainError) return { error: err.code };
  if (err instanceof SpreadsheetError) return { error: "bad_file" };
  if (err instanceof z.ZodError) return { error: "invalid" };
  throw err;
}

const str = (form: FormData, key: string) => String(form.get(key) ?? "");

/** Sidebar filter: "all" (OWNER/ADMIN) or one of the lines this member may see. Resets the company filter. */
export async function setLineFilterAction(lineId: string) {
  const ctx = await requireAccountContext();
  const jar = await cookies();
  const seesAll = ctx.role === "OWNER" || ctx.role === "ADMIN";
  if ((lineId === "all" && seesAll) || !ctx.lines.some((l) => l.id === lineId)) jar.delete(LINE_COOKIE);
  else {
    jar.set(LINE_COOKIE, lineId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  jar.delete(COMPANY_COOKIE);
  revalidatePath("/", "layout");
}

const lineForm = (form: FormData) => ({
  name: str(form, "name"),
  color: str(form, "color"),
  sortOrder: str(form, "sortOrder") || 0,
});

export async function createLineAction(_prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await createLine(actorFrom(ctx), lineForm(form));
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function updateLineAction(lineId: string, _prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await updateLine(actorFrom(ctx), lineId, lineForm(form));
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function setLineArchivedAction(lineId: string, archived: boolean) {
  const ctx = await requireAccountContext();
  try {
    await setLineArchived(actorFrom(ctx), lineId, archived);
  } catch (err) {
    toError(err);
  }
  revalidatePath("/", "layout");
}

export async function setCompanyLineAction(
  companyId: string,
  _prev: Result,
  form: FormData,
): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    const lineId = str(form, "lineId");
    await setCompanyLine(actorFrom(ctx), companyId, lineId ? lineId : null);
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function startCatalogueAction(lineId: string, _prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    const boss = await webBoss();
    await startMasterCatalogue(actorFrom(ctx), { lineId, connectionId: str(form, "connectionId") }, (d) =>
      enqueueCatalogueRun(boss, d),
    );
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/products/lines");
  return { ok: true };
}

const Decision = z.object({
  lineId: z.string().min(1),
  kind: z.enum(["vendor", "variant"]),
  itemId: z.string().min(1),
});

const decisionOf = (form: FormData) =>
  Decision.parse({ lineId: str(form, "lineId"), kind: str(form, "kind"), itemId: str(form, "itemId") });

export async function confirmSuggestionAction(_prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await confirmSuggestion(actorFrom(ctx), { ...decisionOf(form), productId: str(form, "productId") });
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/products/lines");
  return { ok: true };
}

export async function dismissSuggestionAction(_prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await dismissSuggestion(actorFrom(ctx), { ...decisionOf(form), productId: str(form, "productId") });
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/products/lines");
  return { ok: true };
}

export async function linkOtherAction(_prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await linkItemToSku(actorFrom(ctx), {
      ...decisionOf(form),
      sku: str(form, "sku"),
      rejectedProductId: str(form, "rejectedProductId") || null,
    });
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/products/lines");
  return { ok: true };
}

/** Upload → validation → stored preview (nothing is linked yet); then the preview page. */
export async function previewImportAction(lineId: string, _prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  let id: string;
  try {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "no_file" };
    if (file.size > MAX_FILE_BYTES) return { error: "file_too_large" };
    const table = readTable(Buffer.from(await file.arrayBuffer()));
    id = (await previewImport(actorFrom(ctx), { lineId, fileName: file.name || "mapping" }, table)).id;
  } catch (err) {
    return toError(err);
  }
  redirect(`/products/lines/import/${id}`);
}

export async function applyImportAction(importId: string, _prev: Result, _form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await applyImport(actorFrom(ctx), importId);
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/products/lines");
  revalidatePath(`/products/lines/import/${importId}`);
  return { ok: true };
}
