import { checkOrder } from "@/server/checks";
import { euTestGroup, euTestOrder } from "@/server/eushipments/test-fixtures";
import type { LlmClient, LlmResult } from "./llm";
import type { ReviewOutput } from "./reviewer-schema";
import { REVIEW_TOOL_NAME } from "./reviewer-schema";

/**
 * Test / e2e-seed helpers (synthetic data only; nothing calls Anthropic): a group with a checked order and a
 * mocked Messages API transport that answers with a submit_review tool call.
 */

export type AiTestGroup = Awaited<ReturnType<typeof euTestGroup>>;

export async function aiTestGroup(label: string) {
  const g = await euTestGroup(`ai-${label}`);
  await g.db.countrySetting.create({ data: { accountId: g.accountId, country: "BG", currency: "EUR" } });
  return g;
}

/** A checked order: clean (READY) or with a missing zip (hard finding, NEEDS_REVIEW). */
export async function checkedOrder(
  g: AiTestGroup,
  number: string,
  opts: { missingZip?: boolean; total?: string; phone?: string } = {},
) {
  const { order, product } = await euTestOrder(g, {
    number,
    phone: opts.phone ?? `0888 123 ${number.slice(-3)}`,
  });
  const vp = await g.db.vendorProduct.create({
    data: {
      accountId: g.accountId,
      connectionId: g.connection.id,
      productId: product.id,
      vendorId: `ref-${product.id}`,
    },
  });
  await g.db.stockLevel.create({
    data: {
      accountId: g.accountId,
      vendorProductId: vp.id,
      physical: 50,
      free: 50,
      sellable: 50,
      snapshotAt: new Date(),
      source: "POLL",
    },
  });
  const address = order.shippingAddress as Record<string, string | null>;
  await g.db.order.update({
    where: { id: order.id },
    data: {
      status: "IMPORTED",
      email: `buyer${number.replace(/\D/g, "")}@example.com`,
      shippingAddressOriginal: address,
      ...(opts.missingZip ? { shippingAddress: { ...address, zip: null } } : {}),
      ...(opts.total
        ? { total: opts.total, subtotal: opts.total, codAmount: opts.total, codLocalAmount: opts.total }
        : {}),
    },
  });
  if (opts.total)
    await g.db.orderLine.updateMany({
      where: { orderId: order.id },
      data: { unitPrice: (Number(opts.total) / 2).toFixed(2) },
    });
  await checkOrder(g.accountId, order.id, { actor: { kind: "system" } });
  return g.db.order.findUniqueOrThrow({ where: { id: order.id }, include: { check: true } });
}

export function toolAnswer(output: ReviewOutput | Record<string, unknown>, model = "claude-sonnet-5-5") {
  return {
    id: "msg_test_0001",
    type: "message",
    role: "assistant",
    model,
    stop_reason: "tool_use",
    content: [
      { type: "thinking", thinking: "", signature: "sig-test" },
      { type: "tool_use", id: "toolu_test_0001", name: REVIEW_TOOL_NAME, input: output },
    ],
    usage: { input_tokens: 1200, output_tokens: 180 },
  };
}

/** Mock transport: answers every request with `answer(body)` (default: a confident APPROVE). */
export function mockLlm(
  answer: (body: Record<string, unknown>) => LlmResult | ReviewOutput = () => ({
    decision: "APPROVE",
    confidence: 0.97,
    fixes: [],
    flags: [],
    explanation_bg: "Поръчката е чиста — адресът и телефонът са валидни.",
  }),
) {
  const requests: Record<string, unknown>[] = [];
  const client: LlmClient = {
    provider: "anthropic",
    async send(body) {
      requests.push(body);
      const a = answer(body);
      if ("ok" in a) return a;
      return { ok: true, status: 200, body: toolAnswer(a, String(body.model)), latencyMs: 12 };
    },
  };
  return { client, requests };
}
