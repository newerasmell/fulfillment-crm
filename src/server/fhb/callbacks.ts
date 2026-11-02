import { createHash } from "node:crypto";
import type { FhbClientOptions } from "@/integrations/fhb-v3/client";
import { FhbStockNotification } from "@/integrations/fhb-v3/schemas";
import { accountDb, isUniqueViolation, systemDb } from "@/server/db/client";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import { applyFhbOrderView, applyFhbProductView } from "./apply";
import { authenticateFhbCallbackPath } from "./callback-token";
import { connectionAccount, fhbClientForConnection } from "./connection";

/**
 * FHB callbacks (INTEGRATION_NOTES §2.2, §2.3): order `notification.*` URLs and the product `notify_url`.
 * FHB signs nothing, so the URL path carries a secret token (see callback-token.ts) and the body is never
 * trusted: an order event only says "re-read shipment X", a stock event only names the product to re-read.
 * Intake stores a pointer (WebhookEvent) and answers fast; the worker re-reads from FHB (GET /order?id=,
 * GET /product?id=) and applies that. Re-reading is idempotent, so duplicates and retries are harmless.
 */

export const MAX_FHB_CALLBACK_BYTES = 64_000;
/** Identical calls within this window are one event (FHB retries); a later identical call is re-read again. */
const DEDUPE_WINDOW_MS = 60_000;

export type FhbReceiveResult =
  { status: 404 } | { status: 200; eventId: string | null; accountId: string; duplicate: boolean };

export async function receiveFhbCallback(
  segments: string[],
  rawBody: string,
  now = new Date(),
): Promise<FhbReceiveResult> {
  const auth = authenticateFhbCallbackPath(segments);
  if (!auth) return { status: 404 };
  const connection = await connectionAccount(auth.connectionId);
  if (!connection || connection.type !== "FHB_V3") return { status: 404 };

  let topic: string;
  let payload: Record<string, string | null>;
  if (auth.scope.kind === "order") {
    topic = `order.${auth.scope.event}`;
    payload = { fulfillmentId: auth.scope.fulfillmentId };
  } else {
    topic = "stock";
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      /* not JSON: nothing to point at; stored and ignored by the worker */
    }
    const n = FhbStockNotification.safeParse(parsed);
    payload = n.success
      ? {
          productId: n.data.id,
          type: n.data.type ?? null,
          reason: n.data.reason == null ? null : String(n.data.reason),
        }
      : { productId: null };
  }
  const bucket = Math.floor(now.getTime() / DEDUPE_WINDOW_MS);
  const dedupeKey = createHash("sha256")
    .update(`${segments.join("/")}|${rawBody}|${bucket}`)
    .digest("hex");
  try {
    const event = await accountDb(connection.accountId).webhookEvent.create({
      data: {
        accountId: connection.accountId,
        source: "FHB",
        dedupeKey,
        topic,
        headers: { connectionId: connection.id },
        payload,
      },
    });
    return { status: 200, eventId: event.id, accountId: connection.accountId, duplicate: false };
  } catch (err) {
    if (isUniqueViolation(err))
      return { status: 200, eventId: null, accountId: connection.accountId, duplicate: true };
    throw err;
  }
}

/** Worker: re-reads what the event points at and applies it. Throws on failure so the queue retries. */
export async function processFhbCallback(
  accountId: string,
  eventId: string,
  clientOptions: FhbClientOptions = {},
) {
  const db = accountDb(accountId);
  const event = await db.webhookEvent.findUnique({ where: { id: eventId } });
  if (!event || event.source !== "FHB" || event.status === "PROCESSED" || event.status === "IGNORED")
    return event?.status ?? null;
  const connectionId = (event.headers as { connectionId?: string } | null)?.connectionId;
  const pointer = (event.payload ?? {}) as { fulfillmentId?: string; productId?: string | null };
  const done = (status: "PROCESSED" | "IGNORED", error: string | null = null) =>
    db.webhookEvent.update({
      where: { id: eventId },
      data: { status, processedAt: new Date(), attempts: { increment: 1 }, error },
    });
  try {
    if (!connectionId) return (await done("IGNORED", "no connection")).status;
    if (event.topic.startsWith("order.")) {
      const f = pointer.fulfillmentId
        ? await db.fulfillment.findUnique({ where: { id: pointer.fulfillmentId } })
        : null;
      if (!f || f.connectionId !== connectionId) return (await done("IGNORED", "unknown shipment")).status;
      const client = await fhbClientForConnection(accountId, connectionId, clientOptions);
      const view = await client.getOrder(f.externalId);
      if (!view) return (await done("PROCESSED", "order not found at FHB")).status;
      await applyFhbOrderView(accountId, connectionId, view, `callback:${event.topic}`);
      return (await done("PROCESSED")).status;
    }
    if (event.topic === "stock") {
      if (!pointer.productId) return (await done("IGNORED", "no product id in the notification")).status;
      const client = await fhbClientForConnection(accountId, connectionId, clientOptions);
      const view = await client.getProduct(pointer.productId);
      if (!view) return (await done("PROCESSED", "product not found at FHB")).status;
      await applyFhbProductView(accountId, connectionId, view, { source: "PUSH" });
      return (await done("PROCESSED")).status;
    }
    return (await done("IGNORED", "unknown topic")).status;
  } catch (err) {
    const message = scrubText(err instanceof Error ? err.message : String(err));
    await db.webhookEvent.update({
      where: { id: eventId },
      data: { status: "FAILED", attempts: { increment: 1 }, error: message },
    });
    logger.warn({ eventId, topic: event.topic, err: message }, "fhb callback processing failed");
    throw err;
  }
}

/** Events the queue never finished (enqueue failed at intake, or retries ran out): picked up by the sweep. */
export async function staleFhbEvents(olderThanMs = 2 * 60_000, maxAttempts = 10, take = 200) {
  return systemDb().webhookEvent.findMany({
    where: {
      source: "FHB",
      status: { in: ["RECEIVED", "FAILED"] },
      attempts: { lt: maxAttempts },
      receivedAt: { lt: new Date(Date.now() - olderThanMs) },
    },
    select: { id: true, accountId: true },
    orderBy: { receivedAt: "asc" },
    take,
  });
}
