import { ShopifyError } from "@/integrations/shopify/errors";
import type { ShopifyClientOptions } from "@/integrations/shopify/client";
import {
  APP_SCOPES_QUERY,
  AppScopesResponse,
  SHOP_QUERY,
  ShopResponse,
} from "@/integrations/shopify/queries";
import { missingScopes } from "@/integrations/shopify/scopes";
import { accountDb } from "@/server/db/client";
import { logger } from "@/lib/logger";
import { shopifyClientForStore } from "./store-client";

export interface ConnectionStatus {
  ok: boolean;
  at: string;
  shopName?: string;
  currency?: string;
  /** Scopes the app holds on the store, and the required ones it lacks (null = could not be read). */
  scopes?: string[];
  missingScopes?: string[] | null;
  /** When the scopes were last read (connection test or the hourly refresh). */
  scopesAt?: string;
  /** ShopifyError code or "unexpected"; never a secret or a raw response. */
  error?: string;
}

/** Worker job: proves the credentials work and that the domain is the shop we think it is. */
export async function testStoreConnection(
  accountId: string,
  storeId: string,
  opts: ShopifyClientOptions = {},
) {
  const at = new Date().toISOString();
  let status: ConnectionStatus;
  try {
    const { client, store } = await shopifyClientForStore(accountId, storeId, opts);
    const { shop } = await client.query(SHOP_QUERY, {}, ShopResponse);
    status =
      shop.myshopifyDomain.toLowerCase() === store.domain
        ? { ok: true, at, shopName: shop.name, currency: shop.currencyCode }
        : { ok: false, at, error: "domain_mismatch" };
    if (status.ok) {
      await accountDb(accountId).store.update({ where: { id: storeId }, data: { shopName: shop.name } });
      // Which rights the app really got: a missing one is shown on the store page (never fails the connection).
      try {
        const r = await client.query(APP_SCOPES_QUERY, {}, AppScopesResponse);
        const scopes = r.currentAppInstallation.accessScopes.map((a) => a.handle).sort();
        status = { ...status, scopes, missingScopes: missingScopes(scopes) };
      } catch (err) {
        logger.warn({ storeId, err: (err as Error).message }, "shopify access scopes not readable");
        status = { ...status, missingScopes: null };
      }
    }
  } catch (err) {
    const code = err instanceof ShopifyError ? err.code : ((err as { code?: string }).code ?? "unexpected");
    logger.warn({ storeId, code }, "shopify connection test failed");
    status = { ok: false, at, error: code };
  }
  await accountDb(accountId).store.update({
    where: { id: storeId },
    data: { connectionStatus: status as object },
  });
  return status;
}

/**
 * Re-reads only the rights the app holds on a store (owner report 2026-11-11: write_orders added in the Dev
 * Dashboard, but the page still said it was missing — the rights were from the last connection test). Read-only and
 * light; keeps the rest of the last connection status. A failed read changes nothing.
 */
export async function refreshStoreScopes(
  accountId: string,
  storeId: string,
  opts: ShopifyClientOptions = {},
) {
  const db = accountDb(accountId);
  const store = await db.store.findUnique({ where: { id: storeId }, select: { connectionStatus: true } });
  const last = (store?.connectionStatus ?? {}) as Partial<ConnectionStatus>;
  if (!store || !last.ok || !last.at) return null; // never tested or broken: the connection test is what tells
  try {
    const { client } = await shopifyClientForStore(accountId, storeId, opts);
    const r = await client.query(APP_SCOPES_QUERY, {}, AppScopesResponse);
    const scopes = r.currentAppInstallation.accessScopes.map((a) => a.handle).sort();
    const next = {
      ...last,
      scopes,
      missingScopes: missingScopes(scopes),
      scopesAt: new Date().toISOString(),
    };
    // Only over the status it read: a connection test that finished meanwhile is newer and stays.
    const res = await db.store.updateMany({
      where: { id: storeId, connectionStatus: { path: ["at"], equals: last.at } },
      data: { connectionStatus: next as object },
    });
    return res.count === 1 ? next : null;
  } catch (err) {
    logger.warn({ storeId, err: (err as Error).message }, "shopify access scopes refresh failed");
    return null;
  }
}
