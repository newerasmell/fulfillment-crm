import type { PgBoss } from "pg-boss";
import { logger } from "@/lib/logger";
import { QUEUES } from "@/server/jobs/queues";
import { accountDb } from "@/server/db/client";
import { processCatalogueRun } from "./catalogue";

/** Job payload: every job names its account (dead-letter view per account). */
export interface CatalogueJob {
  accountId: string;
  runId: string;
  lineId: string;
}

/** Stately queue, singletonKey = line: one queued + one running run per line (runs are idempotent anyway). */
export function enqueueCatalogueRun(boss: PgBoss, d: CatalogueJob) {
  return boss.send(QUEUES.linesCatalogue.name, d, { singletonKey: d.lineId });
}

export async function registerLineWorkers(boss: PgBoss, opts: { pollingIntervalSeconds: number }) {
  await boss.work<CatalogueJob>(QUEUES.linesCatalogue.name, opts, async (jobs) => {
    for (const { data } of jobs) {
      const run = await processCatalogueRun(data.accountId, data.runId);
      logger.info({ runId: data.runId, status: run?.status }, "lines.catalogue processed");
      // A stately queue keeps one waiting job per line: runs started meanwhile are drained here.
      await drainQueuedRuns(data.accountId, data.lineId);
    }
  });
}

/** Runs of the line still QUEUED (their job was folded into another one), oldest first. */
export async function drainQueuedRuns(accountId: string, lineId: string) {
  for (let i = 0; i < 20; i++) {
    const next = await accountDb(accountId).masterCatalogueRun.findFirst({
      where: { lineId, status: "QUEUED" },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!next) return;
    await processCatalogueRun(accountId, next.id);
  }
}
