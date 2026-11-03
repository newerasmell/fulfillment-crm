import { logger } from "@/lib/logger";
import { accountDb } from "@/server/db/client";

/**
 * Hard spending limits for every PAID AI call (Claude reviews, OpenAI / Voyage embeddings). Nothing here polls a
 * vendor: the limits only decide whether a call that is about to happen may happen.
 *
 * - Daily cap per group (rolling 24 h), counted from AiInteraction rows (every paid call writes one, ok or not):
 *     AI_DAILY_REVIEW_LIMIT     Claude review calls        (default 100)
 *     AI_DAILY_EMBEDDING_LIMIT  embedding API calls        (default 300; one call embeds up to 64 texts)
 *   0 disables that kind of call completely. When a cap is reached the call is skipped (the local, free
 *   embedding keeps retrieval working) and ONE alert per kind per 24 h tells the owner.
 * - Failure brake: after FAILURE_STREAK failed calls in a row within the last hour (wrong key, no credit,
 *   provider down), calls of that kind pause until an hour has passed since the last failure, so a broken key
 *   can never turn into a retry loop.
 */

export type PaidPurpose = "order_review" | "embedding";

export const DEFAULT_LIMITS: Record<PaidPurpose, number> = { order_review: 100, embedding: 300 };
const ENV: Record<PaidPurpose, string> = {
  order_review: "AI_DAILY_REVIEW_LIMIT",
  embedding: "AI_DAILY_EMBEDDING_LIMIT",
};
export const FAILURE_STREAK = 5;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const LIMIT_ALERT_KIND = "ai_daily_limit";
export const BRAKE_ALERT_KIND = "ai_failure_brake";

export function dailyLimit(purpose: PaidPurpose, env: Record<string, string | undefined> = process.env) {
  const raw = env[ENV[purpose]]?.trim();
  if (!raw) return DEFAULT_LIMITS[purpose];
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 100_000 ? n : DEFAULT_LIMITS[purpose];
}

export type BudgetVerdict =
  | { allowed: true; used: number; limit: number }
  | { allowed: false; reason: "daily_limit" | "failure_brake"; used: number; limit: number };

/** May this group make one more paid call of this kind now? */
export async function checkBudget(
  accountId: string,
  purpose: PaidPurpose,
  now = new Date(),
  env: Record<string, string | undefined> = process.env,
): Promise<BudgetVerdict> {
  const db = accountDb(accountId);
  const limit = dailyLimit(purpose, env);
  const used = await db.aiInteraction.count({
    where: { purpose, createdAt: { gte: new Date(now.getTime() - DAY) } },
  });
  if (used >= limit) {
    await alertOnce(accountId, LIMIT_ALERT_KIND, purpose, now, limitTitle(purpose, limit));
    return { allowed: false, reason: "daily_limit", used, limit };
  }
  const recent = await db.aiInteraction.findMany({
    where: { purpose, createdAt: { gte: new Date(now.getTime() - HOUR) } },
    orderBy: { createdAt: "desc" },
    take: FAILURE_STREAK,
    select: { status: true },
  });
  if (recent.length === FAILURE_STREAK && recent.every((r) => r.status !== "ok")) {
    await alertOnce(accountId, BRAKE_ALERT_KIND, purpose, now, brakeTitle(purpose));
    return { allowed: false, reason: "failure_brake", used, limit };
  }
  return { allowed: true, used, limit };
}

/** Today's usage per paid kind (AI dashboard). */
export async function budgetUsage(accountId: string, now = new Date()) {
  const db = accountDb(accountId);
  const since = new Date(now.getTime() - DAY);
  const rows = await db.aiInteraction.groupBy({
    by: ["purpose"],
    where: { createdAt: { gte: since }, purpose: { in: ["order_review", "embedding"] } },
    _count: { _all: true },
  });
  const used = (p: PaidPurpose) => rows.find((r) => r.purpose === p)?._count._all ?? 0;
  return {
    review: { used: used("order_review"), limit: dailyLimit("order_review") },
    embedding: { used: used("embedding"), limit: dailyLimit("embedding") },
  };
}

const limitTitle = (p: PaidPurpose, limit: number) =>
  p === "order_review"
    ? `AI: дневният лимит от ${limit} AI прегледа е достигнат — нови прегледи спират до утре`
    : `AI: дневният лимит от ${limit} заявки за памет (embeddings) е достигнат — ползва се локалната памет до утре`;
const brakeTitle = (p: PaidPurpose) =>
  p === "order_review"
    ? `AI: ${FAILURE_STREAK} поредни неуспешни заявки към Claude — пауза за 1 час (проверете ключа и кредита)`
    : `AI: ${FAILURE_STREAK} поредни неуспешни заявки за памет (embeddings) — пауза за 1 час (проверете ключа и кредита)`;

/** One open alert per kind and purpose per 24 h. */
async function alertOnce(accountId: string, kind: string, purpose: PaidPurpose, now: Date, title: string) {
  try {
    const db = accountDb(accountId);
    const existing = await db.alert.findFirst({
      where: {
        kind,
        entityType: "AiBudget",
        entityId: purpose,
        createdAt: { gte: new Date(now.getTime() - DAY) },
      },
      select: { id: true },
    });
    if (existing) return;
    await db.alert.create({
      data: { accountId, kind, severity: "WARNING", title, entityType: "AiBudget", entityId: purpose },
    });
  } catch (err) {
    logger.warn({ accountId, kind, err: String(err) }, "ai budget alert failed");
  }
}
