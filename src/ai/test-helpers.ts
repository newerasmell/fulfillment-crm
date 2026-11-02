/** Rows for tests that need an agreement history (createMany data for AiSuggestion). Synthetic only. */
export function autopilotSuggestionData(
  accountId: string,
  orderId: string,
  over: { evaluatedAt?: Date; decisionAgreed?: boolean; fixesAgreed?: boolean; criticalMiss?: boolean } = {},
) {
  return {
    accountId,
    orderId,
    model: "claude-sonnet-5-5",
    decision: "APPROVE",
    confidence: 0.99,
    explanationBg: "Синтетичен запис за тест.",
    flags: [],
    guardrails: [],
    similarReviewIds: [],
    orderStatus: "READY" as const,
    ...over,
  };
}
