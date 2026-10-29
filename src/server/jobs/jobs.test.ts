import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgBoss } from "pg-boss";
import { systemDb } from "@/server/db/client";
import { enqueueOutbound } from "@/server/outbox/outbox";
import { createBoss, ensureQueues } from "./boss";
import { registerWorkers } from "./handlers";
import { DEAD_LETTER_QUEUE, QUEUES } from "./queues";

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe("worker queues (pg-boss)", () => {
  let boss: PgBoss;
  const sent: string[] = [];

  beforeAll(async () => {
    boss = createBoss({ worker: true });
    boss.on("error", () => undefined);
    await boss.start();
    // Fast retries for the test; the production definitions keep their own delays.
    await ensureQueues(boss, [
      {
        ...QUEUES.ping,
        options: { retryLimit: 2, retryDelay: 1, deadLetter: DEAD_LETTER_QUEUE },
      },
      QUEUES.outboxSend,
    ]);
    await registerWorkers({
      boss,
      pollingIntervalSeconds: 0.5,
      resolveTransport: () => ({
        send: async (call) => {
          sent.push(call.idempotencyKey);
          return { outcome: "accepted", response: {} };
        },
      }),
    });
  });

  afterAll(async () => {
    await boss.stop({ graceful: false });
  });

  it("runs a sample job", async () => {
    const id = await boss.send(QUEUES.ping.name, {});
    const job = await waitFor(async () => {
      const [j] = await boss.findJobs(QUEUES.ping.name, { id: id! });
      return j?.state === "completed" ? j : undefined;
    });
    expect(job.retryCount).toBe(0);
  });

  it("retries a failing job, then moves it to the dead-letter queue", async () => {
    const id = await boss.send(QUEUES.ping.name, { fail: true });
    const failed = await waitFor(async () => {
      const [j] = await boss.findJobs(QUEUES.ping.name, { id: id! });
      return j?.state === "failed" ? j : undefined;
    });
    expect(failed.retryCount).toBe(2);
    const dead = await waitFor(async () => {
      const jobs = await boss.findJobs(DEAD_LETTER_QUEUE);
      return jobs.find((j) => (j.data as { fail?: boolean }).fail && j.sourceName === QUEUES.ping.name);
    });
    expect(dead).toBeDefined();
  });

  it("outbox.send jobs drive the sender", async () => {
    const account = await systemDb().account.create({ data: { name: "Worker outbox" } });
    const connection = await systemDb().fulfillmentConnection.create({
      data: { accountId: account.id, type: "EUSHIPMENTS", name: "EU", liveMode: "LIVE" },
    });
    const { request } = await enqueueOutbound({
      accountId: account.id,
      connectionId: connection.id,
      operation: "order.create",
      idempotencyKey: "worker-1",
      payload: {},
    });
    await boss.send(QUEUES.outboxSend.name, { requestId: request.id, accountId: account.id });
    await waitFor(
      async () =>
        (await systemDb().outboundRequest.findUnique({ where: { id: request.id } }))?.status === "SENT",
    );
    expect(sent).toEqual(["worker-1"]);
  });
});

describe("dead-letter view", () => {
  it("shows an account only its own jobs; system jobs and other accounts' jobs are hidden and not redrivable", async () => {
    const { listDeadLetters, redriveDeadLetter } = await import("./dead-letters");
    const boss = createBoss({ worker: true });
    boss.on("error", () => undefined);
    await boss.start();
    await ensureQueues(boss, []);
    const own = await boss.send(DEAD_LETTER_QUEUE, { accountId: "acc-A", requestId: "x" });
    const foreign = await boss.send(DEAD_LETTER_QUEUE, { accountId: "acc-B", requestId: "y" });
    const system = await boss.send(DEAD_LETTER_QUEUE, { fail: true });
    const forA = (await listDeadLetters(boss, "acc-A")).map((j) => j.id);
    expect(forA).toContain(own);
    expect(forA).not.toContain(foreign);
    expect(forA).not.toContain(system);
    expect(await redriveDeadLetter(boss, "acc-A", foreign!)).toBe(false);
    expect(await redriveDeadLetter(boss, "acc-A", system!)).toBe(false);
    await boss.stop({ graceful: false });
  });
});
