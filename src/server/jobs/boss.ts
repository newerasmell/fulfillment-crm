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
    max: opts.worker ? 10 : 3,
  });
}

export async function ensureQueues(boss: PgBoss, defs: QueueDef[] = Object.values(QUEUES)) {
  if (!(await boss.getQueue(DEAD_LETTER_QUEUE))) {
    await boss.createQueue(DEAD_LETTER_QUEUE, { retryLimit: 0, retentionSeconds: 60 * 60 * 24 * 30 });
  }
  for (const q of defs) {
    if (await boss.getQueue(q.name)) await boss.updateQueue(q.name, q.options);
    else await boss.createQueue(q.name, q.options);
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
