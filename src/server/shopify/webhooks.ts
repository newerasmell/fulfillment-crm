import type { ShopifyClientOptions } from "@/integrations/shopify/client";
import { isShopDomain } from "@/integrations/shopify/config";
import { parseAppCredentials } from "@/integrations/shopify/credentials";
import {
  WEBHOOK_CREATE_MUTATION,
  WEBHOOK_SUBSCRIPTIONS_QUERY,
  WEBHOOK_TOPICS,
  WebhookCreate,
  WebhookSubscriptions,
  verifyWebhookHmac,
  webhookTarget,
} from "@/integrations/shopify/webhooks";
import { accountDb, isUniqueViolation, systemDb } from "@/server/db/client";
import { readCredentialSecret } from "@/server/security/credentials";
import { logger } from "@/lib/logger";
import { refreshShopifyOrder } from "./orders";
import { refreshShopifyProduct } from "./products";
import { shopifyClientForStore } from "./store-client";

export const MAX_WEBHOOK_BYTES = 1_000_000;

/** Public base URL of the web service; webhooks are registered against it. */
export function webhookCallbackUrl(env: NodeJS.ProcessEnv = process.env) {
  const base = env.APP_URL || (env.APP_HOST ? `https://${env.APP_HOST}` : env.RENDER_EXTERNAL_URL);
  if (!base) throw new Error("APP_URL / APP_HOST is not set");
  const url = new URL("/api/webhooks/shopify", base);
  if (url.protocol !== "https:" && env.NODE_ENV === "production")
    throw new Error("webhook URL must be https");
  return url.toString();
}

/**
 * Decrypted client secrets, briefly cached so a flood of (forged) webhooks for a known shop does not decrypt
 * the vault entry on every request. Keyed by credential id AND its updatedAt: a secret rotated in place
 * (same id) is a cache miss immediately.
 */
const SECRET_TTL_MS = 5 * 60_000;
const secretCache = new Map<string, { secret: string; until: number }>();

async function webhookSecret(accountId: string, credentialId: string, version: Date) {
  const key = `${credentialId}@${version.getTime()}`;
  const hit = secretCache.get(key);
  if (hit && hit.until > Date.now()) return hit.secret;
  const { clientSecret } = parseAppCredentials(
    await readCredentialSecret(accountDb(accountId), accountId, credentialId),
  );
  if (secretCache.size > 500) secretCache.clear();
  secretCache.set(key, { secret: clientSecret, until: Date.now() + SECRET_TTL_MS });
  return clientSecret;
}

/** The stored payload is only the pointer we act on — the order/customer data is re-read from Shopify. */
export function webhookPointer(payload: unknown) {
  const p = (payload ?? {}) as Record<string, unknown>;
  const edit = p.order_edit as Record<string, unknown> | undefined;
  const pick = (v: unknown) => (typeof v === "string" || typeof v === "number" ? v : undefined);
  return {
    id: pick(p.id),
    admin_graphql_api_id: pick(p.admin_graphql_api_id),
    order_id: pick(p.order_id),
    ...(edit ? { order_edit: { order_id: pick(edit.order_id) } } : {}),
  };
}

export type ReceiveResult =
  | { status: 401 }
  | { status: 400 }
  | { status: 200; eventId: string | null; accountId: string | null; duplicate: boolean };

/**
 * Webhook intake: authenticates (HMAC with the client secret of the store the shop domain belongs to), stores
 * the event once per X-Shopify-Webhook-Id and returns fast. All real work happens in the worker, which re-reads
 * the resource from Shopify — the body is only a pointer.
 */
export async function receiveShopifyWebhook(rawBody: string, headers: Headers): Promise<ReceiveResult> {
  const domain = headers.get("x-shopify-shop-domain")?.toLowerCase() ?? "";
  const topic = headers.get("x-shopify-topic") ?? "";
  const webhookId = headers.get("x-shopify-webhook-id") ?? "";
  const hmac = headers.get("x-shopify-hmac-sha256");
  if (!isShopDomain(domain) || !topic || !webhookId || !hmac) return { status: 401 };

  // The same shop may be connected in more than one group; the signature decides which one sent it.
  const stores = await systemDb().store.findMany({
    where: { domain, credentialId: { not: null } },
    select: { id: true, accountId: true, credentialId: true, credential: { select: { updatedAt: true } } },
  });
  let store: (typeof stores)[number] | null = null;
  for (const s of stores) {
    try {
      if (
        verifyWebhookHmac(
          rawBody,
          hmac,
          await webhookSecret(s.accountId, s.credentialId!, s.credential!.updatedAt),
        )
      ) {
        store = s;
        break;
      }
    } catch (err) {
      logger.warn({ storeId: s.id, err: (err as Error).message }, "webhook: cannot read store credentials");
    }
  }
  if (!store) {
    logger.warn({ domain, topic }, "shopify webhook rejected: signature");
    return { status: 401 };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400 };
  }
  try {
    const event = await accountDb(store.accountId).webhookEvent.create({
      data: {
        accountId: store.accountId,
        source: "SHOPIFY",
        dedupeKey: `${store.id}:${webhookId}`,
        topic,
        headers: { storeId: store.id, webhookId, triggeredAt: headers.get("x-shopify-triggered-at") },
        payload: webhookPointer(payload),
      },
    });
    return { status: 200, eventId: event.id, accountId: store.accountId, duplicate: false };
  } catch (err) {
    if (isUniqueViolation(err))
      return { status: 200, eventId: null, accountId: store.accountId, duplicate: true };
    throw err;
  }
}

/** Worker: acts on one stored event. Throws on failure so the queue retries (then dead-letters). */
export async function processShopifyWebhook(
  accountId: string,
  eventId: string,
  opts: ShopifyClientOptions = {},
) {
  const db = accountDb(accountId);
  const event = await db.webhookEvent.findUnique({ where: { id: eventId } });
  if (!event || event.status === "PROCESSED" || event.status === "IGNORED") return event?.status ?? null;
  const storeId = (event.headers as { storeId?: string } | null)?.storeId;
  const target = webhookTarget(event.topic, event.payload);
  try {
    if (!storeId || target.kind === "ignore") {
      await db.webhookEvent.update({
        where: { id: eventId },
        data: { status: "IGNORED", processedAt: new Date() },
      });
      return "IGNORED";
    }
    if (target.kind === "uninstalled") {
      await db.store.update({
        where: { id: storeId },
        data: {
          connectionStatus: { ok: false, at: new Date().toISOString(), error: "app_uninstalled" },
          webhookStatus: {},
        },
      });
    } else {
      const { store, client } = await shopifyClientForStore(accountId, storeId, opts);
      if (target.kind === "order") await refreshShopifyOrder(accountId, store, client, target.gid);
      else await refreshShopifyProduct(accountId, store, client, target.gid);
    }
    await db.webhookEvent.update({
      where: { id: eventId },
      data: { status: "PROCESSED", processedAt: new Date(), attempts: { increment: 1 }, error: null },
    });
    return "PROCESSED";
  } catch (err) {
    const code = (err as { code?: string }).code ?? "unexpected";
    await db.webhookEvent.update({
      where: { id: eventId },
      data: { status: "FAILED", attempts: { increment: 1 }, error: code },
    });
    throw err;
  }
}

/** Events stored but never processed (the enqueue after the 200 failed) — picked up by the reconcile cron. */
export async function staleWebhookEvents(olderThanMs = 2 * 60_000, take = 200) {
  return systemDb().webhookEvent.findMany({
    where: { source: "SHOPIFY", status: "RECEIVED", receivedAt: { lt: new Date(Date.now() - olderThanMs) } },
    select: { id: true, accountId: true },
    orderBy: { receivedAt: "asc" },
    take,
  });
}

/** Worker: makes sure every topic is subscribed to our URL (idempotent; creates only what is missing). */
export async function registerStoreWebhooks(
  accountId: string,
  storeId: string,
  opts: ShopifyClientOptions = {},
  uri = webhookCallbackUrl(),
) {
  const { client } = await shopifyClientForStore(accountId, storeId, opts);
  const existing = await client.query(WEBHOOK_SUBSCRIPTIONS_QUERY, { uri }, WebhookSubscriptions);
  const have = new Set(existing.webhookSubscriptions.nodes.filter((n) => n.uri === uri).map((n) => n.topic));
  const errors: string[] = [];
  for (const topic of WEBHOOK_TOPICS) {
    if (have.has(topic)) continue;
    const res = await client.query(WEBHOOK_CREATE_MUTATION, { topic, uri }, WebhookCreate);
    const errs = res.webhookSubscriptionCreate.userErrors;
    if (errs.length) errors.push(`${topic}: ${errs.map((e) => e.message).join("; ")}`.slice(0, 300));
    else have.add(topic);
  }
  const status = {
    ok: errors.length === 0,
    at: new Date().toISOString(),
    topics: [...have].sort(),
    ...(errors.length ? { errors } : {}),
  };
  await accountDb(accountId).store.update({ where: { id: storeId }, data: { webhookStatus: status } });
  return status;
}
