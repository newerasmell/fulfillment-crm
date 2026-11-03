import type { PgBoss } from "pg-boss";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import { QUEUES } from "@/server/jobs/queues";
import { registerJoyLiveCheck } from "./joy-live-check";
import {
  awbLabelsMissing,
  fetchLabel,
  fetchMissingAwbLabel,
  labelsDueForTracking,
  runLabelPrintJob,
  runQuote,
  testJoyConnection,
  trackLabels,
} from "./worker";

/** A label read job; `id` is the job / quote / fulfillment / connection id for that kind. */
export interface LabelReadJob {
  accountId: string;
  kind: "bulk" | "fetch" | "quote" | "joyTest";
  id: string;
}

export interface LabelTrackJob {
  accountId: string;
  connectionId: string;
}

/** Queues one read job (stately per kind+id: a double click queues it once). */
export function enqueueLabelRead(boss: PgBoss, d: LabelReadJob) {
  return boss.send(QUEUES.labelsRead.name, d, { singletonKey: `${d.kind}:${d.id}` });
}

export async function handleLabelRead(d: LabelReadJob) {
  switch (d.kind) {
    case "bulk":
      return runLabelPrintJob(d.accountId, d.id);
    case "fetch":
      return fetchLabel(d.accountId, d.id);
    case "quote":
      return runQuote(d.accountId, d.id);
    case "joyTest":
      return testJoyConnection(d.accountId, d.id);
  }
}

export async function registerLabelWorkers(boss: PgBoss, opts: { pollingIntervalSeconds: number }) {
  registerJoyLiveCheck();
  await boss.work<LabelReadJob>(QUEUES.labelsRead.name, opts, async (jobs) => {
    for (const job of jobs) {
      const r = await handleLabelRead(job.data);
      logger.info({ kind: job.data.kind, id: job.data.id, r }, "label read job");
    }
  });
  await boss.work<LabelTrackJob>(QUEUES.labelsTrack.name, opts, async (jobs) => {
    for (const job of jobs) {
      const r = await trackLabels(job.data.accountId, job.data.connectionId);
      logger.info({ connectionId: job.data.connectionId, ...r }, "labels tracked");
    }
  });
  await boss.work(QUEUES.labelsSweep.name, opts, async () => {
    for (const g of await labelsDueForTracking())
      await boss.send(QUEUES.labelsTrack.name, g, { singletonKey: g.connectionId });
    for (const m of await awbLabelsMissing()) {
      if (!m.fulfillmentId) continue;
      try {
        const r = await fetchMissingAwbLabel(m.accountId, m.fulfillmentId);
        if (!r.stored)
          logger.warn({ fulfillmentId: m.fulfillmentId, reason: r.reason }, "AWB label fetch failed");
      } catch (err) {
        logger.warn(
          { fulfillmentId: m.fulfillmentId, err: scrubText(String((err as Error).message)) },
          "AWB label fetch failed",
        );
      }
    }
  });
}
