import type { PgBoss } from "pg-boss";
import { logger } from "@/lib/logger";
import { QUEUES } from "@/server/jobs/queues";
import { sweepOrderAlerts } from "./alerts";
import { dispatchNotifications, providersFromEnv } from "./notify";

/** Every 10 min: order-state alerts (blocked, unknown, submit failed, stuck), then notifications. */
export async function registerAlertWorkers(boss: PgBoss, opts: { pollingIntervalSeconds: number }) {
  await boss.work(QUEUES.alertsSweep.name, opts, async () => {
    const s = await sweepOrderAlerts();
    const n = await dispatchNotifications(providersFromEnv());
    if (s.created || s.resolved || n.sent || n.failed) logger.info({ ...s, ...n }, "alerts sweep");
  });
}
