import type { Queue } from "pg-boss";

/** Jobs that used up their retries land here and wait for a person (Settings → System jobs). */
export const DEAD_LETTER_QUEUE = "dead_letters";

export interface QueueDef {
  name: string;
  options: Omit<Queue, "name">;
  /** Cron (UTC) if the queue is scheduled. */
  cron?: string;
}

const retry = {
  retryLimit: 5,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 600,
  deadLetter: DEAD_LETTER_QUEUE,
};

export const QUEUES = {
  /** Sample/health job: proves the worker runs, retries and dead-letters. */
  ping: { name: "system.ping", options: { ...retry, retryLimit: 3 } },
  /** Sends one OutboundRequest (data: { requestId }). The sender itself never double-sends. */
  outboxSend: { name: "outbox.send", options: { ...retry, expireInSeconds: 300 } },
  /** Every minute: picks due outbox rows, turns crashed sends into UNCERTAIN tasks. */
  outboxSweep: { name: "outbox.sweep", options: { retryLimit: 0, expireInSeconds: 120 }, cron: "* * * * *" },
} satisfies Record<string, QueueDef>;
