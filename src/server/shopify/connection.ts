import { ShopifyError } from "@/integrations/shopify/errors";
import type { ShopifyClientOptions } from "@/integrations/shopify/client";
import { SHOP_QUERY, ShopResponse } from "@/integrations/shopify/queries";
import { accountDb } from "@/server/db/client";
import { logger } from "@/lib/logger";
import { shopifyClientForStore } from "./store-client";

export interface ConnectionStatus {
  ok: boolean;
  at: string;
  shopName?: string;
  currency?: string;
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
