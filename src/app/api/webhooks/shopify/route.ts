import { logger } from "@/lib/logger";
import { webBoss } from "@/server/jobs/boss";
import { enqueueShopify } from "@/server/shopify/jobs";
import { MAX_WEBHOOK_BYTES, receiveShopifyWebhook } from "@/server/shopify/webhooks";

export const dynamic = "force-dynamic";

/**
 * Shopify webhooks: verify HMAC on the raw body, store once, answer 200 fast. Processing runs in the worker;
 * if queueing fails here the 15-minute reconcile picks the stored event up, so we still answer 200.
 */
export async function POST(req: Request) {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_WEBHOOK_BYTES) return new Response(null, { status: 413 });
  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_WEBHOOK_BYTES) return new Response(null, { status: 413 });

  const result = await receiveShopifyWebhook(raw, req.headers);
  if (result.status !== 200) return new Response(null, { status: result.status });
  if (result.eventId && result.accountId) {
    try {
      await enqueueShopify.webhook(await webBoss(), { accountId: result.accountId, eventId: result.eventId });
    } catch (err) {
      logger.warn(
        { eventId: result.eventId, err: (err as Error).message },
        "webhook enqueue failed; reconcile will retry",
      );
    }
  }
  return new Response(null, { status: 200 });
}
