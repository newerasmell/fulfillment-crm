import { registerGuard } from "@/server/pipeline";
import { isHighValue } from "./guardrails";
import { parseThresholds } from "./policies";
import { globalKillSwitch } from "./config";

/**
 * Extra approve guards for an AI actor, registered with the pipeline (they run inside the approving transaction,
 * after the pipeline's own AiPolicy L2 check): the AI stop switch, READY only (an order with any finding — even a
 * soft one — must be seen by a person) and never a high-value order. People are not affected.
 */
let registered = false;

export function registerAiGuards() {
  if (registered) return;
  registered = true;
  registerGuard("approve", async (tx, { actor, order }) => {
    if (actor.kind !== "ai") return null;
    if (globalKillSwitch()) return "ai_stopped";
    const control = await tx.aiControl.findFirst({ select: { killSwitch: true } });
    if (control?.killSwitch) return "ai_stopped";
    if (order.status !== "READY") return "ai_not_ready";
    const [row, policy] = await Promise.all([
      tx.order.findUnique({ where: { id: order.id }, select: { total: true, currency: true } }),
      tx.aiPolicy.findFirst({ where: { id: actor.policyId }, select: { thresholds: true } }),
    ]);
    if (!row || isHighValue(Number(row.total), row.currency, parseThresholds(policy?.thresholds)))
      return "ai_high_value";
    return null;
  });
}

registerAiGuards();
