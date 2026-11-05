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
