import type { Prisma } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import type { Finding } from "@/server/checks/findings";
import { accountDb } from "@/server/db/client";
import { FINGERPRINT_SELECT, orderFingerprint, storedFingerprint } from "@/server/pipeline";
import { editorValues } from "@/server/review/diff";
import type { RoutingDecision } from "@/server/routing";
import { aiModels } from "./config";
import { applyGuardrails } from "./guardrails";
import { llmClient, MessageResponse } from "./llm";
import { AI_APPROVAL_DECISION, aiStopped, loadPolicy } from "./policies";
import { reviewRequestBody, type ReviewContext } from "./prompt";
import { similarCases } from "./retrieval";
import { REVIEW_TOOL_NAME, ReviewOutput } from "./reviewer-schema";
import { tryAutopilot, type AutopilotResult } from "./autopilot";

/**
 * P8-02 AI reviewer: one Claude call per order version (check fingerprint), with the normalised order, the
 * validator findings, the customer's history and the 20 most similar decided reviews (P8-01). The answer is a
 * strict tool call {decision, confidence, fixes, flags, explanation_bg}; it is guarded (guardrails.ts) and stored
 * as an AiSuggestion. Every call — success or not — is logged verbatim in AiInteraction. Nothing is sent to a
 * warehouse or Shopify here; only at L2 does autopilot.ts approve, through the pipeline guard.
 */

export const REVIEWABLE_STATUSES = ["READY", "NEEDS_REVIEW"] as const;
/** After this many failed calls in a day an order is no longer retried automatically. */
export const MAX_FAILURES_PER_DAY = 2;

export type ReviewOutcome =
  | { status: "suggested"; suggestionId: string; autopilot: AutopilotResult | null }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string; interactionId: string };

const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;
const num = (v: { toString(): string } | null | undefined) => (v == null ? null : Number(v.toString()));
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

/** Current values of the fixable fields (what a fix's `from` must be). */
function currentValues(address: unknown, phone: string | null): Record<string, string | null> {
  const v = editorValues(address as Record<string, unknown> | null, phone);
  return {
    "shippingAddress.company": v.company,
    "shippingAddress.address1": v.address1,
    "shippingAddress.address2": v.address2,
    "shippingAddress.city": v.city,
    "shippingAddress.zip": v.zip,
    "shippingAddress.province": v.province,
    phone: v.phone,
  };
}

export async function reviewOrder(
  accountId: string,
  orderId: string,
  opts: { now?: Date; force?: boolean } = {},
): Promise<ReviewOutcome> {
  const now = opts.now ?? new Date();
  const client = llmClient();
  if (!client) return { status: "skipped", reason: "ai_off" };
  const db = accountDb(accountId);
  if (await aiStopped(db)) return { status: "skipped", reason: "ai_stopped" };
  const policy = await loadPolicy(db, AI_APPROVAL_DECISION);
  if (!policy.enabled) return { status: "skipped", reason: "policy_off" };

  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      ...FINGERPRINT_SELECT,
      id: true,
      number: true,
      status: true,
      shippingAddressOriginal: true,
      note: true,
      risk: true,
      lines: { select: { title: true, sku: true, productId: true, quantity: true, unitPrice: true } },
      check: true,
    },
  });
  if (!order) return { status: "skipped", reason: "not_found" };
  if (!(REVIEWABLE_STATUSES as readonly string[]).includes(order.status))
    return { status: "skipped", reason: `status_${order.status.toLowerCase()}` };
  const check = order.check;
  if (!check) return { status: "skipped", reason: "no_check" };
  const fingerprint = storedFingerprint(check.normalised);
  if (!fingerprint || fingerprint !== orderFingerprint(order))
    return { status: "skipped", reason: "check_stale" };

  if (!opts.force) {
    const last = await db.aiSuggestion.findFirst({
      where: { orderId },
      orderBy: { createdAt: "desc" },
      select: { orderFingerprint: true },
    });
    if (last?.orderFingerprint === fingerprint) return { status: "skipped", reason: "already_reviewed" };
    const failures = await db.aiInteraction.count({
      where: { orderId, status: { not: "ok" }, createdAt: { gte: new Date(now.getTime() - 86_400_000) } },
    });
    if (failures >= MAX_FAILURES_PER_DAY) return { status: "skipped", reason: "recent_failures" };
  }

  const findings = (Array.isArray(check.findings) ? check.findings : []) as unknown as Finding[];
  const routing = (check.routing ?? {}) as unknown as Partial<RoutingDecision>;
  const address = (order.shippingAddress ?? null) as Record<string, unknown> | null;
  const original = (order.shippingAddressOriginal ?? null) as Record<string, unknown> | null;
  const normalised = (check.normalised ?? {}) as { phone?: unknown };

  // Customer history: the group's other orders with the same e-mail or phone.
  const or: Prisma.OrderWhereInput[] = [];
  if (order.email) or.push({ email: order.email });
  if (order.phone) or.push({ phone: order.phone });
  const history = or.length
    ? await db.order.groupBy({
        by: ["status"],
        where: { id: { not: order.id }, OR: or },
        _count: { _all: true },
      })
    : [];
  const countOf = (statuses: string[]) =>
    history.filter((h) => statuses.includes(h.status)).reduce((s, h) => s + h._count._all, 0);

  const similar = await similarCases(
    accountId,
    {
      countryCode: order.countryCode,
      paymentMethod: order.paymentMethod,
      phone: order.phone,
      address: {
        address1: str(address?.address1),
        address2: str(address?.address2),
        city: str(address?.city),
        zip: str(address?.zip),
      },
      findingCodes: findings.map((f) => f.code),
    },
    { k: 20, excludeOrderId: order.id },
  );

  const ctx: ReviewContext = {
    order: {
      number: order.number,
      status: order.status,
      countryCode: order.countryCode,
      currency: order.currency,
      total: Number(order.total),
      paymentMethod: order.paymentMethod,
      cod: {
        amount: num(order.codAmount),
        localAmount: num(order.codLocalAmount),
        localCurrency: order.codLocalCurrency,
      },
      customerName: order.customerName,
      phone: order.phone,
      normalisedPhone: str(normalised.phone),
      address,
      originalAddress: JSON.stringify(original) === JSON.stringify(address) ? null : original,
      lines: order.lines.map((l) => ({
        title: l.title,
        sku: l.sku,
        quantity: l.quantity,
        matched: !!l.productId,
      })),
      tags: order.tags,
      note: order.note,
      shopifyRisk: str((order.risk as { recommendation?: unknown } | null)?.recommendation),
    },
    routing: {
      connectionName: routing.connectionName ?? null,
      connectionType: routing.connectionType ?? null,
      via: routing.via ?? "none",
      explanation: routing.explanation?.en ?? null,
      stock: routing.stock?.status ?? null,
    },
    findings,
    customerHistory: {
      previousOrders: history.reduce((s, h) => s + h._count._all, 0),
      cancelled: countOf(["CANCELLED"]),
      returned: countOf(["RETURNING", "RETURN_RECEIVED"]),
      delivered: countOf(["DELIVERED", "COD_PAID"]),
    },
    similarCases: similar.cases,
  };

  // Clean orders (no finding at all) go to the cheap model; anything with a finding to the reviewer model.
  const models = aiModels();
  const cheap = findings.length === 0;
  const model = cheap ? models.cheap : models.reviewer;
  const body = reviewRequestBody(model, ctx, { cheap });
  const res = await client.send(body);

  let status = "ok";
  let error: string | null = null;
  let output: ReviewOutput | null = null;
  let parsed: MessageResponse | null = null;
  if (!res.ok) {
    status = res.status == null ? "network_error" : "api_error";
    error = res.error;
  } else {
    const r = MessageResponse.safeParse(res.body);
    if (!r.success) {
      status = "invalid_output";
      error = "response does not match the Messages API shape";
    } else {
      parsed = r.data;
      if (parsed.stop_reason === "refusal") {
        status = "refusal";
        error = "the model declined (stop_reason refusal)";
      } else {
        const call = parsed.content.find((b) => b.type === "tool_use" && b.name === REVIEW_TOOL_NAME);
        if (!call) {
          status = parsed.stop_reason === "max_tokens" ? "max_tokens" : "no_tool_call";
          error = `no ${REVIEW_TOOL_NAME} call (stop_reason ${parsed.stop_reason ?? "null"})`;
        } else {
          const o = ReviewOutput.safeParse(call.input);
          if (o.success) output = o.data;
          else {
            status = "invalid_output";
            error = o.error.issues
              .slice(0, 5)
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ");
          }
        }
      }
    }
  }

  const interaction = await db.aiInteraction.create({
    data: {
      accountId,
      orderId,
      purpose: "order_review",
      provider: client.provider,
      model,
      request: json(body),
      response: res.body === undefined ? undefined : json(res.body),
      status,
      error: error?.slice(0, 1000) ?? null,
      httpStatus: res.status,
      inputTokens: parsed?.usage?.input_tokens ?? null,
      outputTokens: parsed?.usage?.output_tokens ?? null,
      latencyMs: res.latencyMs,
    },
    select: { id: true },
  });
  if (!output) {
    logger.warn({ orderId, status, error }, "ai review failed");
    return { status: "failed", reason: status, interactionId: interaction.id };
  }

  const guarded = applyGuardrails(
    output,
    {
      total: Number(order.total),
      currency: order.currency,
      hardCount: check.hardCount,
      current: currentValues(order.shippingAddress, order.phone),
    },
    policy.thresholds,
  );
  const suggestion = await db.aiSuggestion.create({
    data: {
      accountId,
      orderId,
      interactionId: interaction.id,
      model: parsed?.model ?? model,
      decision: guarded.decision,
      confidence: output.confidence,
      fixes: json(guarded.fixes),
      flags: guarded.flags,
      explanationBg: output.explanation_bg,
      guardrails: guarded.guardrails,
      similarReviewIds: similar.cases.map((c) => c.reviewId),
      orderStatus: order.status,
      orderFingerprint: fingerprint,
      checkHardCount: check.hardCount,
      checkSoftCount: check.softCount,
    },
    select: { id: true },
  });
  const autopilot = policy.level === "L2" ? await tryAutopilot(accountId, suggestion.id, now) : null;
  return { status: "suggested", suggestionId: suggestion.id, autopilot };
}
