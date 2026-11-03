import type { PgBoss } from "pg-boss";
import { logger } from "@/lib/logger";
import { QUEUES } from "@/server/jobs/queues";
import { processWriteBack, sweepWriteBacks } from "./writeback";

/** Worker side of the fulfill track: Shopify write-back sweep + sender (one row at a time, idempotent). */
export async function registerFulfillWorkers(boss: PgBoss, opts: { pollingIntervalSeconds: number }) {
  await boss.work(QUEUES.shopifyWriteBack.name, opts, async () => {
    const s = await sweepWriteBacks();
    for (const id of s.ready) {
      const status = await processWriteBack(id);
      logger.info({ writeBackId: id, status }, "shopify write-back processed");
    }
    if (s.created || s.rearmed || s.stale)
      logger.info({ ...s, ready: s.ready.length }, "shopify write-back sweep");
  });
}
