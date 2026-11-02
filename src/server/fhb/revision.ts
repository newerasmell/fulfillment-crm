import type { Prisma } from "@/generated/prisma/client";
import { payloadHash } from "@/integrations/fhb-v3/adapter";

/**
 * Idempotency key for an FHB update (PUT) of one entity: `{prefix}:r{n}`, one revision per change.
 *
 * A key derived from the payload alone (`{prefix}:{hash}`) breaks on A→B→A: the second A finds the first A
 * already SENT and nothing is sent, so FHB stays at B. Here only the LATEST revision is reused, and only when
 * it carries the same body (a double click / retried action → one request; a re-arm of a refused/dry-run one
 * goes through the outbox's normal re-arm). Anything else is a new revision that will be sent.
 *
 * Call it with the connection row locked (`lockForUpdate("FulfillmentConnection", id)`) so two concurrent
 * changes cannot pick the same revision; a lost race would surface as a unique violation on the outbox key.
 */
export async function updateRevisionKey(
  tx: Prisma.TransactionClient,
  connectionId: string,
  prefix: string,
  body: unknown,
): Promise<string> {
  const rows = await tx.outboundRequest.findMany({
    where: { connectionId, idempotencyKey: { startsWith: `${prefix}:` } },
    select: { idempotencyKey: true, payload: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const latest = rows[0];
  if (latest && payloadHash((latest.payload as { body?: unknown } | null)?.body) === payloadHash(body))
    return latest.idempotencyKey;
  let n = rows.length + 1;
  const taken = new Set(rows.map((r) => r.idempotencyKey));
  while (taken.has(`${prefix}:r${n}`)) n++;
  return `${prefix}:r${n}`;
}
