"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { ForbiddenError, assertCan } from "@/server/auth/rbac";
import { setStoreOrderTag } from "@/server/shopify/order-tag";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { webBoss } from "@/server/jobs/boss";
import { enqueueShopify } from "@/server/shopify/jobs";
import { webhookCallbackUrl } from "@/server/shopify/webhooks";
import { backfillWindows } from "@/server/shopify/orders";
import { createStore, getStore, replaceStoreCredentials, updateStoreSettings } from "@/server/stores";
import { archiveStore, deleteStore, restoreStore, updateStoreDetails } from "@/server/store-lifecycle";

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

const NEW_STORE_FIELDS = [
  "companyId",
  "name",
  "domain",
  "code",
  "currency",
  "countries",
  "clientId",
  "clientSecret",
];

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
    // Which field is wrong (owner report 2026-11-06: only "Проверете полетата" was shown).
    if (err instanceof z.ZodError) {
      const field = String(err.issues[0]?.path[0] ?? "");
      return { error: NEW_STORE_FIELDS.includes(field) ? `field.${field}` : "invalid" };
    }
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
      codGateways: list(form.get("codGateways")),
      skuPrefix: String(form.get("skuPrefix") ?? ""),
      notifyCustomer: form.get("notifyCustomer") === "on",
      ...(form.get("fulfilTrigger")
        ? { fulfilTrigger: String(form.get("fulfilTrigger")) as "ON_TRACKING" }
        : {}),
      writeBackMode: String(form.get("writeBackMode")) as "READ_ONLY",
      inventoryPushMode: String(form.get("inventoryPushMode")) as "DISABLED",
      ...(form.get("weightWriteMode")
        ? { weightWriteMode: String(form.get("weightWriteMode")) as "DISABLED" }
        : {}),
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

/** "Данни на магазина": name, company, currency, countries, domain, code (locks in store-lifecycle.ts). */
export async function saveStoreDetailsAction(
  storeId: string,
  _prev: Result,
  form: FormData,
): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    const r = await updateStoreDetails(actorFrom(ctx), storeId, {
      name: String(form.get("name") ?? ""),
      companyId: String(form.get("companyId") ?? ""),
      currency: String(form.get("currency") ?? ""),
      countries: list(form.get("countries")),
      domain: String(form.get("domain") ?? ""),
      code: String(form.get("code") ?? ""),
      vendorIdPrefix: String(form.get("vendorIdPrefix") ?? ""),
    });
    // A different shop: test it again; a good test re-registers the webhooks and starts the first imports.
    if (r.domainChanged) {
      await enqueueShopify.testConnection(await webBoss(), {
        accountId: ctx.accountId,
        storeId,
        callbackUrl: webhookCallbackUrl(),
      });
    }
    // The previous shop keeps posting to us until our subscriptions there are removed.
    if (r.oldShopWebhooks) {
      await enqueueShopify.removeWebhooks(await webBoss(), {
        accountId: ctx.accountId,
        storeId,
        callbackUrl: webhookCallbackUrl(),
        oldDomain: r.oldShopWebhooks,
        userId: ctx.user.id,
      });
    }
  } catch (err) {
    return toError(err);
  }
  revalidatePath(`/stores/${storeId}`);
  revalidatePath("/stores");
  return { ok: true };
}

/** "Архивирай магазина" (OWNER): stops every job, then a job removes the store's Shopify webhooks. */
export async function archiveStoreAction(storeId: string, _prev: Result, _form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    const r = await archiveStore(actorFrom(ctx), storeId);
    if (r.archived) {
      // Coalesced per store with a later delete's job: the job reads deleteRequested from the store itself.
      await enqueueShopify.removeWebhooks(await webBoss(), {
        accountId: ctx.accountId,
        storeId,
        callbackUrl: webhookCallbackUrl(),
        userId: ctx.user.id,
      });
    }
  } catch (err) {
    return toError(err);
  }
  revalidatePath(`/stores/${storeId}`);
  revalidatePath("/stores");
  return { ok: true };
}

/** "Възстанови" (OWNER): the connection test runs again and, when good, re-registers the webhooks. */
export async function restoreStoreAction(storeId: string, _prev: Result, _form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    const r = await restoreStore(actorFrom(ctx), storeId);
    if (r.restored) {
      await enqueueShopify.testConnection(await webBoss(), {
        accountId: ctx.accountId,
        storeId,
        callbackUrl: webhookCallbackUrl(),
      });
    }
  } catch (err) {
    return toError(err);
  }
  revalidatePath(`/stores/${storeId}`);
  revalidatePath("/stores");
  return { ok: true };
}

/** "Изтрий магазина" (OWNER, empty stores only, confirmed by typing the code). */
export async function deleteStoreAction(
  storeId: string,
  _prev: (Result & { pending?: boolean }) | undefined,
  form: FormData,
): Promise<Result & { pending?: boolean }> {
  const ctx = await requireAccountContext();
  try {
    const r = await deleteStore(actorFrom(ctx), storeId, {
      confirmCode: String(form.get("confirmCode") ?? ""),
      force: form.get("force") === "on",
    });
    if (r.pending) {
      // Webhooks first: the worker removes them, then deletes the store.
      await enqueueShopify.removeWebhooks(await webBoss(), {
        accountId: ctx.accountId,
        storeId,
        callbackUrl: webhookCallbackUrl(),
        userId: ctx.user.id,
      });
      revalidatePath(`/stores/${storeId}`);
      return { ok: true, pending: true };
    }
  } catch (err) {
    return toError(err) ?? {};
  }
  revalidatePath("/stores");
  redirect("/stores?deleted=1");
}

type StoreJobKind = "test" | "orders" | "products" | "webhooks" | "removeWebhooks";

/** Queues a read-only Shopify job for one store (nothing here writes to Shopify except webhook subscriptions). */
export async function runStoreJobAction(
  storeId: string,
  kind: StoreJobKind,
  _prev: (Result & { already?: boolean }) | undefined,
  _form: FormData,
): Promise<Result & { already?: boolean }> {
  const ctx = await requireAccountContext();
  let id: string | null;
  try {
    assertCan(
      ctx.role,
      kind === "removeWebhooks" ? "stores.archive" : kind === "webhooks" ? "stores.manage" : "stores.sync",
    );
    const store = await getStore(actorFrom(ctx), storeId);
    // An archived store runs no job except the (retryable) webhook removal.
    if (!!store.archivedAt !== (kind === "removeWebhooks")) throw new DomainError("store_archived");
    const boss = await webBoss();
    const data = { accountId: ctx.accountId, storeId, callbackUrl: webhookCallbackUrl() };
    if (kind === "removeWebhooks") {
      id = await enqueueShopify.removeWebhooks(boss, { ...data, userId: ctx.user.id });
    } else if (kind === "test") id = await enqueueShopify.testConnection(boss, data);
    else if (kind === "orders") id = await enqueueShopify.syncOrders(boss, { ...data, mode: "reconcile" });
    else if (kind === "products") id = await enqueueShopify.syncProducts(boss, data);
    else id = await enqueueShopify.registerWebhooks(boss, data);
  } catch (err) {
    return toError(err) ?? {};
  }
  revalidatePath(`/stores/${storeId}`);
  // null: the same job for this store is already waiting (one at a time per store).
  return { ok: true, already: id === null };
}

export async function backfillOrdersAction(storeId: string, _prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    assertCan(ctx.role, "stores.manage");
    if ((await getStore(actorFrom(ctx), storeId)).archivedAt) throw new DomainError("store_archived");
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

/** "Само поръчки с таг": saves the store's required Shopify tag (empty = all orders) and re-sorts its open orders. */
export async function saveStoreOrderTagAction(
  storeId: string,
  _prev: (Result & { setAside?: number; released?: number }) | undefined,
  form: FormData,
): Promise<NonNullable<Result> & { setAside?: number; released?: number }> {
  const ctx = await requireAccountContext();
  let r: { changed: boolean; setAside: number; released: number };
  try {
    r = await setStoreOrderTag(actorFrom(ctx), storeId, { tag: String(form.get("tag") ?? "") });
  } catch (err) {
    return toError(err) ?? {};
  }
  revalidatePath(`/stores/${storeId}`);
  revalidatePath("/orders");
  return { ok: true, setAside: r.setAside, released: r.released };
}
