import { logger } from "@/lib/logger";
import { readCapped } from "@/lib/read-capped";
import { MAX_FHB_CALLBACK_BYTES, receiveFhbCallback } from "@/server/fhb/callbacks";
import { enqueueFhb } from "@/server/fhb/jobs";
import { webBoss } from "@/server/jobs/boss";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

/**
 * FHB callbacks: `/api/webhooks/fhb/{connectionId}/stock/{token}` (product notify_url, POST JSON) and
 * `/api/webhooks/fhb/{connectionId}/order/{shipmentId}/{event}/{token}` (order notification URLs; FHB does
 * not document the method or body, so GET and POST are both accepted and the body is ignored). A wrong
 * token is a plain 404. Nothing here calls FHB: the worker re-reads the order/product. If queueing fails,
 * the stored event is picked up by the sweep, so FHB still gets its 200.
 */
async function handle(req: Request, ctx: Ctx) {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_FHB_CALLBACK_BYTES) return new Response(null, { status: 413 });
  const raw = req.method === "GET" ? "" : await readCapped(req, MAX_FHB_CALLBACK_BYTES);
  if (raw === null) return new Response(null, { status: 413 });
  const { path } = await ctx.params;
  const result = await receiveFhbCallback(path ?? [], raw);
  if (result.status !== 200) return new Response(null, { status: result.status });
  if (result.eventId) {
    try {
      await enqueueFhb.callback(await webBoss(), { accountId: result.accountId, eventId: result.eventId });
    } catch (err) {
      logger.warn(
        { eventId: result.eventId, err: (err as Error).message },
        "fhb callback enqueue failed; sweep will retry",
      );
    }
  }
  return new Response(null, { status: 200 });
}

export const POST = handle;
export const GET = handle;
