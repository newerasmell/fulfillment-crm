"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { assertCan, ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { webBoss } from "@/server/jobs/boss";
import { editOrderAddress } from "@/server/review";
import { enqueueAiReview } from "@/ai/jobs";
import { decideAuditSample } from "@/ai/evaluate";
import {
  demotePolicy,
  promotePolicy,
  saveThresholds,
  setAiKillSwitch,
  setPolicyEnabled,
} from "@/ai/policies";
import { decideProposal } from "@/ai/rule-mining";
import { interactionDetail, orderAiCard } from "@/ai/views";

export type AiActionResult = { ok?: boolean; error?: string };

function toError(err: unknown): AiActionResult {
  if (err instanceof ForbiddenError) return { error: "forbidden" };
  if (err instanceof DomainError) return { error: err.code.split(":")[0] ?? err.code };
  if (err instanceof z.ZodError) return { error: "invalid" };
  throw err;
}

const Id = z.string().min(1).max(64);
const Type = z.string().min(1).max(40);

async function run(fn: (actor: ReturnType<typeof actorFrom>) => Promise<unknown>, paths: string[] = ["/ai"]) {
  const ctx = await requireAccountContext();
  try {
    await fn(actorFrom(ctx));
  } catch (err) {
    return toError(err);
  }
  for (const p of paths) revalidatePath(p);
  return { ok: true };
}

export async function setPolicyEnabledAction(type: string, enabled: boolean): Promise<AiActionResult> {
  return run((a) => setPolicyEnabled(a, Type.parse(type), enabled === true));
}

export async function promotePolicyAction(type: string): Promise<AiActionResult> {
  return run((a) => promotePolicy(a, Type.parse(type)));
}

export async function demotePolicyAction(type: string, to: string): Promise<AiActionResult> {
  return run((a) => demotePolicy(a, Type.parse(type), z.enum(["L0", "L1", "L2"]).parse(to)));
}

const pct = (v: FormDataEntryValue | null) => Number(String(v ?? "").replace(",", ".")) / 100;

export async function saveThresholdsAction(
  _prev: AiActionResult | undefined,
  form: FormData,
): Promise<AiActionResult> {
  const highValue: Record<string, number> = {};
  for (const line of String(form.get("highValue") ?? "").split(/[\n,;]/)) {
    const m = /^\s*([A-Za-z]{3})\s*[:=]?\s*([\d.]+)\s*$/.exec(line);
    if (m?.[1] && m[2]) highValue[m[1].toUpperCase()] = Number(m[2]);
  }
  return run((a) =>
    saveThresholds(a, Type.parse(String(form.get("decisionType") ?? "")), {
      windowDays: Number(form.get("windowDays")),
      minDecisions: Number(form.get("minDecisions")),
      minAgreement: pct(form.get("minAgreement")),
      autoConfidence: pct(form.get("autoConfidence")),
      auditRate: pct(form.get("auditRate")),
      demoteMinSample: Number(form.get("demoteMinSample")),
      highValue,
    }),
  );
}

export async function setKillSwitchAction(on: boolean, note: string): Promise<AiActionResult> {
  return run((a) => setAiKillSwitch(a, on === true, String(note ?? "").slice(0, 500)));
}

export async function decideAuditAction(id: string, verdict: string, note: string): Promise<AiActionResult> {
  return run((a) =>
    decideAuditSample(a, Id.parse(id), z.enum(["confirm", "reject"]).parse(verdict), String(note ?? "")),
  );
}

export async function decideProposalAction(
  id: string,
  verdict: string,
  note: string,
): Promise<AiActionResult> {
  return run((a) =>
    decideProposal(a, Id.parse(id), z.enum(["accept", "reject"]).parse(verdict), String(note ?? "")),
  );
}

/** Queue an AI review of the order now (the worker runs it; nothing happens without ANTHROPIC_API_KEY). */
export async function requestAiReviewAction(orderId: string): Promise<AiActionResult> {
  return run(
    async (a) => {
      assertCan(a.role, "orders.review");
      const card = await orderAiCard(a, Id.parse(orderId));
      if (!card.status.enabled) throw new DomainError("ai_off");
      if (!card.canRequest) throw new DomainError("not_reviewable");
      await enqueueAiReview(await webBoss(), { accountId: a.accountId, orderId });
    },
    [`/orders/${orderId}`],
  );
}

/**
 * L1 assist: apply the AI's corrections in one click. It is the person's edit (same editor path, audit and Review
 * diff, via "suggested_fix:ai.reviewer"), only for the guarded fields, and the order is re-checked right after.
 */
export async function applyAiFixesAction(orderId: string, suggestionId: string): Promise<AiActionResult> {
  return run(
    async (a) => {
      const card = await orderAiCard(a, Id.parse(orderId));
      if (!card.canApplyFixes || card.suggestion?.id !== Id.parse(suggestionId))
        throw new DomainError("not_allowed");
      const values: Record<string, string> = {};
      for (const f of card.suggestion.fixes)
        values[f.field === "phone" ? "phone" : f.field.replace(/^shippingAddress\./, "")] = f.to;
      await editOrderAddress(a, orderId, {
        values,
        version: card.orderVersion,
        via: "suggested_fix:ai.reviewer",
      });
    },
    [`/orders/${orderId}`],
  );
}

/** Full request/response of one logged call (ai.log; loaded only when opened). */
export async function interactionDetailAction(
  id: string,
): Promise<{ request?: unknown; response?: unknown; error?: string }> {
  const ctx = await requireAccountContext();
  try {
    return await interactionDetail(actorFrom(ctx), Id.parse(id));
  } catch (err) {
    return toError(err);
  }
}
