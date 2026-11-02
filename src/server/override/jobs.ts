import type { PgBoss } from "pg-boss";
import { logger } from "@/lib/logger";
import { QUEUES } from "@/server/jobs/queues";
import type { TransportResolver } from "@/server/outbox/transport";
import { sweepReroutes } from "./reroute";

/** Worker side of the override track (P4-09): the reroute sweep (uses only read-backs, never a new write). */
export async function registerOverrideWorkers(
  boss: PgBoss,
  opts: { pollingIntervalSeconds: number },
  resolveTransport: TransportResolver,
) {
  await boss.work(QUEUES.ordersRerouteSweep.name, opts, async () => {
    const done = await sweepReroutes(resolveTransport);
    const moved = done.filter((d) => d.result !== "waiting");
    if (moved.length) logger.info({ reroutes: moved }, "reroutes processed");
  });
}
