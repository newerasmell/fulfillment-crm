import { z } from "zod";
import { EuShipmentsClient, type EuShipmentsClientOptions } from "@/integrations/eushipments/client";
import { DomainError } from "@/server/accounts";
import { accountDb } from "@/server/db/client";
import { readCredentialSecret } from "@/server/security/credentials";

/**
 * euShipments connection access (server-only). The API token is a static Bearer token stored in the vault as
 * the credential's secret (the whole secret is the token). `vendorIds.companyId` is the euShipments company
 * (= senderId for orders) this connection acts for (INTEGRATION_NOTES §4.1).
 */

export const EuVendorIds = z.object({ companyId: z.coerce.number().int().positive() });

export async function loadEuConnection(accountId: string, connectionId: string) {
  const c = await accountDb(accountId).fulfillmentConnection.findUnique({ where: { id: connectionId } });
  if (!c || c.type !== "EUSHIPMENTS") throw new DomainError("not_found");
  const ids = EuVendorIds.safeParse(c.vendorIds);
  return { connection: c, companyId: ids.success ? ids.data.companyId : null };
}

/** A ready client for the connection — never returned to a browser; the token is never logged. */
export async function euClientFor(
  accountId: string,
  connectionId: string,
  opts: EuShipmentsClientOptions = {},
) {
  const { connection, companyId } = await loadEuConnection(accountId, connectionId);
  if (!connection.credentialId) throw new DomainError("no_credentials");
  if (!companyId) throw new DomainError("no_company_id");
  const token = (await readCredentialSecret(accountDb(accountId), accountId, connection.credentialId)).trim();
  return { connection, companyId, client: new EuShipmentsClient(token, opts) };
}

/**
 * A client for read calls that do not need the euShipments companyId yet (the connection test lists the
 * companies the token can see, so an operator can pick one). Disabled connections are not read.
 */
export async function euReadClientFor(
  accountId: string,
  connectionId: string,
  opts: EuShipmentsClientOptions = {},
) {
  const { connection, companyId } = await loadEuConnection(accountId, connectionId);
  if (!connection.enabled) throw new DomainError("connection_disabled");
  if (!connection.credentialId) throw new DomainError("no_credentials");
  const token = (await readCredentialSecret(accountDb(accountId), accountId, connection.credentialId)).trim();
  return { connection, companyId, client: new EuShipmentsClient(token, opts) };
}
