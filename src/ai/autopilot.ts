import { logger } from "@/lib/logger";
import { DomainError } from "@/server/accounts";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { currentOrderFingerprint, storedFingerprint, transition, TransitionError } from "@/server/pipeline";
import "./guard";
import { isHighValue } from "./guardrails";
import { AI_APPROVAL_DECISION, aiStopped, loadPolicy } from "./policies";

/**
 * L2 autopilot (SPEC §7.4): an order is approved by the AI only when ALL of these hold —
 *   the group's order_approval policy is enabled at L2 and the AI is not stopped;
 *   the order is READY (no finding at all: a soft finding must be seen by a person) and its data is exactly what
 *   the AI reviewed (check fingerprint);
 *   the suggestion is APPROVE with no fixes and no flags, confidence ≥ autoConfidence;
 *   the order is not high value.
 * The approval is a pipeline transition with an AI actor: the pipeline's own guard loads the AiPolicy inside the
 * same transaction (enabled, L2, order_approval) and ./guard.ts adds the stop switch, READY-only and high-value
 * checks there too. It only approves — sending stays with Fulfill and the outbox mode gate. Never cancels,
 * deletes, edits COD or the recipient.
 */

export type AutopilotResult = { approved: true } | { approved: false; reason: string };

export async function tryAutopilot(
  accountId: string,
  suggestionId: string,
  now = new Date(),
): Promise<AutopilotResult> {
  const db = accountDb(accountId);
  const s = await db.aiSuggestion.findUnique({ where: { id: suggestionId } });
  if (!s) return { approved: false, reason: "not_found" };
  const policy = await loadPolicy(db, AI_APPROVAL_DECISION);
  const t = policy.thresholds;
  const fixes = Array.isArray(s.fixes) ? s.fixes : [];
  const pre =
    !policy.enabled || policy.level !== "L2" || !policy.id
      ? "policy_not_l2"
      : s.autoApprovedAt
        ? "already"
        : s.decision !== "APPROVE"
          ? "not_approve"
          : fixes.length
            ? "has_fixes"
            : s.flags.length
              ? "has_flags"
              : s.guardrails.length
                ? "guardrail"
                : s.confidence < t.autoConfidence
                  ? "low_confidence"
                  : s.orderStatus !== "READY" || s.checkHardCount + s.checkSoftCount > 0
                    ? "not_ready"
                    : null;
  if (pre) return { approved: false, reason: pre };

  try {
    return await withAccountTransaction(accountId, async (tx, { lockForUpdate }) => {
      await lockForUpdate("Order", s.orderId);
      if (await aiStopped(tx)) return { approved: false, reason: "ai_stopped" } as const;
      const order = await tx.order.findUnique({
        where: { id: s.orderId },
        select: {
          status: true,
          total: true,
          currency: true,
          check: { select: { normalised: true, connectionId: true } },
        },
      });
      if (!order || order.status !== "READY") return { approved: false, reason: "not_ready" } as const;
      const fp = await currentOrderFingerprint(tx, s.orderId);
      if (!fp || fp !== s.orderFingerprint || storedFingerprint(order.check?.normalised) !== fp)
        return { approved: false, reason: "order_changed" } as const;
      if (isHighValue(Number(order.total), order.currency, t))
        return { approved: false, reason: "high_value" } as const;
      await transition(tx, {
        orderId: s.orderId,
        to: "APPROVED",
        cause: "approve",
        actor: { kind: "ai", level: "L2", policyId: policy.id! },
        source: "ai.autopilot",
        reason: `AI autopilot (${Math.round(s.confidence * 100)}%)`,
        mode: "strict",
        meta: {
          aiSuggestionId: s.id,
          ...(order.check?.connectionId ? { connectionId: order.check.connectionId } : {}),
        },
      });
      await tx.aiSuggestion.update({
        where: { id: s.id },
        data: { autoApprovedAt: now, autoPolicyId: policy.id },
      });
      await tx.auditLog.create({
        data: {
          accountId,
          userId: null,
          action: "ai.autopilot_approved",
          entityType: "Order",
          entityId: s.orderId,
          after: { suggestionId: s.id, confidence: s.confidence, policyId: policy.id, model: s.model },
        },
      });
      return { approved: true } as const;
    });
  } catch (err) {
    if (err instanceof TransitionError) return { approved: false, reason: err.code };
    if (err instanceof DomainError) return { approved: false, reason: err.code };
    logger.error({ err: String(err), suggestionId }, "autopilot failed");
    throw err;
  }
}
