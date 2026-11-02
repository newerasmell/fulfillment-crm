import { EuShipmentsTransport } from "@/integrations/eushipments/adapter";
import type { EuShipmentsClientOptions } from "@/integrations/eushipments/client";
import { systemDb } from "@/server/db/client";
import type { OutboundTransport, TransportResolver } from "@/server/outbox/transport";
import { euClientFor } from "./connection";
import { euEffects } from "./effects";

/**
 * The euShipments entry of the outbox TransportResolver. The resolver only knows the connection id/type, so the
 * owning account is looked up once (the connection row is the only cross-account read; everything after it is
 * account-scoped), then the token is read from the vault on first use.
 */
export function euShipmentsTransportFor(
  connection: { id: string; type: string },
  opts: EuShipmentsClientOptions = {},
): OutboundTransport | undefined {
  if (connection.type !== "EUSHIPMENTS") return undefined;
  let account: Promise<string> | undefined;
  const accountOf = () =>
    (account ??= systemDb()
      .fulfillmentConnection.findUniqueOrThrow({ where: { id: connection.id }, select: { accountId: true } })
      .then((c) => c.accountId));
  let client: ReturnType<typeof euClientFor> | undefined;
  return new EuShipmentsTransport({
    connect: async () => {
      client ??= accountOf().then((accountId) => euClientFor(accountId, connection.id, opts));
      const c = await client;
      return { client: c.client, companyId: c.companyId };
    },
    effects: euEffects(accountOf, connection.id),
  });
}

export const resolveEuShipmentsTransport: TransportResolver = (connection) =>
  euShipmentsTransportFor(connection);
