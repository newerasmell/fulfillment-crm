import type { PgBoss } from "pg-boss";
import { logger } from "@/lib/logger";
import { accountDb, systemDb } from "@/server/db/client";
import { QUEUES } from "@/server/jobs/queues";
import { orderFingerprint, FINGERPRINT_SELECT, storedFingerprint } from "@/server/pipeline";
import { llmClient } from "./llm";
import { drawAuditSample, evaluateDecisions } from "./evaluate";
import { AI_APPROVAL_DECISION, enforcePolicies } from "./policies";
import { embedPendingReviews } from "./retrieval";
import { REVIEWABLE_STATUSES, reviewOrder } from "./reviewer";
import { mineRules } from "./rule-mining";

/** Job payload: every job names its account (dead-letter view per account). */
export interface AiReviewJob {
  accountId: string;
  orderId: string;
}

export function enqueueAiReview(boss: PgBoss, d: AiReviewJob) {
  return boss.send(QUEUES.aiReview.name, d, { singletonKey: d.orderId });
}

const SWEEP_LIMIT = 200;

/** Groups the AI works for: order_approval policy enabled (shadow or higher) and the group's AI not stopped. */
export async function activeAiAccounts() {
  const rows = await systemDb().aiPolicy.findMany({
    where: { decisionType: AI_APPROVAL_DECISION, enabled: true },
    select: { accountId: true, account: { select: { aiControl: { select: { killSwitch: true } } } } },
  });
  return rows.filter((r) => !r.account.aiControl?.killSwitch).map((r) => r.accountId);
}

/** Checked orders whose current version has no AI suggestion yet (one group). */
export async function ordersDueForAiReview(accountId: string, now = new Date()) {
  const orders = await accountDb(accountId).order.findMany({
    where: {
      status: { in: [...REVIEWABLE_STATUSES] },
      updatedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) },
      check: { isNot: null },
    },
    select: {
      ...FINGERPRINT_SELECT,
      id: true,
      check: { select: { normalised: true } },
      aiSuggestions: { orderBy: { createdAt: "desc" }, take: 1, select: { orderFingerprint: true } },
    },
    orderBy: { updatedAt: "asc" },
    take: SWEEP_LIMIT * 2,
  });
  return orders
    .filter((o) => {
      const fp = storedFingerprint(o.check?.normalised);
      return fp && fp === orderFingerprint(o) && o.aiSuggestions[0]?.orderFingerprint !== fp;
    })
    .slice(0, SWEEP_LIMIT)
    .map((o) => o.id);
}

export async function registerAiWorkers(boss: PgBoss, opts: { pollingIntervalSeconds: number }) {
  await boss.work<AiReviewJob>(QUEUES.aiReview.name, opts, async (jobs) => {
    for (const { data } of jobs) {
      const r = await reviewOrder(data.accountId, data.orderId);
      logger.info(
        { orderId: data.orderId, status: r.status, ...("reason" in r ? { reason: r.reason } : {}) },
        "ai review",
      );
    }
  });
  await boss.work(QUEUES.aiSweep.name, opts, async () => {
    if (!llmClient()) return; // ANTHROPIC_API_KEY unset: the AI is off (GATE P8-G1)
    for (const accountId of await activeAiAccounts()) {
      const due = await ordersDueForAiReview(accountId);
      for (const orderId of due) await enqueueAiReview(boss, { accountId, orderId });
      if (due.length) logger.info({ accountId, count: due.length }, "ai reviews queued");
    }
  });
  await boss.work(QUEUES.aiEvaluate.name, opts, async () => {
    // Embeddings and agreement need no model key: every group with an AI policy row, stopped or not.
    const accounts = await systemDb().aiPolicy.findMany({
      distinct: ["accountId"],
      select: { accountId: true },
    });
    for (const { accountId } of accounts) {
      const embedded = await embedPendingReviews(accountId);
      const evaluated = await evaluateDecisions(accountId);
      const demoted = await enforcePolicies(accountId);
      if (embedded || evaluated || demoted.length)
        logger.info({ accountId, embedded, evaluated, demoted }, "ai evaluate");
    }
  });
  await boss.work(QUEUES.aiAuditSample.name, opts, async () => {
    for (const accountId of await activeAiAccounts()) {
      const n = await drawAuditSample(accountId);
      if (n) logger.info({ accountId, n }, "ai audit sample drawn");
    }
  });
  await boss.work(QUEUES.aiRuleMining.name, opts, async () => {
    const accounts = await systemDb().account.findMany({ select: { id: true } });
    for (const { id } of accounts) {
      const n = await mineRules(id);
      if (n) logger.info({ accountId: id, clusters: n }, "ai rule mining");
    }
  });
}
