"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { ForbiddenError, assertCan } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { createFhbConnection, rotateFhbCredentials } from "@/server/fhb/connection";
import { enqueueFhb } from "@/server/fhb/jobs";
import {
  getFhbConnection,
  linkFhbVendorProduct,
  setFhbConnectionMode,
  updateFhbConnectionSettings,
} from "@/server/fhb/mirror";
import { FHB_PERIODIC_RESOURCES, type FhbSyncResource } from "@/server/fhb/sync";
import { webBoss } from "@/server/jobs/boss";

/**
 * FHB connection and mirror actions. Nothing here calls FHB: settings change CRM rows, credentials go to the
 * vault, and refreshes are queued for the worker (read-only GET calls there).
 */

type Result = { ok?: boolean; error?: string } | undefined;

function toError(err: unknown): Result {
  if (err instanceof ForbiddenError) return { error: "forbidden" };
  if (err instanceof DomainError) return { error: err.code };
  if (err instanceof z.ZodError) return { error: "invalid" };
  throw err;
}

const str = (form: FormData, k: string) => String(form.get(k) ?? "").trim();

export async function createFhbConnectionAction(_prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  let id: string;
  try {
    const c = await createFhbConnection(actorFrom(ctx), {
      companyId: str(form, "companyId"),
      name: str(form, "name"),
      appId: str(form, "appId"),
      secret: str(form, "secret"),
      skuPrefix: str(form, "skuPrefix") || undefined,
    });
    id = c.id;
    // First read of everything (GET only; the connection is READ_ONLY for writes).
    await enqueueFhb.syncAll(await webBoss(), { accountId: ctx.accountId, connectionId: id, force: true });
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/warehouses");
  redirect(`/warehouses/fhb/${id}`);
}

export async function saveFhbSettingsAction(
  connectionId: string,
  _prev: Result,
  form: FormData,
): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await updateFhbConnectionSettings(actorFrom(ctx), connectionId, {
      name: str(form, "name"),
      skuPrefix: str(form, "skuPrefix"),
      enabled: form.get("enabled") === "on",
    });
  } catch (err) {
    return toError(err);
  }
  revalidatePath(`/warehouses/fhb/${connectionId}`);
  return { ok: true };
}

export async function rotateFhbCredentialsAction(
  connectionId: string,
  _prev: Result,
  form: FormData,
): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await getFhbConnection(actorFrom(ctx), connectionId);
    await rotateFhbCredentials(actorFrom(ctx), connectionId, {
      appId: str(form, "appId"),
      secret: str(form, "secret"),
    });
  } catch (err) {
    return toError(err);
  }
  revalidatePath(`/warehouses/fhb/${connectionId}`);
  return { ok: true };
}

const Mode = z.enum(["READ_ONLY", "DRY_RUN", "CANARY", "LIVE"]);

export async function setFhbModeAction(connectionId: string, _prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await setFhbConnectionMode(actorFrom(ctx), connectionId, Mode.parse(form.get("mode")));
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

const SyncInput = z.object({
  resource: z.string().refine((r) => r === "all" || (FHB_PERIODIC_RESOURCES as string[]).includes(r)),
});

/** "Обнови" buttons: queue a read refresh (GET calls only) for one resource or everything. */
export async function syncFhbAction(connectionId: string, _prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    assertCan(ctx.role, "connections.sync");
    await getFhbConnection(actorFrom(ctx), connectionId);
    const { resource } = SyncInput.parse({ resource: form.get("resource") });
    const boss = await webBoss();
    const data = { accountId: ctx.accountId, connectionId, force: true };
    if (resource === "all") await enqueueFhb.syncAll(boss, data);
    else await enqueueFhb.sync(boss, { ...data, resource: resource as FhbSyncResource });
  } catch (err) {
    return toError(err);
  }
  return { ok: true };
}

const PickupInput = z.object({
  service: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[A-Za-z0-9_.-]+$/),
  country: z
    .string()
    .trim()
    .regex(/^([A-Za-z]{2})?$/),
});

/** Load the pick-up points of one carrier (and country) into the mirror. */
export async function loadFhbPickupPointsAction(
  connectionId: string,
  _prev: Result,
  form: FormData,
): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    assertCan(ctx.role, "connections.sync");
    await getFhbConnection(actorFrom(ctx), connectionId);
    const { service, country } = PickupInput.parse({
      service: form.get("service"),
      country: form.get("country"),
    });
    await enqueueFhb.sync(await webBoss(), {
      accountId: ctx.accountId,
      connectionId,
      resource: "pickupPoints",
      service,
      country: country.toUpperCase() || undefined,
    });
  } catch (err) {
    return toError(err);
  }
  return { ok: true };
}

/** Re-read one order at FHB (GET /order?id=) through the worker. */
export async function refreshFhbOrderAction(connectionId: string, externalId: string) {
  const ctx = await requireAccountContext();
  try {
    assertCan(ctx.role, "connections.sync");
    await getFhbConnection(actorFrom(ctx), connectionId);
    await enqueueFhb.sync(await webBoss(), {
      accountId: ctx.accountId,
      connectionId,
      resource: "order",
      externalId: z.string().min(1).max(255).parse(externalId),
    });
  } catch (err) {
    toError(err);
  }
  revalidatePath(`/warehouses/fhb/${connectionId}`);
}

export async function linkFhbVendorProductAction(
  vendorProductId: string,
  _prev: Result,
  form: FormData,
): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await linkFhbVendorProduct(actorFrom(ctx), vendorProductId, str(form, "sku"));
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/products/stock");
  revalidatePath("/warehouses/fhb/[id]", "page");
  return { ok: true };
}
