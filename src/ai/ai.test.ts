import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { accountDb } from "@/server/db/client";
import { transitionOrder } from "@/server/pipeline";
import { decideOrder, editOrderAddress } from "@/server/review";
import { autopilotSuggestionData } from "./test-helpers";
import { caseText, phoneShape } from "./case-text";
import {
  embeddingProviders,
  hashEmbed,
  localHashProvider,
  setVoyageProviderForTests,
  voyageProvider,
} from "./embeddings";
import { compare, decideAuditSample, drawAuditSample, evaluateDecisions } from "./evaluate";
import { maskValue } from "./fields";
import { applyGuardrails, isHighValue } from "./guardrails";
import { anthropicHttpClient, ANTHROPIC_VERSION, MessageResponse, setLlmClientForTests } from "./llm";
import toolUseFixture from "./__fixtures__/anthropic-messages-tool-use.json";
import error400Fixture from "./__fixtures__/anthropic-error-400.json";
import { ReviewOutput, REVIEW_TOOL_NAME } from "./reviewer-schema";
import {
  ADDRESS_FIX_DECISION,
  AI_APPROVAL_DECISION,
  demotePolicy,
  demotionCause,
  enforcePolicies,
  listPolicies,
  promotePolicy,
  promotionCheck,
  saveThresholds,
  setAiKillSwitch,
  setPolicyEnabled,
  Thresholds,
} from "./policies";
import { REVIEWER_SYSTEM } from "./prompt";
import { embedPendingReviews, similarCases } from "./retrieval";
import { reviewOrder } from "./reviewer";
import { REVIEW_TOOL } from "./reviewer-schema";
import { reviewRequestBody } from "./prompt";
import {
  decideProposal,
  mineCorrections,
  mineRules,
  phonePrefixChange,
  zipFormatChange,
} from "./rule-mining";
import { aiTestGroup, checkedOrder, mockLlm, type AiTestGroup } from "./test-fixtures";
import { tryAutopilot } from "./autopilot";
import { aiDashboard, interactionDetail, listInteractions, orderAiCard } from "./views";

// Synthetic data only. Nothing calls Anthropic or Voyage: the transports are mocked.

afterEach(() => {
  setLlmClientForTests(null);
  setVoyageProviderForTests(undefined);
});

const defaults = Thresholds.parse({});

describe("embeddings and case text (pure)", () => {
  it("feature hashing is deterministic, 1024-dimensional and unit length", () => {
    const a = hashEmbed("country:HU*3 finding:order.phone_invalid*3");
    expect(a).toHaveLength(1024);
    expect(a).toEqual(hashEmbed("country:HU*3 finding:order.phone_invalid*3"));
    expect(Math.sqrt(a.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
    const b = hashEmbed("country:HU*3 finding:order.phone_invalid*3 payment:COD");
    const c = hashEmbed("country:RO*3 finding:order.address.zip_missing*3 payment:PREPAID");
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(dot(a, b)).toBeGreaterThan(dot(a, c));
  });

  it("the case text holds shapes, never the customer's name, street or full phone", () => {
    const t = caseText({
      countryCode: "hu",
      paymentMethod: "COD",
      phone: "06 30 123 4567",
      address: { address1: "Minta utca 12", city: "Budapest", zip: "1051" },
      findingCodes: ["order.phone_invalid"],
      correctedFields: ["phone"],
    });
    expect(t).toContain("country:HU");
    expect(t).toContain("zip_shape:9999");
    expect(t).toContain("finding:order.phone_invalid");
    expect(t).not.toMatch(/Minta|1234567|301234567/);
    expect(phoneShape("+36 30 123 4567")).toEqual(["phone_prefix:+36", "phone_len:11", "phone_intl:yes"]);
  });

  it("masks personal values of other customers' cases", () => {
    expect(maskValue("phone", "06301234567")).toBe("0630•••••67");
    expect(maskValue("shippingAddress.zip", "1051")).toBe("1051");
  });

  it("Voyage provider sends the documented request (mocked fetch) and checks the dimension", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          data: [{ object: "embedding", embedding: new Array(1024).fill(0.01), index: 0 }],
          model: "voyage-3.5",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const p = voyageProvider("voyage-test-key-not-real", { fetchImpl });
    const [v] = await p.embed(["country:BG"], "query");
    expect(v).toHaveLength(1024);
    expect(calls[0]!.url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      input: ["country:BG"],
      model: "voyage-3.5",
      input_type: "query",
      output_dimension: 1024,
    });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer voyage-test-key-not-real",
    );
  });

  it("without VOYAGE_API_KEY only the local provider is used", () => {
    delete process.env.VOYAGE_API_KEY;
    expect(embeddingProviders().map((p) => p.name)).toEqual(["local-hash"]);
  });
});

describe("Anthropic HTTP client (mocked fetch)", () => {
  it("sends the version header and key, retries 429/5xx, and never exposes the key in results", async () => {
    let n = 0;
    const seen: Record<string, string>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      n++;
      if (n === 1)
        return new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }), {
          status: 429,
        });
      if (n === 2) return new Response("upstream", { status: 529 });
      return new Response(
        JSON.stringify({ id: "msg_1", model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const c = anthropicHttpClient("sk-ant-test-not-real", { fetchImpl, baseDelayMs: 1 });
    const r = await c.send({ model: "claude-sonnet-5-5", fallbacks: "default", messages: [] });
    expect(r.ok).toBe(true);
    expect(n).toBe(3);
    expect(seen[0]).toMatchObject({
      "x-api-key": "sk-ant-test-not-real",
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": "server-side-fallback-2026-07-01",
    });
    expect(JSON.stringify(r)).not.toContain("sk-ant-test");
  });

  it("does not retry a 400 and returns the API's error message", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "bad tool" } }), {
        status: 400,
      });
    }) as unknown as typeof fetch;
    const r = await anthropicHttpClient("k", { fetchImpl, baseDelayMs: 1 }).send({});
    expect(n).toBe(1);
    expect(r).toMatchObject({ ok: false, status: 400, error: "invalid_request_error: bad tool" });
  });

  it("stops retrying once the overall deadline is spent (the ai.review job must never outlive a call)", async () => {
    let clock = 0;
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      clock += 120_000; // every attempt takes 120 s (a timeout)
      return new Response("overloaded", { status: 529 });
    }) as unknown as typeof fetch;
    const r = await anthropicHttpClient("k", {
      fetchImpl,
      baseDelayMs: 1,
      deadlineMs: 240_000,
      now: () => clock,
    }).send({});
    expect(n).toBe(2); // not 3: the third attempt would start past the deadline
    expect(r).toMatchObject({ ok: false, status: 529 });
    expect(r.latencyMs).toBeLessThanOrEqual(240_000);
  });

  it("the ai.review job expiry is above the client's overall deadline", async () => {
    const { QUEUES } = await import("@/server/jobs/queues");
    const { LLM_DEADLINE_MS } = await import("./llm");
    expect(QUEUES.aiReview.options.expireInSeconds * 1000).toBeGreaterThan(LLM_DEADLINE_MS + 60_000);
  });

  it("the review tool is strict and the system prompt is frozen (cacheable)", () => {
    expect(REVIEW_TOOL.strict).toBe(true);
    expect(REVIEW_TOOL.input_schema.additionalProperties).toBe(false);
    expect(REVIEW_TOOL.input_schema.properties.fixes.items.properties.field.enum).not.toContain(
      "shippingAddress.name",
    );
    expect(REVIEWER_SYSTEM).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe("Messages API reference shape (docs/integrations/anthropic.md)", () => {
  it("the documented tool_use response parses and carries a valid review", () => {
    const r = MessageResponse.parse(toolUseFixture);
    expect(r.stop_reason).toBe("tool_use");
    expect(r.usage).toMatchObject({ input_tokens: 2048, output_tokens: 156 });
    const call = r.content.find((b) => b.type === "tool_use" && b.name === REVIEW_TOOL_NAME);
    expect(ReviewOutput.safeParse((call as { input?: unknown }).input).success).toBe(true);
  });

  it("the documented error body becomes the logged error message, no retry", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return new Response(JSON.stringify(error400Fixture), { status: 400 });
    }) as unknown as typeof fetch;
    const r = await anthropicHttpClient("k", { fetchImpl, baseDelayMs: 1 }).send({});
    expect(n).toBe(1);
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^invalid_request_error: tool_choice/),
    });
  });

  it("the request body uses only the fields quoted in the reference", () => {
    const ctx = {
      order: {},
      routing: {},
      findings: [],
      customerHistory: {},
      similarCases: [],
    } as unknown as Parameters<typeof reviewRequestBody>[1];
    const allowed = [
      "model",
      "max_tokens",
      "system",
      "tools",
      "tool_choice",
      "output_config",
      "fallbacks",
      "messages",
    ];
    const sonnet = reviewRequestBody("claude-sonnet-5-5", ctx, { cheap: false });
    const haiku = reviewRequestBody("claude-haiku-5-5", ctx, { cheap: true });
    for (const b of [sonnet, haiku]) for (const k of Object.keys(b)) expect(allowed).toContain(k);
    expect(sonnet).toMatchObject({ fallbacks: "default", output_config: { effort: "medium" } });
    expect(haiku).not.toHaveProperty("fallbacks");
    expect(haiku).toMatchObject({ output_config: { effort: "low" }, tool_choice: { type: "auto" } });
    for (const k of ["temperature", "top_p", "top_k", "thinking"]) expect(sonnet).not.toHaveProperty(k);
  });
});

describe("guardrails, comparison, policy rules (pure)", () => {
  const ctx = {
    total: 40,
    currency: "EUR",
    hardCount: 0,
    current: { phone: "0888123456", "shippingAddress.zip": null },
  };

  it("drops fixes of the recipient's identity and COD; a decision left without fixes becomes HOLD", () => {
    const g = applyGuardrails(
      {
        decision: "EDIT_AND_APPROVE",
        confidence: 0.9,
        fixes: [
          { field: "shippingAddress.name", from: "A", to: "B", reason: "x" },
          { field: "codAmount", from: "40", to: "0", reason: "x" },
        ],
        flags: [],
        explanation_bg: "x",
      },
      ctx,
      defaults,
    );
    expect(g.decision).toBe("HOLD");
    expect(g.fixes).toEqual([]);
    expect(g.guardrails).toEqual([
      "fix_dropped:shippingAddress.name",
      "fix_dropped:codAmount",
      "fixes_dropped_hold",
    ]);
  });

  it("APPROVE with a fix is EDIT_AND_APPROVE; `from` is the order's current value; hard findings never approve", () => {
    const g = applyGuardrails(
      {
        decision: "APPROVE",
        confidence: 0.9,
        fixes: [{ field: "shippingAddress.zip", from: "zzz", to: "1000", reason: "Sofia" }],
        flags: [],
        explanation_bg: "x",
      },
      ctx,
      defaults,
    );
    expect(g).toMatchObject({
      decision: "EDIT_AND_APPROVE",
      fixes: [{ field: "shippingAddress.zip", from: null, to: "1000" }],
    });
    const h = applyGuardrails(
      { decision: "APPROVE", confidence: 1, fixes: [], flags: [], explanation_bg: "x" },
      { ...ctx, hardCount: 1 },
      defaults,
    );
    expect(h).toMatchObject({ decision: "HOLD", guardrails: ["hard_findings_hold"] });
  });

  it("high value: at or above the amount, or a currency without an amount", () => {
    expect(isHighValue(299.99, "EUR", defaults)).toBe(false);
    expect(isHighValue(300, "EUR", defaults)).toBe(true);
    expect(isHighValue(1, "USD", defaults)).toBe(true);
  });

  it("compares decisions by class, fixes by value, and flags confident wrong approvals as critical", () => {
    expect(
      compare({ decision: "APPROVE", confidence: 0.99, fixes: [] }, { decision: "APPROVE", diff: [] }, 0.95),
    ).toEqual({
      decisionAgreed: true,
      fixesAgreed: true,
      criticalMiss: false,
    });
    expect(
      compare(
        { decision: "EDIT_AND_APPROVE", confidence: 0.9, fixes: [{ field: "phone", to: "+36301234567" }] },
        {
          decision: "EDIT_AND_APPROVE",
          diff: [{ field: "phone", from: "06301234567", to: "+36 301234567" }],
        },
        0.95,
      ).fixesAgreed,
    ).toBe(false);
    expect(
      compare({ decision: "APPROVE", confidence: 0.96, fixes: [] }, { decision: "HOLD", diff: [] }, 0.95),
    ).toMatchObject({
      decisionAgreed: false,
      criticalMiss: true,
    });
    expect(
      compare({ decision: "APPROVE", confidence: 0.6, fixes: [] }, { decision: "CANCEL", diff: [] }, 0.95)
        .criticalMiss,
    ).toBe(false);
  });

  it("AI-applied fixes (L1 one click) are not counted as the operator agreeing with the AI", () => {
    const ai = {
      decision: "EDIT_AND_APPROVE",
      confidence: 0.9,
      fixes: [{ field: "phone", to: "+36301234567" }],
    };
    // Only the AI's own fix, applied by the button: no independent evidence → not measured.
    expect(
      compare(
        ai,
        {
          decision: "EDIT_AND_APPROVE",
          diff: [
            { field: "phone", from: "06301234567", to: "+36301234567", via: "suggested_fix:ai.reviewer" },
          ],
        },
        0.95,
      ).fixesAgreed,
    ).toBeNull();
    // The AI's fix applied, but the operator also had to correct another field the AI missed → disagreement.
    expect(
      compare(
        ai,
        {
          decision: "EDIT_AND_APPROVE",
          diff: [
            { field: "phone", from: "06301234567", to: "+36301234567", via: "suggested_fix:ai.reviewer" },
            { field: "shippingAddress.zip", from: null, to: "1000", via: "manual" },
          ],
        },
        0.95,
      ).fixesAgreed,
    ).toBe(false);
    // Typed by the operator with the same value: real agreement.
    expect(
      compare(
        ai,
        {
          decision: "EDIT_AND_APPROVE",
          diff: [{ field: "phone", from: "06301234567", to: "+36301234567", via: "manual" }],
        },
        0.95,
      ).fixesAgreed,
    ).toBe(true);
  });

  it("promotion needs ≥300 decisions, ≥98% agreement and zero critical misses; L2 is the ceiling", () => {
    const p = { level: "L0" as const, enabled: true, maxLevel: "L2" as const, thresholds: defaults };
    expect(promotionCheck(p, { decisions: 300, agreement: 0.98, criticalMisses: 0 })).toEqual({
      eligible: true,
      next: "L1",
      missing: [],
    });
    expect(promotionCheck(p, { decisions: 299, agreement: 1, criticalMisses: 0 }).missing).toEqual([
      "decisions",
    ]);
    expect(promotionCheck(p, { decisions: 400, agreement: 0.979, criticalMisses: 0 }).missing).toEqual([
      "agreement",
    ]);
    expect(promotionCheck(p, { decisions: 400, agreement: 1, criticalMisses: 1 }).missing).toEqual([
      "critical",
    ]);
    expect(
      promotionCheck({ ...p, level: "L2" }, { decisions: 400, agreement: 1, criticalMisses: 0 }).missing,
    ).toEqual(["max_level"]);
    expect(promotionCheck(p, { decisions: 400, agreement: 1, criticalMisses: 0 }, true).missing).toEqual([
      "stopped",
    ]);
  });

  it("demotion: any critical miss since the level change, or agreement below the threshold with enough sample", () => {
    const p = { level: "L2" as const, enabled: true, thresholds: defaults };
    expect(demotionCause(p, { decisions: 10, agreement: 1, criticalSinceLevel: 1 })).toBe("demote_critical");
    expect(demotionCause(p, { decisions: 60, agreement: 0.9, criticalSinceLevel: 0 })).toBe(
      "demote_agreement",
    );
    expect(demotionCause(p, { decisions: 10, agreement: 0.5, criticalSinceLevel: 0 })).toBeNull();
    expect(
      demotionCause({ ...p, level: "L0" }, { decisions: 60, agreement: 0, criticalSinceLevel: 3 }),
    ).toBeNull();
    // A paused policy is judged too (re-enabling must not restore L2 after a miss during the pause).
    expect(
      demotionCause({ ...p, enabled: false }, { decisions: 10, agreement: 1, criticalSinceLevel: 1 }),
    ).toBe("demote_critical");
  });

  it("thresholds can be made stricter, never looser than the SPEC", () => {
    expect(() => Thresholds.parse({ minDecisions: 100 })).toThrow();
    expect(() => Thresholds.parse({ minAgreement: 0.9 })).toThrow();
    expect(Thresholds.parse({ minDecisions: 500 }).minDecisions).toBe(500);
  });
});

describe("rule mining (pure)", () => {
  it("finds phone prefix and zip format changes", () => {
    expect(phonePrefixChange("06 30 123 4567", "+36301234567")).toEqual({ from: "06", to: "+36" });
    expect(phonePrefixChange("0888123456", "0888123457")).toBeNull();
    expect(zipFormatChange("12345", "123 45")).toEqual({ from: "99999", to: "999 99" });
    expect(zipFormatChange("12345", "12346")).toBeNull();
  });

  it("clusters repeated corrections, needs enough distinct orders, masks examples", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      orderId: `o${i % 5}`,
      countryCode: "HU",
      decidedAt: new Date(`2026-10-0${i + 1}T10:00:00Z`),
      change: { field: "phone" as const, from: `0630${1000000 + i}`, to: `+3630${1000000 + i}` },
    }));
    const [c, ...rest] = mineCorrections(rows, 5);
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      key: "phone_prefix:HU:06→+36",
      support: 6,
      titleEn: "HU: phones starting 06 → +36",
    });
    expect(c!.orderIds.size).toBe(5);
    expect(c!.examples[0]!.from).toContain("•");
    expect(mineCorrections(rows.slice(0, 4), 5)).toEqual([]);
  });
});

// ───────────────────────── database ─────────────────────────

describe("AI reviewer, retrieval, policies, autopilot (database)", () => {
  let g: AiTestGroup;
  let other: AiTestGroup;
  const enable = () => setPolicyEnabled(g.owner, AI_APPROVAL_DECISION, true);

  beforeAll(async () => {
    g = await aiTestGroup("main");
    other = await aiTestGroup("other");
  });

  it("is off without a model transport (no ANTHROPIC_API_KEY) and without an enabled policy", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const o = await checkedOrder(g, "#7001");
    expect(await reviewOrder(g.accountId, o.id)).toEqual({ status: "skipped", reason: "ai_off" });
    setLlmClientForTests(mockLlm().client);
    expect(await reviewOrder(g.accountId, o.id)).toEqual({ status: "skipped", reason: "policy_off" });
    expect(await g.db.aiInteraction.count()).toBe(0);
  });

  it("reviews a clean order with the cheap model, logs prompt and response, stores the suggestion once", async () => {
    await enable();
    const m = mockLlm();
    setLlmClientForTests(m.client);
    const o = await checkedOrder(g, "#7002");
    expect(o.status).toBe("READY");
    const r = await reviewOrder(g.accountId, o.id);
    expect(r.status).toBe("suggested");
    expect(m.requests).toHaveLength(1);
    const body = m.requests[0]!;
    expect(body).toMatchObject({ model: "claude-haiku-5-5", tool_choice: { type: "auto" } });
    expect(body).not.toHaveProperty("fallbacks"); // no server-side fallback on Haiku
    expect(body).not.toHaveProperty("temperature");
    expect(JSON.stringify(body)).toContain("#7002");
    const log = await g.db.aiInteraction.findFirstOrThrow({ where: { orderId: o.id } });
    expect(log).toMatchObject({
      status: "ok",
      model: "claude-haiku-5-5",
      inputTokens: 1200,
      outputTokens: 180,
      purpose: "order_review",
    });
    expect(log.request).toEqual(JSON.parse(JSON.stringify(body)));
    const s = await g.db.aiSuggestion.findFirstOrThrow({ where: { orderId: o.id } });
    expect(s).toMatchObject({
      decision: "APPROVE",
      confidence: 0.97,
      orderStatus: "READY",
      checkHardCount: 0,
    });
    // Nothing was approved or sent: L0 only suggests.
    expect((await g.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("READY");
    expect(await reviewOrder(g.accountId, o.id)).toEqual({ status: "skipped", reason: "already_reviewed" });
  });

  it("two runs of the same order version at once store one suggestion (expired-and-requeued job)", async () => {
    const m = mockLlm();
    const slow = {
      provider: "anthropic",
      async send(body: Record<string, unknown>) {
        await new Promise((r) => setTimeout(r, 50));
        return m.client.send(body);
      },
    };
    setLlmClientForTests(slow);
    const o = await checkedOrder(g, "#7020");
    const [r1, r2] = await Promise.all([reviewOrder(g.accountId, o.id), reviewOrder(g.accountId, o.id)]);
    expect(m.requests).toHaveLength(2); // both were already waiting on the model
    expect([r1.status, r2.status].sort()).toEqual(["skipped", "suggested"]);
    expect(await g.db.aiSuggestion.count({ where: { orderId: o.id } })).toBe(1);
  });

  it("an order with findings goes to the reviewer model with server-side fallback; fixes are guarded", async () => {
    const m = mockLlm(() => ({
      decision: "EDIT_AND_APPROVE",
      confidence: 0.8,
      fixes: [
        { field: "shippingAddress.zip", from: null, to: "1000", reason: "Пощенски код на София" },
        { field: "shippingAddress.name", from: "Test Buyer", to: "Other Person", reason: "x" },
      ],
      flags: [],
      explanation_bg: "Липсва пощенски код — 1000 за София.",
    }));
    setLlmClientForTests(m.client);
    const o = await checkedOrder(g, "#7003", { missingZip: true });
    expect(o.status).toBe("NEEDS_REVIEW");
    await reviewOrder(g.accountId, o.id);
    expect(m.requests[0]).toMatchObject({ model: "claude-sonnet-5-5", fallbacks: "default" });
    const s = await g.db.aiSuggestion.findFirstOrThrow({ where: { orderId: o.id } });
    expect(s.decision).toBe("EDIT_AND_APPROVE");
    expect(s.fixes).toEqual([
      { field: "shippingAddress.zip", from: null, to: "1000", reason: "Пощенски код на София" },
    ]);
    expect(s.guardrails).toContain("fix_dropped:shippingAddress.name");
  });

  it("refusals, missing tool calls and malformed output are logged and never become suggestions", async () => {
    const answers = [
      {
        ok: true as const,
        status: 200,
        latencyMs: 1,
        body: { id: "m", model: "claude-haiku-5-5", stop_reason: "refusal", content: [] },
      },
      {
        ok: true as const,
        status: 200,
        latencyMs: 1,
        body: {
          id: "m",
          model: "claude-haiku-5-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "ok" }],
        },
      },
      {
        ok: true as const,
        status: 200,
        latencyMs: 1,
        body: {
          id: "m",
          model: "claude-haiku-5-5",
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", name: "submit_review", input: { decision: "APPROVE", confidence: 7 } },
          ],
        },
      },
      { ok: false as const, status: 500, latencyMs: 1, body: null, error: "HTTP 500" },
    ];
    const statuses = ["refusal", "no_tool_call", "invalid_output", "api_error"];
    for (const [i, a] of answers.entries()) {
      setLlmClientForTests(mockLlm(() => a).client);
      const o = await checkedOrder(g, `#71${i}0`);
      const r = await reviewOrder(g.accountId, o.id);
      expect(r).toMatchObject({ status: "failed", reason: statuses[i] });
      expect(await g.db.aiSuggestion.count({ where: { orderId: o.id } })).toBe(0);
      expect((await g.db.aiInteraction.findFirstOrThrow({ where: { orderId: o.id } })).status).toBe(
        statuses[i],
      );
    }
  });

  it("embeds decided reviews and retrieves similar cases of the same group only", async () => {
    // Decided reviews in both groups: HU-like phone fixes on missing-zip orders.
    for (const grp of [g, other]) {
      if (grp === other) await setPolicyEnabled(other.owner, AI_APPROVAL_DECISION, true);
      for (const n of ["1", "2", "3"]) {
        const o = await checkedOrder(grp, `#72${grp === g ? "0" : "9"}${n}`, { missingZip: true });
        await editOrderAddress(grp.owner, o.id, {
          values: { zip: "1000" },
          version: o.updatedAt.toISOString(),
        });
        await decideOrder(grp.owner, { orderId: o.id, decision: "approve", reasonCode: "address_fixed" });
      }
    }
    expect(await embedPendingReviews(g.accountId)).toBeGreaterThanOrEqual(3);
    expect(await embedPendingReviews(g.accountId)).toBe(0); // idempotent
    await embedPendingReviews(other.accountId);
    const probe = await checkedOrder(g, "#7210", { missingZip: true });
    const res = await similarCases(
      g.accountId,
      {
        countryCode: "BG",
        paymentMethod: "COD",
        phone: probe.phone,
        address: { zip: null, city: "Sofia", address1: "Example Street 12" },
        findingCodes: ["order.address.zip_missing"],
      },
      { k: 20, excludeOrderId: probe.id },
    );
    expect(res.provider).toBe("local-hash");
    expect(res.cases.length).toBeGreaterThanOrEqual(3);
    const ownReviews = await g.db.review.findMany({ select: { id: true } });
    const own = new Set(ownReviews.map((r) => r.id));
    expect(res.cases.every((c) => own.has(c.reviewId))).toBe(true); // never another group's
    expect(res.cases[0]!.corrections).toEqual([{ field: "shippingAddress.zip", from: null, to: "1000" }]);
    // The reviewer passes them to the model.
    const m = mockLlm();
    setLlmClientForTests(m.client);
    await reviewOrder(g.accountId, probe.id);
    const s = await g.db.aiSuggestion.findFirstOrThrow({ where: { orderId: probe.id } });
    expect(s.similarReviewIds.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(m.requests[0])).toContain("similar_cases");
  });

  it("measures agreement against the human decision and copies the suggestion onto the Review", async () => {
    setLlmClientForTests(
      mockLlm(() => ({
        decision: "APPROVE",
        confidence: 0.99,
        fixes: [],
        flags: [],
        explanation_bg: "Чиста.",
      })).client,
    );
    const agree = await checkedOrder(g, "#7301");
    const miss = await checkedOrder(g, "#7302");
    await reviewOrder(g.accountId, agree.id);
    await reviewOrder(g.accountId, miss.id);
    await decideOrder(g.owner, { orderId: agree.id, decision: "approve" });
    await decideOrder(g.owner, { orderId: miss.id, decision: "hold", reasonCode: "customer_contact" }).catch(
      async () =>
        decideOrder(g.owner, {
          orderId: miss.id,
          decision: "hold",
          reasonCode: "other",
          reasonText: "check",
        }),
    );
    expect(await evaluateDecisions(g.accountId)).toBeGreaterThanOrEqual(2);
    const a = await g.db.aiSuggestion.findFirstOrThrow({ where: { orderId: agree.id } });
    expect(a).toMatchObject({
      decisionAgreed: true,
      fixesAgreed: true,
      criticalMiss: false,
      humanDecision: "APPROVE",
    });
    const b = await g.db.aiSuggestion.findFirstOrThrow({ where: { orderId: miss.id } });
    expect(b).toMatchObject({ decisionAgreed: false, criticalMiss: true, humanDecision: "HOLD" });
    const review = await g.db.review.findFirstOrThrow({
      where: { orderId: agree.id, decision: { not: null } },
    });
    expect(review.aiConfidence).toBe(0.99);
    expect(await evaluateDecisions(g.accountId)).toBe(0); // idempotent
  });

  it("promotion is refused until the rule holds, then goes one level at a time; only an OWNER", async () => {
    const p = await aiTestGroup("promo");
    await setPolicyEnabled(p.owner, AI_APPROVAL_DECISION, true);
    await expect(promotePolicy(p.owner, AI_APPROVAL_DECISION)).rejects.toMatchObject({
      code: expect.stringContaining("not_eligible"),
    });
    await expect(setPolicyEnabled({ ...p.owner, role: "ADMIN" }, AI_APPROVAL_DECISION, true)).rejects.toThrow(
      /ai.manage/,
    );
    const o = await checkedOrder(p, "#7401");
    await p.db.aiSuggestion.createMany({
      data: Array.from({ length: 300 }, () =>
        autopilotSuggestionData(p.accountId, o.id, {
          evaluatedAt: new Date(),
          decisionAgreed: true,
          fixesAgreed: true,
        }),
      ),
    });
    await promotePolicy(p.owner, AI_APPROVAL_DECISION);
    await promotePolicy(p.owner, AI_APPROVAL_DECISION);
    const [approval] = await listPolicies(p.accountId);
    expect(approval).toMatchObject({ level: "L2", enabled: true });
    await expect(promotePolicy(p.owner, AI_APPROVAL_DECISION)).rejects.toMatchObject({
      code: expect.stringContaining("max_level"),
    });
    // address_fix stops at L1.
    await setPolicyEnabled(p.owner, ADDRESS_FIX_DECISION, true);
    await promotePolicy(p.owner, ADDRESS_FIX_DECISION);
    await expect(promotePolicy(p.owner, ADDRESS_FIX_DECISION)).rejects.toMatchObject({
      code: expect.stringContaining("max_level"),
    });
    expect(await p.db.aiPolicyEvent.count({ where: { cause: "promote" } })).toBe(3);
    expect(await p.db.auditLog.count({ where: { action: "ai.policy.promote" } })).toBe(3);
    await demotePolicy(p.owner, AI_APPROVAL_DECISION, "L1");
    expect((await listPolicies(p.accountId))[0]!.level).toBe("L1");
    await expect(saveThresholds(p.owner, AI_APPROVAL_DECISION, { minAgreement: 0.5 })).rejects.toThrow();
  });

  describe("L2 autopilot", () => {
    let a: AiTestGroup;
    beforeAll(async () => {
      a = await aiTestGroup("auto");
      await setPolicyEnabled(a.owner, AI_APPROVAL_DECISION, true);
      const seed = await checkedOrder(a, "#7500");
      await a.db.aiSuggestion.createMany({
        data: Array.from({ length: 300 }, () =>
          autopilotSuggestionData(a.accountId, seed.id, { evaluatedAt: new Date(), decisionAgreed: true }),
        ),
      });
      await promotePolicy(a.owner, AI_APPROVAL_DECISION);
      await promotePolicy(a.owner, AI_APPROVAL_DECISION);
    });

    it("approves a clean READY order through the pipeline with an AI actor — and sends nothing", async () => {
      setLlmClientForTests(mockLlm().client);
      const o = await checkedOrder(a, "#7501");
      const r = await reviewOrder(a.accountId, o.id);
      expect(r).toMatchObject({ status: "suggested", autopilot: { approved: true } });
      expect((await a.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("APPROVED");
      const ev = await a.db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, cause: "approve" } });
      expect(ev).toMatchObject({ actorType: "ai", source: "ai.autopilot" });
      expect((ev.meta as { aiLevel: string }).aiLevel).toBe("L2");
      expect(await a.db.fulfillment.count({ where: { orderId: o.id } })).toBe(0);
      expect(await a.db.outboundRequest.count({ where: { connectionId: a.connection.id } })).toBe(0);
      expect(await a.db.auditLog.count({ where: { action: "ai.autopilot_approved", entityId: o.id } })).toBe(
        1,
      );
    });

    it("never: low confidence, NEEDS_REVIEW, high value, flags, changed order, or the stop switch", async () => {
      setLlmClientForTests(
        mockLlm(() => ({ decision: "APPROVE", confidence: 0.9, fixes: [], flags: [], explanation_bg: "x" }))
          .client,
      );
      const low = await checkedOrder(a, "#7502");
      expect(await reviewOrder(a.accountId, low.id)).toMatchObject({
        autopilot: { approved: false, reason: "low_confidence" },
      });

      setLlmClientForTests(
        mockLlm(() => ({
          decision: "APPROVE",
          confidence: 0.99,
          fixes: [],
          flags: ["fraud_risk"],
          explanation_bg: "x",
        })).client,
      );
      const flagged = await checkedOrder(a, "#7503");
      expect(await reviewOrder(a.accountId, flagged.id)).toMatchObject({
        autopilot: { approved: false, reason: "has_flags" },
      });

      setLlmClientForTests(mockLlm().client);
      const rich = await checkedOrder(a, "#7504", { total: "900.00" });
      expect(await reviewOrder(a.accountId, rich.id)).toMatchObject({
        autopilot: { approved: false, reason: "guardrail" },
      });

      const zip = await checkedOrder(a, "#7505", { missingZip: true });
      expect(zip.status).toBe("NEEDS_REVIEW");
      expect(await reviewOrder(a.accountId, zip.id)).toMatchObject({ autopilot: { approved: false } });

      const changed = await checkedOrder(a, "#7506");
      const s = (
        await a.db.aiSuggestion.create({
          data: {
            ...autopilotSuggestionData(a.accountId, changed.id),
            orderFingerprint: (changed.check!.normalised as { orderFingerprint: string }).orderFingerprint,
          },
        })
      ).id;
      await a.db.order.update({ where: { id: changed.id }, data: { phone: "0888 999 000" } });
      expect(await tryAutopilot(a.accountId, s)).toMatchObject({ approved: false, reason: "order_changed" });

      await setAiKillSwitch(a.owner, true, "test");
      const stopped = await checkedOrder(a, "#7507");
      expect(await reviewOrder(a.accountId, stopped.id)).toEqual({ status: "skipped", reason: "ai_stopped" });
      // Even a direct AI transition is refused inside the pipeline while stopped.
      const policy = await a.db.aiPolicy.findFirstOrThrow({ where: { decisionType: AI_APPROVAL_DECISION } });
      await expect(
        transitionOrder(a.accountId, {
          orderId: stopped.id,
          to: "APPROVED",
          cause: "approve",
          actor: { kind: "ai", level: "L2", policyId: policy.id },
        }),
      ).rejects.toMatchObject({ code: "transition_guard:ai_stopped" });
      await setAiKillSwitch(a.owner, false);
      for (const o of [low, flagged, rich, zip, changed, stopped])
        expect((await a.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).not.toBe("APPROVED");
      expect(await a.db.auditLog.count({ where: { action: "ai.kill_switch.on" } })).toBe(1);
    });

    it("the pipeline refuses an AI approval from a policy below L2 and of a NEEDS_REVIEW order", async () => {
      const b = await aiTestGroup("l1");
      const pol = await setPolicyEnabled(b.owner, AI_APPROVAL_DECISION, true);
      const o = await checkedOrder(b, "#7601");
      await expect(
        transitionOrder(b.accountId, {
          orderId: o.id,
          to: "APPROVED",
          cause: "approve",
          actor: { kind: "ai", level: "L2", policyId: pol.id },
        }),
      ).rejects.toMatchObject({ code: "transition_guard:ai_policy_not_l2" });
      const policy = await a.db.aiPolicy.findFirstOrThrow({ where: { decisionType: AI_APPROVAL_DECISION } });
      const hard = await checkedOrder(a, "#7602", { missingZip: true });
      await expect(
        transitionOrder(a.accountId, {
          orderId: hard.id,
          to: "APPROVED",
          cause: "approve",
          actor: { kind: "ai", level: "L2", policyId: policy.id },
        }),
      ).rejects.toMatchObject({ code: "transition_guard:hard_findings" });
      // A clean check but waiting for a person (NEEDS_REVIEW): the AI may approve READY orders only.
      const clean = await checkedOrder(a, "#7603");
      await a.db.order.update({ where: { id: clean.id }, data: { status: "NEEDS_REVIEW" } });
      await expect(
        transitionOrder(a.accountId, {
          orderId: clean.id,
          to: "APPROVED",
          cause: "approve",
          actor: { kind: "ai", level: "L2", policyId: policy.id },
        }),
      ).rejects.toMatchObject({ code: "transition_guard:ai_not_ready" });
      // A person still can.
      await transitionOrder(a.accountId, {
        orderId: clean.id,
        to: "APPROVED",
        cause: "approve",
        actor: { kind: "user", userId: a.owner.userId },
      });
    });

    it("the pipeline guard refuses an AI approval of a high-value READY order", async () => {
      const policy = await a.db.aiPolicy.findFirstOrThrow({ where: { decisionType: AI_APPROVAL_DECISION } });
      const rich = await checkedOrder(a, "#7610", { total: "900.00" });
      expect(rich.status).toBe("READY");
      await expect(
        transitionOrder(a.accountId, {
          orderId: rich.id,
          to: "APPROVED",
          cause: "approve",
          actor: { kind: "ai", level: "L2", policyId: policy.id },
        }),
      ).rejects.toMatchObject({ code: "transition_guard:ai_high_value" });
      // The in-transaction check of tryAutopilot too (a suggestion without the high_value guardrail tag).
      const s = await a.db.aiSuggestion.create({
        data: {
          ...autopilotSuggestionData(a.accountId, rich.id),
          orderFingerprint: (rich.check!.normalised as { orderFingerprint: string }).orderFingerprint,
        },
      });
      expect(await tryAutopilot(a.accountId, s.id)).toEqual({ approved: false, reason: "high_value" });
      expect((await a.db.order.findUniqueOrThrow({ where: { id: rich.id } })).status).toBe("READY");
    });

    it("the same suggestion sent to autopilot twice at once approves once", async () => {
      const o = await checkedOrder(a, "#7611");
      const s = await a.db.aiSuggestion.create({
        data: {
          ...autopilotSuggestionData(a.accountId, o.id),
          orderFingerprint: (o.check!.normalised as { orderFingerprint: string }).orderFingerprint,
        },
      });
      const results = await Promise.all([tryAutopilot(a.accountId, s.id), tryAutopilot(a.accountId, s.id)]);
      expect(results.filter((r) => r.approved)).toHaveLength(1);
      expect(await a.db.orderEvent.count({ where: { orderId: o.id, cause: "approve" } })).toBe(1);
      expect(await a.db.auditLog.count({ where: { action: "ai.autopilot_approved", entityId: o.id } })).toBe(
        1,
      );
    });

    it("daily audit sample; a rejected sample is a critical miss and drops the policy to L0 with an alert", async () => {
      const yesterday = new Date(Date.now() - 86_400_000);
      await a.db.aiSuggestion.updateMany({
        where: { autoApprovedAt: { not: null } },
        data: { autoApprovedAt: yesterday },
      });
      const n = await drawAuditSample(a.accountId);
      expect(n).toBe(1);
      expect(await drawAuditSample(a.accountId)).toBe(0); // once per day
      const sample = await a.db.aiAuditSample.findFirstOrThrow();
      await expect(decideAuditSample(a.owner, sample.id, "reject", "")).rejects.toMatchObject({
        code: "note_required",
      });
      await decideAuditSample(a.owner, sample.id, "reject", "Адресът беше непълен");
      const policy = await a.db.aiPolicy.findFirstOrThrow({ where: { decisionType: AI_APPROVAL_DECISION } });
      expect(policy.level).toBe("L0");
      expect(await a.db.aiPolicyEvent.count({ where: { cause: "demote_critical" } })).toBe(1);
      expect(await a.db.alert.count({ where: { kind: "ai_policy_demoted" } })).toBe(1);
      await expect(decideAuditSample(a.owner, sample.id, "confirm")).rejects.toMatchObject({
        code: "already_decided",
      });
      expect(await enforcePolicies(a.accountId)).toEqual([]); // already L0
    });
  });

  it("pausing an L2 policy does not survive a critical miss: re-enabling brings it back at L0", async () => {
    const p = await aiTestGroup("pause");
    await setPolicyEnabled(p.owner, AI_APPROVAL_DECISION, true);
    const seed = await checkedOrder(p, "#7900");
    await p.db.aiSuggestion.createMany({
      data: Array.from({ length: 300 }, () =>
        autopilotSuggestionData(p.accountId, seed.id, { evaluatedAt: new Date(), decisionAgreed: true }),
      ),
    });
    await promotePolicy(p.owner, AI_APPROVAL_DECISION);
    await promotePolicy(p.owner, AI_APPROVAL_DECISION);
    setLlmClientForTests(mockLlm().client);
    const auto = await checkedOrder(p, "#7901");
    expect(await reviewOrder(p.accountId, auto.id)).toMatchObject({ autopilot: { approved: true } });

    // (a) paused, then an audit rejects the autopilot approval → demoted right away although disabled.
    await setPolicyEnabled(p.owner, AI_APPROVAL_DECISION, false);
    await p.db.aiSuggestion.updateMany({
      where: { autoApprovedAt: { not: null } },
      data: { autoApprovedAt: new Date(Date.now() - 86_400_000) },
    });
    await drawAuditSample(p.accountId);
    const sample = await p.db.aiAuditSample.findFirstOrThrow();
    await decideAuditSample(p.owner, sample.id, "reject", "Грешен адрес");
    expect((await listPolicies(p.accountId))[0]).toMatchObject({ level: "L0", enabled: false });
    await setPolicyEnabled(p.owner, AI_APPROVAL_DECISION, true);
    expect((await listPolicies(p.accountId))[0]).toMatchObject({ level: "L0", enabled: true });
    const o = await checkedOrder(p, "#7902");
    const s = await p.db.aiSuggestion.create({
      data: {
        ...autopilotSuggestionData(p.accountId, o.id),
        orderFingerprint: (o.check!.normalised as { orderFingerprint: string }).orderFingerprint,
      },
    });
    expect(await tryAutopilot(p.accountId, s.id)).toEqual({ approved: false, reason: "policy_not_l2" });

    // (b) a critical miss recorded while paused without any sweep: enabling itself re-checks and demotes.
    const q = await aiTestGroup("pause2");
    await setPolicyEnabled(q.owner, AI_APPROVAL_DECISION, true);
    const qs = await checkedOrder(q, "#7910");
    await q.db.aiSuggestion.createMany({
      data: Array.from({ length: 300 }, () =>
        autopilotSuggestionData(q.accountId, qs.id, { evaluatedAt: new Date(), decisionAgreed: true }),
      ),
    });
    await promotePolicy(q.owner, AI_APPROVAL_DECISION);
    await setPolicyEnabled(q.owner, AI_APPROVAL_DECISION, false);
    await new Promise((r) => setTimeout(r, 5));
    await q.db.aiSuggestion.create({
      data: autopilotSuggestionData(q.accountId, qs.id, { evaluatedAt: new Date(), criticalMiss: true }),
    });
    await setPolicyEnabled(q.owner, AI_APPROVAL_DECISION, true);
    expect((await listPolicies(q.accountId))[0]).toMatchObject({ level: "L0", enabled: true });
    expect(await q.db.aiPolicyEvent.count({ where: { cause: "demote_critical" } })).toBe(1);
    expect(await q.db.alert.count({ where: { kind: "ai_policy_demoted" } })).toBe(1);
  });

  it("two owners creating the first policy row / pressing the stop at once both succeed (upsert)", async () => {
    const c = await aiTestGroup("race");
    await Promise.all([
      setPolicyEnabled(c.owner, ADDRESS_FIX_DECISION, true),
      setPolicyEnabled(c.owner, ADDRESS_FIX_DECISION, true),
    ]);
    expect(await c.db.aiPolicy.count({ where: { decisionType: ADDRESS_FIX_DECISION } })).toBe(1);
    await Promise.all([setAiKillSwitch(c.owner, true, "a"), setAiKillSwitch(c.owner, true, "b")]);
    expect(await c.db.aiControl.count()).toBe(1);
    expect((await c.db.aiControl.findFirstOrThrow()).killSwitch).toBe(true);
  });

  it("views: the AI card and the log respect company scope and permissions", async () => {
    const o = await g.db.aiSuggestion.findFirstOrThrow({ select: { orderId: true } });
    const card = await orderAiCard(g.owner, o.orderId);
    expect(card.suggestion).not.toBeNull();
    expect(card.status).toEqual({ enabled: false, reason: "no_api_key" });
    const outsider = { ...g.owner, role: "ADMIN" as const, companyScope: ["no-such-company"] };
    await expect(orderAiCard(outsider, o.orderId)).rejects.toMatchObject({ code: "not_found" });
    expect(await listInteractions(outsider)).toEqual([]);
    const any = await g.db.aiInteraction.findFirstOrThrow({ where: { orderId: { not: null } } });
    await expect(interactionDetail(outsider, any.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(listInteractions({ ...g.owner, role: "OPERATOR" })).rejects.toThrow(/ai.log/);
    expect((await interactionDetail(g.owner, any.id)).request).toBeTruthy();
    const d = await aiDashboard(g.owner);
    expect(d.policies.map((p) => p.decisionType)).toEqual([AI_APPROVAL_DECISION, ADDRESS_FIX_DECISION]);
    expect(d.embeddings["local-hash"]).toBeGreaterThan(0);
    await expect(aiDashboard({ ...g.owner, role: "VIEWER" })).rejects.toThrow(/ai.read/);
    // A company-restricted member sees no activity of other companies in the usage block or the trend.
    expect(d.usage.suggestions24h).toBeGreaterThan(0);
    expect(d.usage.calls24h).toBeGreaterThan(0);
    const scoped = await aiDashboard(outsider);
    expect(scoped.usage).toMatchObject({ suggestions24h: 0, calls24h: 0, failed24h: 0, inputTokens: 0 });
    expect(scoped.trend.every((w) => w.decisions === 0)).toBe(true);
  });

  it("rule mining turns repeated corrections into proposals; accepting records a developer task", async () => {
    const r = await aiTestGroup("rules");
    for (let i = 0; i < 5; i++) {
      const o = await checkedOrder(r, `#78${i}0`);
      await r.db.review.create({
        data: {
          accountId: r.accountId,
          orderId: o.id,
          decision: "EDIT_AND_APPROVE",
          decidedAt: new Date(),
          reviewerId: r.owner.userId,
          diff: [{ field: "phone", from: `0630${1000000 + i}`, to: `+3630${1000000 + i}`, via: "manual" }],
        },
      });
      await r.db.order.update({ where: { id: o.id }, data: { countryCode: "HU" } });
    }
    // AI-applied and one-click validator changes are not operator corrections: never mined.
    for (let i = 0; i < 5; i++) {
      const o = await checkedOrder(r, `#79${i}5`);
      await r.db.review.create({
        data: {
          accountId: r.accountId,
          orderId: o.id,
          decision: "EDIT_AND_APPROVE",
          decidedAt: new Date(),
          reviewerId: r.owner.userId,
          diff: [
            {
              field: "shippingAddress.zip",
              from: `1${i}345`,
              to: `1${i}3 45`,
              via: i % 2 ? "suggested_fix:ai.reviewer" : "suggested_fix:order.address.zip_format",
            },
          ],
        },
      });
      await r.db.order.update({ where: { id: o.id }, data: { countryCode: "CZ" } });
    }
    expect(await mineRules(r.accountId)).toBe(1);
    const p = await r.db.aiRuleProposal.findFirstOrThrow();
    expect(p).toMatchObject({ key: "phone_prefix:HU:06→+36", status: "PROPOSED", distinctOrders: 5 });
    await expect(decideProposal({ ...r.owner, role: "OPERATOR" }, p.id, "accept")).rejects.toThrow(
      /ai.rules/,
    );
    await decideProposal(r.owner, p.id, "accept", "Добре");
    expect(await r.db.alert.count({ where: { kind: "ai_rule_accepted", isTask: true } })).toBe(1);
    await mineRules(r.accountId);
    expect((await r.db.aiRuleProposal.findFirstOrThrow()).status).toBe("ACCEPTED"); // re-mining keeps the verdict
    // Tenant isolation: another group sees none of it.
    expect(await accountDb(other.accountId).aiRuleProposal.count()).toBe(0);
    expect(await accountDb(other.accountId).aiSuggestion.count({ where: { orderId: p.id } })).toBe(0);
  });
});

void localHashProvider;
