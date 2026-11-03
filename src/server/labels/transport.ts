import { AwbTransport, withAwbOperations } from "@/integrations/eushipments/awb-adapter";
import type { EuShipmentsClientOptions } from "@/integrations/eushipments/client";
import { JoyTransport } from "@/integrations/fhb-joy/adapter";
import type { JoyClientOptions } from "@/integrations/fhb-joy/client";
import { systemDb } from "@/server/db/client";
import type { OutboundTransport, TransportResolver } from "@/server/outbox/transport";
import { awbClientFor, joyClientFor } from "./connection";
import { awbEffects, joyEffects, labelEffectFailed } from "./effects";

/**
 * Outbox transports for labels. The resolver only knows the connection id/type, so the owning account is looked
 * up once (the only cross-account read); everything after it is account-scoped. Credentials are read from the
 * vault only when a request is actually sent.
 */

const accountOfConnection = (connectionId: string) => {
  let account: Promise<string> | undefined;
  return () =>
    (account ??= systemDb()
      .fulfillmentConnection.findUniqueOrThrow({ where: { id: connectionId }, select: { accountId: true } })
      .then((c) => c.accountId));
};

/** FHB_JOY connections. */
export function createJoyTransportResolver(opts: JoyClientOptions = {}): TransportResolver {
  return (connection) => {
    if (connection.type !== "FHB_JOY") return undefined;
    const accountOf = accountOfConnection(connection.id);
    return new JoyTransport({
      client: async () => joyClientFor(await accountOf(), connection.id, opts),
      onResult: joyEffects(accountOf, connection.id),
      onEffectFailed: labelEffectFailed(accountOf, "FHB Joy"),
    });
  };
}

/** The AWB transport of one euShipments connection. */
export function awbTransportFor(
  connection: { id: string; type: string },
  opts: EuShipmentsClientOptions = {},
) {
  if (connection.type !== "EUSHIPMENTS") return undefined;
  const accountOf = accountOfConnection(connection.id);
  return new AwbTransport({
    connect: async () => {
      const c = await awbClientFor(await accountOf(), connection.id, opts);
      return { client: c.client, companyId: c.companyId };
    },
    onResult: awbEffects(accountOf, connection.id),
    onEffectFailed: labelEffectFailed(accountOf, "euShipments"),
  });
}

/**
 * Wraps the existing resolver: FHB_JOY gets the Joy transport; an euShipments connection keeps its fulfilment
 * transport for every other operation and gains the AWB operations (`eushipments.awb.*`).
 */
export function withLabelTransports(
  inner: TransportResolver,
  opts: { joy?: JoyClientOptions; eu?: EuShipmentsClientOptions } = {},
): TransportResolver {
  const joy = createJoyTransportResolver(opts.joy);
  return (connection): OutboundTransport | undefined => {
    if (connection.type === "FHB_JOY") return joy(connection);
    const base = inner(connection);
    if (connection.type === "EUSHIPMENTS")
      return withAwbOperations(base, awbTransportFor(connection, opts.eu)!);
    return base;
  };
}
