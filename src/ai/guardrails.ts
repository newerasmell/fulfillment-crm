import type { Thresholds } from "./policies";
import { isAiFixable } from "./fields";
import type { AiDecision, ReviewOutput } from "./reviewer-schema";

/**
 * Guardrails applied to every model answer before it is stored (SPEC §7.5). Pure.
 *  - fixes only on AI_FIXABLE_FIELDS (never name, country, e-mail, COD, amounts, lines): others are dropped and noted;
 *  - APPROVE with fixes is EDIT_AND_APPROVE; EDIT_AND_APPROVE whose fixes were all dropped becomes HOLD;
 *  - an approval despite a hard finding becomes HOLD (approval is impossible anyway);
 *  - high-value orders are marked: they always need a person.
 */

export interface GuardedSuggestion {
  decision: AiDecision;
  fixes: { field: string; from: string | null; to: string; reason: string }[];
  flags: string[];
  guardrails: string[];
}

export function isHighValue(total: number, currency: string, t: Pick<Thresholds, "highValue">) {
  const limit = t.highValue[currency.toUpperCase()];
  return limit == null || total >= limit;
}

export function applyGuardrails(
  out: ReviewOutput,
  ctx: { total: number; currency: string; hardCount: number; current: Record<string, string | null> },
  t: Pick<Thresholds, "highValue">,
): GuardedSuggestion {
  const guardrails: string[] = [];
  const fixes: GuardedSuggestion["fixes"] = [];
  const seen = new Set<string>();
  for (const f of out.fixes) {
    if (!isAiFixable(f.field)) {
      guardrails.push(`fix_dropped:${f.field}`);
      continue;
    }
    if (seen.has(f.field)) continue;
    const current = ctx.current[f.field] ?? null;
    if ((current ?? "") === f.to) continue; // not a change
    seen.add(f.field);
    // `from` is what the order holds now, whatever the model echoed.
    fixes.push({ field: f.field, from: current, to: f.to, reason: f.reason });
  }
  let decision: AiDecision = out.decision;
  if (decision === "APPROVE" && fixes.length) decision = "EDIT_AND_APPROVE";
  if (decision === "EDIT_AND_APPROVE" && !fixes.length) {
    decision = out.fixes.length ? "HOLD" : "APPROVE";
    if (out.fixes.length) guardrails.push("fixes_dropped_hold");
  }
  if (decision === "APPROVE" && ctx.hardCount > 0) {
    decision = "HOLD";
    guardrails.push("hard_findings_hold");
  }
  if (isHighValue(ctx.total, ctx.currency, t)) guardrails.push("high_value");
  return {
    decision,
    fixes: decision === "HOLD" || decision === "CANCEL" ? [] : fixes,
    flags: out.flags,
    guardrails,
  };
}
