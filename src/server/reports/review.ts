import { Prisma } from "@/generated/prisma/client";
import { SPEC_MIN_AGREEMENT } from "@/ai/policies";
import { can } from "@/server/auth/rbac";
import { accountDb } from "@/server/db/client";
import { listReasonCodes } from "@/server/review/reasons";
import type { ReportRange } from "./range";
import { assertReport, companySql, reportQuery, scopeWhere, type ReportCtx } from "./sql";

/**
 * Справка 5 — Преглед и автоматизация, for orders placed in the period:
 *   - why orders needed review: the top pre-flight finding codes of their latest check (OrderCheck.findings) —
 *     codes and counts only: finding messages can quote a recipient's address, so none goes into this aggregate;
 *   - how people decided: Review decisions and the top reason codes (labels from the group's reason list);
 *   - how many are on hold / blocked / waiting for review right now (any placement date, not only the period);
 *   - AI (only for members with ai.read, only if suggestions exist): the same agreement flags the AI screen uses
 *     (AiSuggestion.decisionAgreed / fixesAgreed / criticalMiss / autoApprovedAt, filled by src/ai/evaluate.ts),
 *     counted over this period and company scope, against the SPEC target agreement.
 */

export const TOP_N = 10;
const OPEN_STATES = ["NEEDS_REVIEW", "ON_HOLD", "BLOCKED"] as const;

export async function reviewReport(ctx: ReportCtx, range: ReportRange) {
  assertReport(ctx);
  const company = companySql(ctx, Prisma.sql`o."companyId"`);
  const placed = { placedAt: { gte: range.start, lt: range.end } };
  const orderWhere = { ...scopeWhere(ctx), ...placed };
  const db = accountDb(ctx.accountId);
  const [findings, decisions, reasons, states, codes] = await Promise.all([
    company === false
      ? Promise.resolve([])
      : reportQuery<{ code: string; severity: string | null; n: number }>(
          ctx.accountId,
          Prisma.sql`
            SELECT x->>'code' AS code, x->>'severity' AS severity, count(DISTINCT k."orderId")::int AS n
              FROM "OrderCheck" k
              JOIN "Order" o ON o.id = k."orderId" AND o."accountId" = k."accountId"
              CROSS JOIN LATERAL jsonb_array_elements(
                CASE WHEN jsonb_typeof(k.findings) = 'array' THEN k.findings ELSE '[]'::jsonb END) AS x
             WHERE k."accountId" = ${ctx.accountId}
               AND o."placedAt" >= ${range.start} AND o."placedAt" < ${range.end}
               ${company}
               AND x->>'code' IS NOT NULL
             GROUP BY 1, 2
             ORDER BY n DESC, code
             LIMIT ${TOP_N * 2}`,
        ),
    db.review.groupBy({
      by: ["decision"],
      where: { decision: { not: null }, order: orderWhere },
      _count: { _all: true },
      _avg: { timeSpentMs: true },
    }),
    db.review.groupBy({
      by: ["reasonCode"],
      where: { decision: { not: null }, reasonCode: { not: null }, order: orderWhere },
      _count: { _all: true },
      orderBy: { _count: { reasonCode: "desc" } },
      take: TOP_N,
    }),
    // "Waiting now" is the backlog right now, whenever the order was placed (not only orders of the period).
    db.order.groupBy({
      by: ["status"],
      where: { ...scopeWhere(ctx), status: { in: [...OPEN_STATES] } },
      _count: { _all: true },
    }),
    listReasonCodes(ctx.accountId, { includeInactive: true }),
  ]);
  const label = new Map(codes.map((c) => [c.code, c]));
  const open = Object.fromEntries(
    OPEN_STATES.map((s) => [s, states.find((x) => x.status === s)?._count._all ?? 0]),
  ) as Record<(typeof OPEN_STATES)[number], number>;
  let ai = null;
  if (can(ctx.role as never, "ai.read")) {
    const scope = { order: orderWhere };
    const [suggestions, evaluated, agreed, fixes, fixesAgreed, critical, autopilot] = await Promise.all([
      db.aiSuggestion.count({ where: scope }),
      db.aiSuggestion.count({ where: { ...scope, decisionAgreed: { not: null } } }),
      db.aiSuggestion.count({ where: { ...scope, decisionAgreed: true } }),
      db.aiSuggestion.count({ where: { ...scope, fixesAgreed: { not: null } } }),
      db.aiSuggestion.count({ where: { ...scope, fixesAgreed: true } }),
      db.aiSuggestion.count({ where: { ...scope, criticalMiss: true } }),
      db.aiSuggestion.count({ where: { ...scope, autoApprovedAt: { not: null } } }),
    ]);
    if (suggestions > 0)
      ai = {
        suggestions,
        evaluated,
        agreed,
        agreement: evaluated ? agreed / evaluated : null,
        fixes,
        fixesAgreed,
        fixesAgreement: fixes ? fixesAgreed / fixes : null,
        criticalMisses: critical,
        autopilot,
        target: SPEC_MIN_AGREEMENT,
      };
  }
  const decided = decisions.reduce((s, d) => s + d._count._all, 0);
  return {
    findings: findings.slice(0, TOP_N),
    decided,
    decisions: decisions
      .map((d) => ({
        decision: d.decision!,
        count: d._count._all,
        avgMs: d._avg.timeSpentMs == null ? null : Math.round(d._avg.timeSpentMs),
      }))
      .sort((a, b) => b.count - a.count),
    reasons: reasons.map((r) => ({
      code: r.reasonCode!,
      labelBg: label.get(r.reasonCode!)?.labelBg ?? null,
      labelEn: label.get(r.reasonCode!)?.labelEn ?? null,
      count: r._count._all,
    })),
    open,
    ai,
  };
}
export type ReviewReport = Awaited<ReturnType<typeof reviewReport>>;

export function reviewCsv(r: ReviewReport): string[][] {
  const out: string[][] = [["section", "key", "label", "count", "extra"]];
  for (const f of r.findings) out.push(["finding", f.code, "", String(f.n), f.severity ?? ""]);
  for (const d of r.decisions)
    out.push(["decision", d.decision, "", String(d.count), d.avgMs == null ? "" : `avg_ms=${d.avgMs}`]);
  for (const x of r.reasons) out.push(["reason", x.code, x.labelBg ?? "", String(x.count), ""]);
  for (const [k, v] of Object.entries(r.open)) out.push(["open", k, "", String(v), ""]);
  if (r.ai)
    for (const [k, v] of Object.entries(r.ai))
      out.push([
        "ai",
        k,
        "",
        v == null ? "" : typeof v === "number" && v < 1 && v > 0 ? v.toFixed(4) : String(v),
        "",
      ]);
  return out;
}
