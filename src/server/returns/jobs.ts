import type { PgBoss } from "pg-boss";
import { logger } from "@/lib/logger";
import { QUEUES } from "@/server/jobs/queues";
import { sweepAllCod } from "@/server/cod/board";
import { notifySupportAll, supportProviders } from "./notify";
import { fetchReturnPhotos } from "./photos";
import { sweepAllReturns } from "./sweep";

/** Job payload of returns.photos: every job names its account (dead-letter view per account). */
export interface ReturnPhotosJob {
  accountId: string;
  caseId: string;
}

export function enqueueReturnPhotos(boss: PgBoss, d: ReturnPhotosJob) {
  return boss.send(QUEUES.returnsPhotos.name, d, { singletonKey: d.caseId });
}

export async function registerReturnsCodWorkers(boss: PgBoss, opts: { pollingIntervalSeconds: number }) {
  await boss.work(QUEUES.returnsSweep.name, opts, async () => {
    await sweepAllReturns();
    const n = await notifySupportAll(supportProviders());
    if (n.sent || n.failed) logger.info(n, "support notifications");
  });
  await boss.work<ReturnPhotosJob>(QUEUES.returnsPhotos.name, opts, async (jobs) => {
    for (const { data } of jobs) {
      const r = await fetchReturnPhotos(data.accountId, data.caseId);
      logger.info({ caseId: data.caseId, ...r }, "return photos fetched");
    }
  });
  await boss.work(QUEUES.codSweep.name, opts, async () => {
    await sweepAllCod();
  });
}
