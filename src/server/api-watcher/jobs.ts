import type { PgBoss } from "pg-boss";
import { logger } from "@/lib/logger";
import { QUEUES } from "@/server/jobs/queues";
import {
  liveCheckFor,
  liveCheckTargets,
  markLiveCheckSweep,
  runLiveCheck,
  type LiveCheckTarget,
} from "./live-check";
import { registerShopifyLiveCheck } from "./shopify-live-check";
import { runShopifyVersionWatch } from "./shopify-version";
import { runSpecWatch } from "./watcher";

/** One live check per store/connection; the payload names its account (dead-letter view per account). */
export type LiveCheckJob = Pick<LiveCheckTarget, "accountId" | "kind" | "id">;

export const enqueueApiWatcher = {
  liveCheck: (boss: PgBoss, d: LiveCheckJob) =>
    boss.send(QUEUES.apiLiveCheckTarget.name, d, { singletonKey: `${d.kind}:${d.id}` }),
};

export async function registerApiWatcherWorkers(boss: PgBoss, opts: { pollingIntervalSeconds: number }) {
  registerShopifyLiveCheck();

  await boss.work(QUEUES.apiSpecWatch.name, opts, async () => {
    const outcomes = await runSpecWatch();
    await runShopifyVersionWatch();
    logger.info({ outcomes: outcomes.map((o) => `${o.vendor}:${o.outcome}`) }, "api spec watch done");
  });

  await boss.work(QUEUES.apiLiveCheck.name, opts, async () => {
    let queued = 0;
    for (const t of await liveCheckTargets()) {
      if (!liveCheckFor(t.type)) continue; // adapter not built yet
      await enqueueApiWatcher.liveCheck(boss, { accountId: t.accountId, kind: t.kind, id: t.id });
      queued++;
    }
    await markLiveCheckSweep();
    logger.info({ queued }, "live checks queued");
  });

  await boss.work<LiveCheckJob>(QUEUES.apiLiveCheckTarget.name, opts, async (jobs) => {
    const targets = await liveCheckTargets();
    for (const { data } of jobs) {
      // Re-read the target: credentials, connection status or enablement may have changed since queuing.
      const t = targets.find(
        (x) => x.id === data.id && x.kind === data.kind && x.accountId === data.accountId,
      );
      if (!t) continue;
      const outcome = await runLiveCheck(t);
      logger.info({ target: t.id, type: t.type, status: outcome.status }, "live check done");
    }
  });
}
