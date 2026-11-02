import type { PgBoss } from "pg-boss";
import { logger } from "@/lib/logger";
import { QUEUES } from "@/server/jobs/queues";
import { processFhbCallback, staleFhbEvents } from "./callbacks";

/** Every payload names its account, so failures show up in that account's dead-letter view only. */
export interface FhbCallbackJob {
  accountId: string;
  eventId: string;
}

export const enqueueFhb = {
  callback: (boss: PgBoss, d: FhbCallbackJob) =>
    boss.send(QUEUES.fhbCallback.name, d, { singletonKey: d.eventId }),
};

export async function registerFhbWorkers(boss: PgBoss, opts: { pollingIntervalSeconds: number }) {
  await boss.work<FhbCallbackJob>(QUEUES.fhbCallback.name, opts, async (jobs) => {
    for (const { data } of jobs) await processFhbCallback(data.accountId, data.eventId);
  });

  await boss.work(QUEUES.fhbCallbackSweep.name, opts, async () => {
    const stale = await staleFhbEvents();
    for (const e of stale) {
      if (e.accountId) await enqueueFhb.callback(boss, { accountId: e.accountId, eventId: e.id });
    }
    if (stale.length) logger.info({ count: stale.length }, "fhb callbacks re-queued");
  });
}
