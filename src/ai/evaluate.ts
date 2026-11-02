import type { Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { parseDiff } from "@/server/review/diff";
import type { ScopedActor } from "@/server/stores";
import { isAiFixable } from "./fields";
import { AI_APPROVAL_DECISION, enforcePolicies, loadPolicy } from "./policies";

/**
 * P8-03 agreement measurement: every human decision (a decided Review) is compared with the AI suggestion that
 * existed for that order when the person decided; an audit verdict does the same for autopilot approvals.
 *   decisionAgreed — same class: approve (APPROVE / EDIT_AND_APPROVE), hold, cancel, reroute;
 *   fixesAgreed    — the AI's fixes equal the operator's corrections of the AI-fixable fields;
 *   criticalMiss   — the AI would have approved on its own (APPROVE, confidence ≥ autoConfidence) an order a person
 *                    held or blocked; or an audit rejected an autopilot approval.
 */

const SUPERSEDED = "superseded";
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

export function decisionClass(d: string | null | undefined) {
  if (d === "APPROVE" || d === "EDIT_AND_APPROVE") return "approve";
  if (d === "HOLD") return "hold";
  if (d === "CANCEL") return "cancel";
  if (d === "REROUTE") return "reroute";
  return null;
}

/** A change the AI made itself (L1 "apply the AI's corrections"), not an operator's correction. */
export const isAiApplied = (via: string | null | undefined) => !!via && via.startsWith("suggested_fix:ai.");

const norm = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Pure comparison of one suggestion with one human decision. */
export function compare(
  ai: { decision: string; confidence: number; fixes: unknown },
  human: { decision: string; diff: unknown },
  autoConfidence: number,
) {
  const aiClass = decisionClass(ai.decision);
  const humanClass = decisionClass(human.decision);
  const decisionAgreed = aiClass !== null && aiClass === humanClass;
  const changes = parseDiff(human.diff).filter((c) => isAiFixable(c.field));
  // Fields whose final value is the AI's own fix applied with one click (L1) are not independent evidence: the
  // AI cannot agree with itself. They are left out on both sides; a field the operator then edited again is
  // "manual" (mergeDiff keeps the latest via) and is compared like any other correction.
  const aiApplied = new Set(changes.filter((c) => isAiApplied(c.via)).map((c) => c.field as string));
  const humanFixes = new Map(
    changes.filter((c) => !aiApplied.has(c.field)).map((c) => [c.field as string, norm(c.to)]),
  );
  const aiFixes = new Map(
    (Array.isArray(ai.fixes) ? (ai.fixes as { field?: unknown; to?: unknown }[]) : [])
      .filter((f) => typeof f?.field === "string" && !aiApplied.has(String(f.field)))
      .map((f) => [String(f.field), norm(typeof f.to === "string" ? f.to : null)]),
  );
  const fixesAgreed =
    humanClass !== "approve" || (aiApplied.size > 0 && humanFixes.size === 0 && aiFixes.size === 0)
      ? null
      : humanFixes.size === aiFixes.size && [...humanFixes].every(([k, v]) => aiFixes.get(k) === v);
  const criticalMiss =
    ai.decision === "APPROVE" &&
    ai.confidence >= autoConfidence &&
    (humanClass === "hold" || humanClass === "cancel");
  return { decisionAgreed, fixesAgreed, criticalMiss };
}

/** Matches decided reviews to suggestions (idempotent; a suggestion is evaluated once). */
export async function evaluateDecisions(accountId: string, now = new Date(), lookbackDays = 3) {
  const db = accountDb(accountId);
  const policy = await loadPolicy(db, AI_APPROVAL_DECISION);
  const reviews = await db.review.findMany({
    where: {
      decision: { not: null },
      decidedAt: { gte: new Date(now.getTime() - lookbackDays * 86_400_000) },
      OR: [{ reasonCode: null }, { reasonCode: { not: SUPERSEDED } }],
    },
    orderBy: { decidedAt: "asc" },
    take: 1000,
    select: { id: true, orderId: true, decision: true, diff: true, decidedAt: true, aiSuggestion: true },
  });
  let evaluated = 0;
  for (const r of reviews) {
    // The suggestion the person could see when deciding: the latest one before the decision. If that one is
    // already evaluated (or was an autopilot approval), this decision has nothing new to compare with.
    const s = await db.aiSuggestion.findFirst({
      where: { orderId: r.orderId, createdAt: { lte: r.decidedAt! } },
      orderBy: { createdAt: "desc" },
    });
    if (!s || s.evaluatedAt || s.autoApprovedAt) continue;
    const c = compare(s, { decision: r.decision!, diff: r.diff }, policy.thresholds.autoConfidence);
    await withAccountTransaction(accountId, async (tx) => {
      const moved = await tx.aiSuggestion.updateMany({
        where: { id: s.id, evaluatedAt: null },
        data: {
          reviewId: r.id,
          humanDecision: r.decision,
          decisionAgreed: c.decisionAgreed,
          fixesAgreed: c.fixesAgreed,
          criticalMiss: c.criticalMiss,
          evaluatedAt: now,
        },
      });
      if (moved.count && r.aiSuggestion == null)
        await tx.review.update({
          where: { id: r.id },
          data: {
            aiSuggestion: json({
              suggestionId: s.id,
              decision: s.decision,
              fixes: s.fixes,
              flags: s.flags,
              explanation_bg: s.explanationBg,
              model: s.model,
            }),
            aiConfidence: s.confidence,
          },
        });
      evaluated += moved.count;
    });
  }
  // Older suggestions that a later one replaced are never compared (they described other data).
  return evaluated;
}

// ───────────────────────── daily audit sample ─────────────────────────

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/**
 * Draws the random audit sample of yesterday's autopilot approvals (auditRate, at least one when there were
 * any). Idempotent per day: a day that already has samples is skipped.
 */
export async function drawAuditSample(
  accountId: string,
  now = new Date(),
  random: () => number = Math.random,
) {
  const db = accountDb(accountId);
  const policy = await loadPolicy(db, AI_APPROVAL_DECISION);
  const day = new Date(startOfUtcDay(now).getTime() - 86_400_000);
  const dayEnd = new Date(day.getTime() + 86_400_000);
  if (await db.aiAuditSample.count({ where: { day } })) return 0;
  const auto = await db.aiSuggestion.findMany({
    where: { autoApprovedAt: { gte: day, lt: dayEnd } },
    select: { id: true, orderId: true },
  });
  if (!auto.length) return 0;
  const n = Math.min(auto.length, Math.max(1, Math.ceil(auto.length * policy.thresholds.auditRate)));
  const pool = [...auto];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  await db.aiAuditSample.createMany({
    data: pool.slice(0, n).map((s) => ({ accountId, suggestionId: s.id, orderId: s.orderId, day })),
    skipDuplicates: true,
  });
  return n;
}

/** A person's verdict on one sampled autopilot approval. A rejection is a critical miss (→ demotion). */
export async function decideAuditSample(
  actor: ScopedActor,
  sampleId: string,
  verdict: "confirm" | "reject",
  note?: string | null,
  now = new Date(),
) {
  assertCan(actor.role, "ai.audit");
  const text = note?.trim().slice(0, 1000) || null;
  if (verdict === "reject" && !text) throw new DomainError("note_required");
  await withAccountTransaction(actor.accountId, async (tx) => {
    const sample = await tx.aiAuditSample.findUnique({ where: { id: sampleId } });
    if (!sample) throw new DomainError("not_found");
    const order = await tx.order.findUnique({ where: { id: sample.orderId }, select: { companyId: true } });
    if (actor.companyScope && !actor.companyScope.includes(order?.companyId ?? ""))
      throw new DomainError("not_found");
    const moved = await tx.aiAuditSample.updateMany({
      where: { id: sampleId, status: "PENDING" },
      data: {
        status: verdict === "confirm" ? "CONFIRMED" : "REJECTED",
        reviewerId: actor.userId,
        note: text,
        decidedAt: now,
      },
    });
    if (!moved.count) throw new DomainError("already_decided");
    await tx.aiSuggestion.update({
      where: { id: sample.suggestionId },
      data: {
        humanDecision: verdict === "confirm" ? "APPROVE" : "HOLD",
        decisionAgreed: verdict === "confirm",
        criticalMiss: verdict === "reject",
        evaluatedAt: now,
      },
    });
    await tx.auditLog.create({
      data: {
        accountId: actor.accountId,
        userId: actor.userId,
        action: `ai.audit.${verdict}`,
        entityType: "AiAuditSample",
        entityId: sampleId,
        after: json({ orderId: sample.orderId, note: text }),
      },
    });
  });
  // A rejection demotes right away, not at the next sweep.
  if (verdict === "reject") await enforcePolicies(actor.accountId, now);
}
