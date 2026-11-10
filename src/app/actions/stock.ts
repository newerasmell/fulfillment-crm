"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { SpreadsheetError, readTable } from "@/lib/xlsx";
import { DomainError } from "@/server/accounts";
import { assertCan, ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { FhbPreflightError } from "@/server/fhb/orders";
import { webBoss } from "@/server/jobs/boss";
import {
  createInbound,
  MAX_INBOUND_FILE_BYTES,
  parseInboundTable,
  pickProducts,
  resolveInboundLines,
  type ResolvedLine,
} from "@/server/stock/inbound";
import { createInventoryActivation } from "@/server/stock/activate";
import { saveLineGuard } from "@/server/stock/guard";
import { enqueueStock } from "@/server/stock/jobs";
import { createInventoryPush } from "@/server/stock/push";
import { updateStockSettings } from "@/server/stock/settings";
import { setLocationConnection } from "@/server/stock/shopify-inventory";
import { getStore } from "@/server/stores";

/**
 * Stock track actions (P5-01..P5-03). Nothing here calls a vendor or Shopify: inbound creation goes through the
 * vendor services into the outbox, Shopify reads and pushes are queued for the worker (the push mode is
 * evaluated by the sender at send time).
 */

type Result = { ok?: boolean; error?: string; detail?: string } | undefined;

function toError(err: unknown): Result {
  if (err instanceof ForbiddenError) return { error: "forbidden" };
  if (err instanceof FhbPreflightError)
    return { error: "preflight", detail: err.findings.map((f) => f.message_bg).join(" · ") };
  if (err instanceof DomainError) return { error: err.code };
  if (err instanceof SpreadsheetError) return { error: "bad_file" };
  if (err instanceof z.ZodError) return { error: "invalid" };
  throw err;
}

const str = (form: FormData, k: string) => String(form.get(k) ?? "").trim();

async function stockCtx() {
  const ctx = await requireAccountContext();
  return { ...ctx, ...actorFrom(ctx) };
}

export async function saveStockSettingsAction(_prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await updateStockSettings(actorFrom(ctx), {
      shopifyThreshold: str(form, "shopifyThreshold"),
      fhbStaleHours: str(form, "fhbStaleHours"),
      euStaleHours: str(form, "euStaleHours"),
      runOutDays: str(form, "runOutDays"),
    });
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/products/stock");
  return { ok: true };
}

// ───────────── inbound ─────────────

export async function searchInboundProductsAction(connectionId: string, q: string) {
  const ctx = await stockCtx();
  try {
    const rows = await pickProducts(
      ctx,
      z.string().min(1).max(64).parse(connectionId),
      String(q).slice(0, 100),
    );
    return rows.map((r) => ({
      id: r.id,
      sku: r.sku,
      name: r.name,
      vendorId: r.vendorProducts[0]?.vendorId ?? null,
    }));
  } catch (err) {
    if (err instanceof DomainError || err instanceof z.ZodError) return [];
    throw err;
  }
}

export type UploadResult =
  | { ok: true; lines: ResolvedLine[]; errors: { row: number; code: string; value?: string }[] }
  | { ok: false; error: string };

/** Upload → parsed and matched lines for the form to show (nothing is created yet). */
export async function parseInboundUploadAction(connectionId: string, form: FormData): Promise<UploadResult> {
  const ctx = await stockCtx();
  try {
    assertCan(ctx.role, "inbound.manage");
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "no_file" };
    if (file.size > MAX_INBOUND_FILE_BYTES) return { ok: false, error: "file_too_large" };
    const parsed = parseInboundTable(readTable(Buffer.from(await file.arrayBuffer())));
    const lines = await resolveInboundLines(ctx, connectionId, parsed.lines);
    return { ok: true, lines, errors: parsed.errors };
  } catch (err) {
    const r = toError(err);
    return { ok: false, error: r?.error ?? "invalid" };
  }
}

const LinesJson = z
  .string()
  .max(200_000)
  .transform((s, c) => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      c.addIssue({ code: "custom", message: "invalid_lines" });
      return z.NEVER;
    }
  })
  .pipe(z.array(z.object({ productId: z.string(), quantity: z.coerce.number().int() })));

export async function createInboundAction(_prev: Result, form: FormData): Promise<Result> {
  const ctx = await stockCtx();
  let id: string;
  try {
    const opt = (k: string) => str(form, k) || undefined;
    const r = await createInbound(ctx, {
      connectionId: str(form, "connectionId"),
      requestToken: str(form, "requestToken"),
      name: str(form, "name"),
      expectedDate: opt("expectedDate"),
      trackingCode: opt("trackingCode"),
      deliveryService: opt("deliveryService"),
      warehouseId: opt("warehouseId") as unknown as number | undefined,
      courierInc: opt("courierInc"),
      packagesCount: opt("packagesCount") as unknown as number | undefined,
      lines: LinesJson.parse(str(form, "lines")),
    });
    id = r.inboundId;
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/inbound");
  redirect(`/inbound/${id}`);
}

// ───────────── Shopify inventory ─────────────

export async function mapLocationAction(storeId: string, _prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await setLocationConnection(actorFrom(ctx), {
      storeId,
      locationId: str(form, "locationId"),
      connectionId: str(form, "connectionId") || null,
    });
  } catch (err) {
    return toError(err);
  }
  revalidatePath(`/stores/${storeId}/inventory`);
  return { ok: true };
}

/** Queues a read of the store's Shopify locations and inventory (read calls only). */
export async function readShopifyInventoryAction(
  storeId: string,
  _prev: Result,
  _form: FormData,
): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    assertCan(ctx.role, "inventory.push");
    const store = await getStore(actorFrom(ctx), storeId);
    await enqueueStock.shopifyInventory(await webBoss(), { accountId: ctx.accountId, storeId: store.id });
  } catch (err) {
    return toError(err);
  }
  return { ok: true };
}

/** Queues a push now (the store's push mode decides at send time: DRY_RUN records, LIVE sends). */
export async function pushInventoryNowAction(
  storeId: string,
  _prev: Result,
  _form: FormData,
): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    const r = await createInventoryPush(storeId, { kind: "user", actor: actorFrom(ctx) });
    if (!r.pushId) return { error: r.reason ?? "nothing_to_push" };
    await enqueueStock.push(await webBoss(), { accountId: ctx.accountId, pushId: r.pushId });
    if (!r.created) return { error: "push_open" };
  } catch (err) {
    return toError(err);
  }
  revalidatePath(`/stores/${storeId}/inventory`);
  return { ok: true };
}

/**
 * "Активирай продуктите в тази локация" (OWNER): queues inventoryActivate for the confirmed count of items. The
 * store's push mode decides at send time (DRY_RUN records the requests, LIVE sends).
 */
export async function activateLocationAction(
  storeId: string,
  _prev: Result,
  form: FormData,
): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    const expected = Number(str(form, "expected"));
    const r = await createInventoryActivation(actorFrom(ctx), {
      storeId,
      locationId: str(form, "locationId"),
      expected: Number.isInteger(expected) && expected >= 0 ? expected : undefined,
    });
    if (!r.activationId) return { error: r.reason ?? "nothing_to_activate" };
    await enqueueStock.activate(await webBoss(), { accountId: ctx.accountId, activationId: r.activationId });
    if (!r.created) return { error: "activation_open" };
  } catch (err) {
    return toError(err);
  }
  revalidatePath(`/stores/${storeId}/inventory`);
  return { ok: true };
}

/** "Синхронизация на наличности": a product line's anti-sabotage rule. */
export async function saveLineGuardAction(input: {
  lineId: string;
  enabled: boolean;
  maxPerProduct: string;
  maxPerOrder: string;
}): Promise<{ ok: true } | { error: string }> {
  const ctx = await requireAccountContext();
  try {
    await saveLineGuard(actorFrom(ctx), input);
    revalidatePath("/settings/stock-sync");
    return { ok: true };
  } catch (err) {
    if (err instanceof z.ZodError) return { error: String(err.issues[0]?.message ?? "invalid") };
    if (err instanceof ForbiddenError) return { error: "forbidden" };
    if (err instanceof DomainError) return { error: err.code };
    throw err;
  }
}
