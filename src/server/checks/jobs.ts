import type { PgBoss } from "pg-boss";
import { logger } from "@/lib/logger";
import { systemDb } from "@/server/db/client";
import { QUEUES } from "@/server/jobs/queues";
import { checkOrder } from "./validate";

/** Job payload: every job names its account (dead-letter view per account). */
export interface OrderCheckJob {
  accountId: string;
  orderId: string;
}

/** At most one queued + one running check per order (stately queue, singletonKey = order id). */
export function enqueueOrderCheck(boss: PgBoss, d: OrderCheckJob) {
  return boss.send(QUEUES.ordersCheck.name, d, { singletonKey: d.orderId });
}

/** A check that started this long ago and never finished (worker crash) is run again. */
export const STUCK_CHECKING_MS = 10 * 60_000;
const SWEEP_LIMIT = 500;

/** Orders waiting for their first check, and orders stuck in CHECKING (all accounts: a worker sweep). */
export async function ordersDueForCheck(now = new Date()) {
  return systemDb().order.findMany({
    where: {
      OR: [
        { status: "IMPORTED" },
        { status: "CHECKING", updatedAt: { lt: new Date(now.getTime() - STUCK_CHECKING_MS) } },
      ],
    },
    select: { id: true, accountId: true },
    orderBy: { createdAt: "asc" },
    take: SWEEP_LIMIT,
  });
}

export async function registerCheckWorkers(boss: PgBoss, opts: { pollingIntervalSeconds: number }) {
  await boss.work<OrderCheckJob>(QUEUES.ordersCheck.name, opts, async (jobs) => {
    for (const { data } of jobs) {
      const r = await checkOrder(data.accountId, data.orderId, { actor: { kind: "system" } });
      logger.info(
        { orderId: data.orderId, status: r.status, hard: r.hardCount, soft: r.softCount },
        "order checked",
      );
    }
  });
  await boss.work(QUEUES.ordersCheckSweep.name, opts, async () => {
    const due = await ordersDueForCheck();
    for (const o of due) await enqueueOrderCheck(boss, { accountId: o.accountId, orderId: o.id });
    if (due.length) logger.info({ count: due.length }, "order checks queued");
  });
}
