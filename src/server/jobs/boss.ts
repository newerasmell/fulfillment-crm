import { logger } from "@/lib/logger";
import { PgBoss } from "pg-boss";
import { DEAD_LETTER_QUEUE, QUEUES, type QueueDef } from "./queues";

export const BOSS_SCHEMA = "pgboss";

export function createBoss(opts: { url?: string; worker: boolean }) {
  const connectionString = opts.url ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new PgBoss({
    connectionString,
    schema: BOSS_SCHEMA,
    // Only the worker installs/migrates the schema, runs maintenance and cron; the web app only reads/sends.
    migrate: opts.worker,
    supervise: opts.worker,
    schedule: opts.worker,
    // Every connection costs database memory (the basic plan went down under load, owner report 2026-11-12).
    max: opts.worker ? 5 : 2,
  });
}

export async function ensureQueues(boss: PgBoss, defs: QueueDef[] = Object.values(QUEUES)) {
  if (!(await boss.getQueue(DEAD_LETTER_QUEUE))) {
    await boss.createQueue(DEAD_LETTER_QUEUE, { retryLimit: 0, retentionSeconds: 60 * 60 * 24 * 30 });
  }
  for (const q of defs) {
    const existing = await boss.getQueue(q.name);
    if (existing) {
      const { policy, ...rest } = q.options as typeof q.options & { policy?: string };
      if (policy && existing.policy !== policy) {
        // A policy cannot be changed in place. An empty queue is recreated; one holding jobs stops the start,
        // because running without the deduplication the code relies on is worse than not running.
        const pending = (await boss.findJobs(q.name, { limit: 100_000 })).filter((j) =>
          ["created", "retry", "active"].includes(j.state),
        );
        if (pending.length) {
          throw new Error(
            `queue ${q.name} has policy ${existing.policy}, needs ${policy}; drain it and restart`,
          );
        }
        logger.warn(
          { queue: q.name, has: existing.policy, wants: policy },
          "recreating empty queue with new policy",
        );
        await boss.deleteQueue(q.name);
        await boss.createQueue(q.name, q.options);
        if (q.cron) await boss.schedule(q.name, q.cron);
        continue;
      }
      await boss.updateQueue(q.name, rest);
    } else await boss.createQueue(q.name, q.options);
    if (q.cron) await boss.schedule(q.name, q.cron);
  }
}

const globalForBoss = globalThis as unknown as { __crmWebBoss?: Promise<PgBoss> };

/** Lazily started, non-supervising instance for the web app (dead-letter view, enqueueing). */
export function webBoss(): Promise<PgBoss> {
  globalForBoss.__crmWebBoss ??= (async () => {
    const boss = createBoss({ worker: false });
    boss.on("error", () => undefined);
    await boss.start();
    return boss;
  })();
  return globalForBoss.__crmWebBoss;
}
