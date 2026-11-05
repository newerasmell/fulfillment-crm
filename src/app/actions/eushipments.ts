"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { LiveMode } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { ForbiddenError, assertCan } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import {
  createEuConnection,
  getEuConnection,
  linkEuVendorProduct,
  replaceEuToken,
  setEuConnectionMode,
  updateEuConnection,
} from "@/server/eushipments/connections";
import { setCountryCourier } from "@/server/eushipments/country-couriers";
import { enqueueEu, enqueueManualSync, MANUAL_SYNCS, type ManualSync } from "@/server/eushipments/jobs";
import { webBoss } from "@/server/jobs/boss";

/**
 * euShipments screens → services. Nothing here calls euShipments: syncs are queued for the worker (read calls
 * only) and every write goes through the outbox elsewhere. Errors come back as i18n keys (eushipments.errors.*).
 */
type Result = { ok?: boolean; error?: string } | undefined;

function toError(err: unknown): Result {
  if (err instanceof ForbiddenError) return { error: "forbidden" };
  if (err instanceof DomainError) return { error: err.code };
  if (err instanceof z.ZodError) return { error: "invalid" };
  throw err;
}

const str = (form: FormData, k: string) => String(form.get(k) ?? "").trim();
const optInt = (form: FormData, k: string) => (str(form, k) ? Number(str(form, k)) : undefined);
const base = (id: string) => `/warehouses/eushipments/${id}`;

export async function createEuConnectionAction(_prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  let id: string;
  try {
    const c = await createEuConnection(actorFrom(ctx), {
      companyId: str(form, "companyId"),
      name: str(form, "name"),
      token: str(form, "token") || undefined,
      credentialId: str(form, "credentialId") || undefined,
      vendorCompanyId: optInt(form, "vendorCompanyId"),
      skuPrefix: str(form, "skuPrefix"),
    });
    id = c.id;
    await enqueueEu.testConnection(await webBoss(), { accountId: ctx.accountId, connectionId: id });
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/warehouses");
  redirect(base(id));
}

export async function saveEuSettingsAction(id: string, _prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    const vendorCompanyId = optInt(form, "vendorCompanyId") ?? null;
    await updateEuConnection(actorFrom(ctx), id, {
      name: str(form, "name"),
      companyId: str(form, "companyId"),
      vendorCompanyId,
      skuPrefix: str(form, "skuPrefix"),
      acceptedAlertHours: Number(str(form, "acceptedAlertHours") || 24),
      acceptedAlertWorkDays: form.get("acceptedAlertWorkDays") === "on",
      stockStaleHours: Number(str(form, "stockStaleHours") || 30),
      cashReceiptCod: form.get("cashReceiptCod") === "on",
      canaryDailyCap: Number(str(form, "canaryDailyCap") || 10),
      enabled: form.get("enabled") === "on",
    });
    await enqueueEu.testConnection(await webBoss(), { accountId: ctx.accountId, connectionId: id });
  } catch (err) {
    return toError(err);
  }
  revalidatePath(base(id));
  return { ok: true };
}

export async function replaceEuTokenAction(id: string, _prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await replaceEuToken(actorFrom(ctx), id, str(form, "token"));
    await enqueueEu.testConnection(await webBoss(), { accountId: ctx.accountId, connectionId: id });
  } catch (err) {
    return toError(err);
  }
  revalidatePath(base(id));
  return { ok: true };
}

const Mode = z.enum(["READ_ONLY", "DRY_RUN", "CANARY", "LIVE"]);

export async function setEuModeAction(id: string, mode: LiveMode, _prev: Result): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await setEuConnectionMode(actorFrom(ctx), id, Mode.parse(mode));
  } catch (err) {
    return toError(err);
  }
  revalidatePath(base(id));
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Queues one read-only sync (or the connection test) for the worker. */
export async function runEuSyncAction(id: string, kind: ManualSync) {
  const ctx = await requireAccountContext();
  try {
    assertCan(ctx.role, "eushipments.sync");
    if (!MANUAL_SYNCS.includes(kind)) throw new DomainError("invalid");
    await getEuConnection(actorFrom(ctx), id);
    await enqueueManualSync(await webBoss(), kind, { accountId: ctx.accountId, connectionId: id });
  } catch (err) {
    toError(err);
  }
  revalidatePath(base(id));
}

export async function syncEuCitiesAction(id: string, _prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    assertCan(ctx.role, "eushipments.sync");
    await getEuConnection(actorFrom(ctx), id);
    const countryId = z.coerce.number().int().positive().parse(form.get("countryId"));
    await enqueueEu.syncCities(await webBoss(), { accountId: ctx.accountId, connectionId: id, countryId });
  } catch (err) {
    return toError(err);
  }
  return { ok: true };
}

export async function linkEuProductAction(
  connectionId: string,
  vendorProductId: string,
  _prev: Result,
  form: FormData,
): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await linkEuVendorProduct(actorFrom(ctx), { vendorProductId, sku: str(form, "sku") });
  } catch (err) {
    return toError(err);
  }
  revalidatePath(base(connectionId));
  return { ok: true };
}

/** Куриери → "Куриер по подразбиране" for one destination country (empty courier clears it). */
export async function saveCountryCourierAction(id: string, _prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await setCountryCourier(actorFrom(ctx), {
      connectionId: id,
      country: str(form, "country"),
      courierId: str(form, "courierId") ? Number(str(form, "courierId")) : null,
      serviceName: (str(form, "serviceName") || null) as never,
    });
  } catch (err) {
    return toError(err);
  }
  revalidatePath(base(id));
  return { ok: true };
}
