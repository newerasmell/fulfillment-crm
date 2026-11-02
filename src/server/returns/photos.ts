import { FhbError, type FhbClientOptions } from "@/integrations/fhb-v3/client";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import { accountDb } from "@/server/db/client";
import { fhbClientForConnection } from "@/server/fhb/connection";

/**
 * FHB local return photos (GET /return/{uid}/photo/{photoId}, a read): fetched by the worker when an operator
 * asks for them on the board, stored in ReturnPhoto and served by /api/returns/photos/[id]. Images only, at most
 * MAX_BYTES each; anything else is refused and recorded as FAILED.
 */

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export function acceptedImageType(contentType: string) {
  const t = contentType.split(";")[0]!.trim().toLowerCase();
  return IMAGE_TYPES.includes(t) ? t : null;
}

export async function fetchReturnPhotos(
  accountId: string,
  caseId: string,
  clientOptions: FhbClientOptions = {},
) {
  const db = accountDb(accountId);
  const c = await db.returnCase.findUnique({
    where: { id: caseId },
    select: { connectionId: true, localReturnUid: true, connection: { select: { type: true } } },
  });
  if (!c?.localReturnUid || c.connection.type !== "FHB_V3") return { fetched: 0, failed: 0 };
  const pending = await db.returnPhoto.findMany({ where: { returnCaseId: caseId, status: "PENDING" } });
  if (!pending.length) return { fetched: 0, failed: 0 };
  const client = await fhbClientForConnection(accountId, c.connectionId, clientOptions);
  let fetched = 0;
  let failed = 0;
  for (const p of pending) {
    try {
      const file = await client.returnPhoto(c.localReturnUid, p.photoId, MAX_PHOTO_BYTES);
      const type = file ? acceptedImageType(file.contentType) : null;
      if (!file) throw new Error("not found at FHB");
      if (!type) throw new Error(`not an image (${scrubText(file.contentType, 60) || "no type"})`);
      await db.returnPhoto.update({
        where: { id: p.id },
        data: {
          status: "READY",
          contentType: type,
          bytes: Buffer.from(file.bytes),
          fetchedAt: new Date(),
          error: null,
        },
      });
      fetched++;
    } catch (err) {
      if (err instanceof FhbError && err.code === "auth_failed") throw err;
      const error = scrubText((err as Error).message, 300);
      logger.warn({ caseId, photoId: p.photoId, err: error }, "return photo fetch failed");
      await db.returnPhoto.update({ where: { id: p.id }, data: { status: "FAILED", error } });
      failed++;
    }
  }
  return { fetched, failed };
}
