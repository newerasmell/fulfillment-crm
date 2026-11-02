import { ShopifyClient, type ShopifyClientOptions } from "@/integrations/shopify/client";
import { parseAppCredentials } from "@/integrations/shopify/credentials";
import { DomainError } from "@/server/accounts";
import { accountDb } from "@/server/db/client";
import { readCredentialSecret } from "@/server/security/credentials";

/** Server-only: a ready client for one store (credentials read from the vault, never returned). */
export async function shopifyClientForStore(
  accountId: string,
  storeId: string,
  opts: ShopifyClientOptions = {},
) {
  const db = accountDb(accountId);
  const store = await db.store.findUnique({ where: { id: storeId } });
  if (!store) throw new DomainError("not_found");
  if (!store.credentialId) throw new DomainError("no_credentials");
  const creds = parseAppCredentials(await readCredentialSecret(db, accountId, store.credentialId));
  return { store, client: new ShopifyClient(store.domain, creds, opts) };
}
