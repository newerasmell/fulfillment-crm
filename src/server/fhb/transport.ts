import type { FhbClientOptions } from "@/integrations/fhb-v3/client";
import { FhbV3Transport } from "@/integrations/fhb-v3/adapter";
import type { OutboundTransport, TransportResolver } from "@/server/outbox/transport";
import { applyFhbResult } from "./apply";
import { connectionAccount, fhbClientForConnection } from "./connection";

/**
 * TransportResolver entry for FHB v3: the outbox sender (worker) gets a transport per connection. Credentials
 * are read from the vault only when a request is actually sent (never in READ_ONLY / DRY_RUN). Results are
 * applied to the CRM mirror right after the call (shipment status, vendor product, stock receipt).
 * `clientOptions` exists for tests (mocked fetch); production uses the shared defaults.
 */
export function createFhbTransportResolver(clientOptions: FhbClientOptions = {}): TransportResolver {
  return (connection) => {
    if (connection.type !== "FHB_V3") return undefined;
    let account: Promise<string> | null = null;
    const accountId = () =>
      (account ??= connectionAccount(connection.id).then((c) => {
        if (!c) throw new Error("connection not found");
        return c.accountId;
      }));
    const transport: OutboundTransport = new FhbV3Transport({
      client: async () => fhbClientForConnection(await accountId(), connection.id, clientOptions),
      onResult: async (event) => applyFhbResult(await accountId(), connection.id, event),
    });
    return transport;
  };
}

export const resolveFhbTransport: TransportResolver = createFhbTransportResolver();
