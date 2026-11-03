import { DomainError } from "@/server/accounts";
import { assertCan, can } from "@/server/auth/rbac";
import { accountDb } from "@/server/db/client";
import { embeddingCounts } from "@/server/db/vector";
import { orderFingerprint, FINGERPRINT_SELECT, storedFingerprint } from "@/server/pipeline";
import type { ScopedActor } from "@/server/stores";
import { aiModels, aiStatus } from "./config";
import { budgetUsage } from "./budget";
import { embeddingProviders } from "./embeddings";
import {
  ADDRESS_FIX_DECISION,
  AI_APPROVAL_DECISION,
  aiControlView,
  aiStopped,
  listPolicies,
  policyStats,
  promotionCheck,
} from "./policies";
import { proposalBrief } from "./rule-mining";

/** Read models of the AI screens (Настройки → AI асистент, the AI card on the order detail). Reads only. */

/** Audit samples of orders in the member's companies (all for unrestricted members). */
const sampleScope = (actor: ScopedActor) =>
  actor.companyScope ? { suggestion: { order: { companyId: { in: actor.companyScope } } } } : {};

/** Suggestions of orders in the member's companies. */
const suggestionScope = (actor: ScopedActor) =>
  actor.companyScope ? { order: { companyId: { in: actor.companyScope } } } : {};

/**
 * Logged calls of orders in the member's companies (AiInteraction has no order relation: the orders behind the
 * window's calls are resolved first). Unrestricted members: no filter.
 */
async function interactionScope(actor: ScopedActor, since: Date) {
  if (!actor.companyScope) return {};
  const db = accountDb(actor.accountId);
  const recent = await db.aiInteraction.findMany({
    where: { createdAt: { gte: since }, orderId: { not: null } },
    distinct: ["orderId"],
    select: { orderId: true },
    take: 50_000,
  });
  const ids = recent.map((r) => r.orderId!).filter(Boolean);
  const allowed = ids.length
    ? await db.order.findMany({
        where: { id: { in: ids }, companyId: { in: actor.companyScope } },
        select: { id: true },
      })
    : [];
  return { orderId: { in: allowed.map((o) => o.id) } };
}

export async function aiDashboard(actor: ScopedActor, now = new Date()) {
  assertCan(actor.role, "ai.read");
  const db = accountDb(actor.accountId);
  const [control, policies, stopped] = await Promise.all([
    aiControlView(actor.accountId),
    listPolicies(actor.accountId),
    aiStopped(db),
  ]);
  const withStats = await Promise.all(
    policies.map(async (p) => {
      const stats = await policyStats(actor.accountId, p.decisionType, p.thresholds, now);
      return { ...p, stats, promotion: promotionCheck(p, stats, stopped) };
    }),
  );
  // Weekly agreement of order approvals (last 8 weeks, by evaluation time).
  const weeks = Array.from({ length: 8 }, (_, i) => {
    const end = new Date(now.getTime() - i * 7 * 86_400_000);
    return { start: new Date(end.getTime() - 7 * 86_400_000), end };
  }).reverse();
  const trend = await Promise.all(
    weeks.map(async (w) => {
      const where = {
        evaluatedAt: { gte: w.start, lt: w.end },
        decisionAgreed: { not: null },
        ...suggestionScope(actor),
      };
      const [n, agreed] = await Promise.all([
        db.aiSuggestion.count({ where }),
        db.aiSuggestion.count({ where: { ...where, decisionAgreed: true } }),
      ]);
      return { start: w.start, end: w.end, decisions: n, agreement: n ? agreed / n : null };
    }),
  );
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const calls = await interactionScope(actor, dayAgo);
  const [suggestions24h, calls24h, failed24h, tokens, pendingAudit, openProposals, embeddings] =
    await Promise.all([
      db.aiSuggestion.count({ where: { createdAt: { gte: dayAgo }, ...suggestionScope(actor) } }),
      db.aiInteraction.count({ where: { createdAt: { gte: dayAgo }, purpose: "order_review", ...calls } }),
      db.aiInteraction.count({
        where: { createdAt: { gte: dayAgo }, purpose: "order_review", status: { not: "ok" }, ...calls },
      }),
      db.aiInteraction.aggregate({
        where: { createdAt: { gte: dayAgo }, purpose: "order_review", ...calls },
        _sum: { inputTokens: true, outputTokens: true },
      }),
      db.aiAuditSample.count({ where: { status: "PENDING", ...sampleScope(actor) } }),
      db.aiRuleProposal.count({ where: { status: "PROPOSED" } }),
      embeddingCounts(actor.accountId),
    ]);
  return {
    status: aiStatus(),
    models: aiModels(),
    control,
    stopped,
    policies: withStats,
    trend,
    usage: {
      suggestions24h,
      calls24h,
      failed24h,
      inputTokens: tokens._sum.inputTokens ?? 0,
      outputTokens: tokens._sum.outputTokens ?? 0,
    },
    pendingAudit,
    openProposals,
    embeddings,
    providers: embeddingProviders().map((p) => ({ name: p.name, model: p.model })),
    budget: await budgetUsage(actor.accountId, now),
  };
}

/** The AI card on the order detail: latest suggestion of the order and what the member may do with it. */
export async function orderAiCard(actor: ScopedActor, orderId: string) {
  const db = accountDb(actor.accountId);
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      ...FINGERPRINT_SELECT,
      id: true,
      companyId: true,
      status: true,
      updatedAt: true,
      check: { select: { normalised: true } },
    },
  });
  if (!order || (actor.companyScope && !actor.companyScope.includes(order.companyId ?? "")))
    throw new DomainError("not_found");
  const [suggestion, policies, stopped] = await Promise.all([
    db.aiSuggestion.findFirst({ where: { orderId }, orderBy: { createdAt: "desc" } }),
    listPolicies(actor.accountId),
    aiStopped(db),
  ]);
  const fp = orderFingerprint(order);
  const approval = policies.find((p) => p.decisionType === AI_APPROVAL_DECISION)!;
  const fixPolicy = policies.find((p) => p.decisionType === ADDRESS_FIX_DECISION)!;
  const stale =
    !!suggestion && (suggestion.orderFingerprint !== fp || storedFingerprint(order.check?.normalised) !== fp);
  const fixes = (Array.isArray(suggestion?.fixes) ? suggestion!.fixes : []) as {
    field: string;
    from: string | null;
    to: string;
    reason: string;
  }[];
  return {
    status: aiStatus(),
    stopped,
    approvalPolicy: { enabled: approval.enabled, level: approval.level },
    suggestion: suggestion
      ? {
          id: suggestion.id,
          decision: suggestion.decision,
          confidence: suggestion.confidence,
          fixes,
          flags: suggestion.flags,
          guardrails: suggestion.guardrails,
          explanationBg: suggestion.explanationBg,
          model: suggestion.model,
          createdAt: suggestion.createdAt,
          autoApprovedAt: suggestion.autoApprovedAt,
          similarCount: suggestion.similarReviewIds.length,
          humanDecision: suggestion.humanDecision,
          decisionAgreed: suggestion.decisionAgreed,
          stale,
        }
      : null,
    orderVersion: order.updatedAt.toISOString(),
    canRequest: can(actor.role, "orders.review") && ["READY", "NEEDS_REVIEW"].includes(order.status),
    // L1 assist for fixes: one click applies the AI's corrections (a person, through the normal editor path).
    canApplyFixes:
      can(actor.role, "orders.review") &&
      fixPolicy.enabled &&
      fixPolicy.level !== "L0" &&
      !stopped &&
      !stale &&
      fixes.length > 0 &&
      ["IMPORTED", "NEEDS_REVIEW", "READY", "ON_HOLD"].includes(order.status),
  };
}

export async function listAuditSamples(actor: ScopedActor) {
  assertCan(actor.role, "ai.audit");
  const rows = await accountDb(actor.accountId).aiAuditSample.findMany({
    where: sampleScope(actor),
    orderBy: [{ status: "asc" }, { day: "desc" }],
    take: 100,
    include: {
      suggestion: {
        select: {
          confidence: true,
          explanationBg: true,
          model: true,
          autoApprovedAt: true,
          order: {
            select: { id: true, number: true, countryCode: true, total: true, currency: true, status: true },
          },
        },
      },
    },
  });
  return rows;
}

export async function listProposals(actor: ScopedActor) {
  assertCan(actor.role, "ai.rules");
  const rows = await accountDb(actor.accountId).aiRuleProposal.findMany({
    orderBy: [{ status: "desc" }, { distinctOrders: "desc" }],
    take: 200,
  });
  return rows.map((p) => ({ ...p, brief: proposalBrief(p) }));
}

export async function listInteractions(actor: ScopedActor, take = 50) {
  assertCan(actor.role, "ai.log");
  const db = accountDb(actor.accountId);
  const rows = await db.aiInteraction.findMany({
    where: actor.companyScope
      ? {
          orderId: {
            in: (
              await db.order.findMany({
                where: { companyId: { in: actor.companyScope } },
                select: { id: true },
              })
            ).map((o) => o.id),
          },
        }
      : {},
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(take, 1), 200),
    select: {
      id: true,
      orderId: true,
      purpose: true,
      provider: true,
      model: true,
      status: true,
      error: true,
      httpStatus: true,
      inputTokens: true,
      outputTokens: true,
      latencyMs: true,
      createdAt: true,
    },
  });
  const orders = await db.order.findMany({
    where: { id: { in: rows.map((r) => r.orderId).filter((x): x is string => !!x) } },
    select: { id: true, number: true },
  });
  const number = new Map(orders.map((o) => [o.id, o.number]));
  return rows.map((r) => ({ ...r, orderNumber: r.orderId ? (number.get(r.orderId) ?? null) : null }));
}

/** One logged call with its full request/response (loaded only when opened; carries customer data). */
export async function interactionDetail(actor: ScopedActor, id: string) {
  assertCan(actor.role, "ai.log");
  const db = accountDb(actor.accountId);
  const row = await db.aiInteraction.findUnique({ where: { id } });
  if (!row) throw new DomainError("not_found");
  if (actor.companyScope) {
    const o = row.orderId
      ? await db.order.findUnique({ where: { id: row.orderId }, select: { companyId: true } })
      : null;
    if (!o || !actor.companyScope.includes(o.companyId ?? "")) throw new DomainError("not_found");
  }
  return { request: row.request, response: row.response };
}
