import { z } from "zod";
import type { PgBoss } from "pg-boss";
import { logger } from "@/lib/logger";
import { QUEUES } from "@/server/jobs/queues";
import { accountDb } from "@/server/db/client";
import { autoLinkLine, processCatalogueRun } from "./catalogue";

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

const AutoLinkJob = z.object({ accountId: z.string().min(1).max(64), lineId: z.string().min(1).max(64) });

/** The line's Shopify variants and warehouse products linked by SKU, in the worker (never in a web request). */
export function enqueueAutoLink(boss: PgBoss, d: { accountId: string; lineId: string }) {
  return boss.send(QUEUES.linesAutoLink.name, d, { singletonKey: d.lineId });
}

export async function registerLineWorkers(boss: PgBoss, opts: { pollingIntervalSeconds: number }) {
  await boss.work<{ accountId: string; lineId: string }>(QUEUES.linesAutoLink.name, opts, async (jobs) => {
    for (const job of jobs) {
      const data = AutoLinkJob.parse(job.data);
      const linked = await autoLinkLine(data.accountId, data.lineId);
      logger.info({ lineId: data.lineId, linked }, "lines.autoLink processed");
    }
  });
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
