"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { ForbiddenError, assertCan } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { webBoss } from "@/server/jobs/boss";
import { enqueueShopify } from "@/server/shopify/jobs";
import { webhookCallbackUrl } from "@/server/shopify/webhooks";
import { backfillWindows } from "@/server/shopify/orders";
import { createStore, getStore, replaceStoreCredentials, updateStoreSettings } from "@/server/stores";

type Result = { ok?: boolean; error?: string } | undefined;

function toError(err: unknown): Result {
  if (err instanceof ForbiddenError) return { error: "forbidden" };
  if (err instanceof DomainError) return { error: err.code };
  if (err instanceof z.ZodError) return { error: "invalid" };
  throw err;
}

const list = (v: FormDataEntryValue | null) =>
  String(v ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

export async function createStoreAction(_prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  let id: string;
  try {
    const store = await createStore(actorFrom(ctx), {
      companyId: String(form.get("companyId") ?? ""),
      name: String(form.get("name") ?? ""),
      domain: String(form.get("domain") ?? ""),
      code: String(form.get("code") ?? ""),
      currency: String(form.get("currency") ?? ""),
      countries: list(form.get("countries")),
      credentialId: String(form.get("credentialId") ?? "") || undefined,
      clientId: String(form.get("clientId") ?? "").trim() || undefined,
      clientSecret: String(form.get("clientSecret") ?? "").trim() || undefined,
    });
    id = store.id;
    await enqueueShopify.testConnection(await webBoss(), {
      accountId: ctx.accountId,
      storeId: id,
      callbackUrl: webhookCallbackUrl(),
    });
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/stores");
  redirect(`/stores/${id}`);
}

export async function saveStoreSettingsAction(
  storeId: string,
  _prev: Result,
  form: FormData,
): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await updateStoreSettings(actorFrom(ctx), storeId, {
      name: String(form.get("name") ?? ""),
      countries: list(form.get("countries")),
      codGateways: list(form.get("codGateways")),
      skuPrefix: String(form.get("skuPrefix") ?? ""),
      notifyCustomer: form.get("notifyCustomer") === "on",
      writeBackMode: String(form.get("writeBackMode")) as "READ_ONLY",
      inventoryPushMode: String(form.get("inventoryPushMode")) as "DISABLED",
      inventoryBuffer: Number(form.get("inventoryBuffer") ?? 0),
    });
  } catch (err) {
    return toError(err);
  }
  revalidatePath(`/stores/${storeId}`);
  return { ok: true };
}

export async function replaceStoreCredentialsAction(
  storeId: string,
  _prev: Result,
  form: FormData,
): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await replaceStoreCredentials(actorFrom(ctx), storeId, {
      clientId: String(form.get("clientId") ?? "").trim(),
      clientSecret: String(form.get("clientSecret") ?? "").trim(),
    });
    await enqueueShopify.testConnection(await webBoss(), {
      accountId: ctx.accountId,
      storeId,
      callbackUrl: webhookCallbackUrl(),
    });
  } catch (err) {
    return toError(err);
  }
  revalidatePath(`/stores/${storeId}`);
  return { ok: true };
}

type StoreJobKind = "test" | "orders" | "products" | "webhooks";

/** Queues a read-only Shopify job for one store (nothing here writes to Shopify except webhook subscriptions). */
export async function runStoreJobAction(storeId: string, kind: StoreJobKind) {
  const ctx = await requireAccountContext();
  try {
    assertCan(ctx.role, kind === "webhooks" ? "stores.manage" : "stores.sync");
    await getStore(actorFrom(ctx), storeId);
    const boss = await webBoss();
    const data = { accountId: ctx.accountId, storeId, callbackUrl: webhookCallbackUrl() };
    if (kind === "test") await enqueueShopify.testConnection(boss, data);
    else if (kind === "orders") await enqueueShopify.syncOrders(boss, { ...data, mode: "reconcile" });
    else if (kind === "products") await enqueueShopify.syncProducts(boss, data);
    else await enqueueShopify.registerWebhooks(boss, data);
  } catch (err) {
    toError(err);
  }
  revalidatePath(`/stores/${storeId}`);
}

export async function backfillOrdersAction(storeId: string, _prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    assertCan(ctx.role, "stores.manage");
    await getStore(actorFrom(ctx), storeId);
    const days = z.coerce.number().int().min(1).max(365).parse(form.get("days"));
    const boss = await webBoss();
    for (const w of backfillWindows(days)) {
      await enqueueShopify.syncOrders(boss, { accountId: ctx.accountId, storeId, mode: "backfill", ...w });
    }
    await recordAudit({
      accountId: ctx.accountId,
      userId: ctx.user.id,
      action: "store.backfill",
      entityType: "Store",
      entityId: storeId,
      after: { days },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  } catch (err) {
    return toError(err);
  }
  return { ok: true };
}
