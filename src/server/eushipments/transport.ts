import { EuShipmentsTransport, type EffectFailure } from "@/integrations/eushipments/adapter";
import type { EuShipmentsClientOptions } from "@/integrations/eushipments/client";
import { scrubText } from "@/lib/scrub";
import { accountDb, systemDb } from "@/server/db/client";
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
  opts: EuShipmentsClientOptions & { now?: () => Date } = {},
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
    onEffectFailed: effectFailureAlert(accountOf, connection.id),
    now: opts.now,
  });
}

/**
 * The vendor did something our records do not show (e.g. a created order without our Fulfillment update):
 * a CRITICAL operator task with the request and the reference, never only a log line.
 */
export function effectFailureAlert(accountOf: () => Promise<string>, connectionId: string) {
  return async (f: EffectFailure) => {
    const accountId = await accountOf();
    const db = accountDb(accountId);
    const request = await db.outboundRequest.findUnique({
      where: { connectionId_idempotencyKey: { connectionId, idempotencyKey: f.idempotencyKey } },
      select: { id: true },
    });
    const ref = typeof f.ctx.referenceNumber === "string" ? f.ctx.referenceNumber : null;
    await db.alert.create({
      data: {
        accountId,
        kind: "eushipments_effect_failed",
        isTask: true,
        severity: "CRITICAL",
        title: `euShipments answered ${f.operation}, but the CRM could not record it (${f.effect})`,
        body: scrubText(
          `Request ${f.idempotencyKey}${ref ? `, reference ${ref}` : ""}. Check the euShipments cabinet and ` +
            `fix the CRM record by hand before doing anything else. Error: ${f.error}`,
          2000,
        ),
        entityType: "OutboundRequest",
        entityId: request?.id ?? f.idempotencyKey,
      },
    });
  };
}

export const resolveEuShipmentsTransport: TransportResolver = (connection) =>
  euShipmentsTransportFor(connection);
