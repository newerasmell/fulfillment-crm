import type { Job, PgBoss } from "pg-boss";
import { logger } from "@/lib/logger";
import { purgeOldLoginAttempts } from "@/server/auth/rate-limit";
import { processOutbound, sweepOutbox } from "@/server/outbox/outbox";
import type { TransportResolver } from "@/server/outbox/transport";
import { registerShopifyWorkers } from "@/server/shopify/jobs";
import { registerFhbWorkers } from "@/server/fhb/jobs";
import { registerEushipmentsWorkers } from "@/server/eushipments/jobs";
import { registerApiWatcherWorkers } from "@/server/api-watcher/jobs";
import { registerCheckWorkers } from "@/server/checks/jobs";
import { registerFulfillWorkers } from "@/server/fulfill/jobs";
import { registerAlertWorkers } from "@/server/alerts/jobs";
import { registerLineWorkers } from "@/server/lines/jobs";
import { registerOverrideWorkers } from "@/server/override/jobs";
import { registerStockWorkers } from "@/server/stock/jobs";
import { registerReturnsCodWorkers } from "@/server/returns/jobs";
import { registerLabelWorkers } from "@/server/labels/jobs";
import { QUEUES } from "./queues";

export interface WorkerDeps {
  boss: PgBoss;
  /** Vendor transports per connection; registered by the adapters from phase 2 on. */
  resolveTransport: TransportResolver;
  pollingIntervalSeconds?: number;
}

export interface PingData {
  /** For tests and drills: make the job fail so retries and dead-lettering can be observed. */
  fail?: boolean;
}

export async function handlePing(jobs: Job<PingData>[]) {
  for (const job of jobs) {
    if (job.data?.fail) throw new Error(`ping ${job.id} failed on purpose`);
    logger.info({ jobId: job.id }, "ping");
  }
}

/** Job payloads that concern one account carry its id, so the dead-letter view can show them to that account only. */
export interface OutboxSendData {
  requestId: string;
  accountId: string;
}

/** Queues a send job for one outbox row (duplicates are possible and harmless: the sender claims atomically). */
export function scheduleOutboxSend(boss: PgBoss, data: OutboxSendData) {
  return boss.send(QUEUES.outboxSend.name, data, { singletonKey: data.requestId });
}

export async function registerWorkers(deps: WorkerDeps) {
  const { boss, resolveTransport } = deps;
  const opts = { pollingIntervalSeconds: deps.pollingIntervalSeconds ?? 2 };

  await boss.work<PingData>(QUEUES.ping.name, opts, handlePing);

  await boss.work<OutboxSendData>(QUEUES.outboxSend.name, opts, async (jobs) => {
    for (const job of jobs) {
      const status = await processOutbound(job.data.requestId, resolveTransport);
      logger.info({ requestId: job.data.requestId, status }, "outbox processed");
    }
  });

  await boss.work(QUEUES.housekeeping.name, opts, async () => {
    const purged = await purgeOldLoginAttempts();
    if (purged) logger.info({ purged }, "old login attempts purged");
  });

  await registerShopifyWorkers(boss, opts);
  await registerFhbWorkers(boss, opts);
  await registerEushipmentsWorkers(boss, opts);
  await registerApiWatcherWorkers(boss, opts);
  await registerCheckWorkers(boss, opts);
  await registerFulfillWorkers(boss, opts);
  await registerAlertWorkers(boss, opts);
  await registerLineWorkers(boss, opts);
  await registerOverrideWorkers(boss, opts, resolveTransport);
  await registerStockWorkers(boss, opts);
  await registerReturnsCodWorkers(boss, opts);
  await registerLabelWorkers(boss, opts);

  await boss.work(QUEUES.outboxSweep.name, opts, async () => {
    const due = await sweepOutbox();
    for (const d of due) await scheduleOutboxSend(boss, { requestId: d.id, accountId: d.accountId });
    if (due.length) logger.info({ count: due.length }, "outbox sweep queued sends");
  });
}
