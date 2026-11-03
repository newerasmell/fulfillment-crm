import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  BRAKE_ALERT_KIND,
  budgetUsage,
  checkBudget,
  dailyLimit,
  FAILURE_STREAK,
  LIMIT_ALERT_KIND,
} from "./budget";
import {
  embeddingProviders,
  openaiProvider,
  OPENAI_EMBEDDINGS_URL,
  setOpenAiProviderForTests,
  setVoyageProviderForTests,
  type EmbeddingProvider,
} from "./embeddings";
import { setLlmClientForTests } from "./llm";
import { AI_APPROVAL_DECISION, setPolicyEnabled } from "./policies";
import { embedPendingReviews } from "./retrieval";
import { reviewOrder } from "./reviewer";
import { aiTestGroup, checkedOrder, mockLlm, type AiTestGroup } from "./test-fixtures";

// Synthetic data only. Nothing calls Anthropic, OpenAI or Voyage: every transport is mocked.

const ENV_KEYS = [
  "AI_DAILY_REVIEW_LIMIT",
  "AI_DAILY_EMBEDDING_LIMIT",
  "OPENAI_API_KEY",
  "VOYAGE_API_KEY",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setLlmClientForTests(null);
  setOpenAiProviderForTests(undefined);
  setVoyageProviderForTests(undefined);
});

const vec = (seed: number) => Array.from({ length: 1024 }, (_, i) => ((i * 7 + seed) % 13) / 13 - 0.5);

describe("OpenAI embeddings provider (mocked fetch)", () => {
  it("sends the documented request and maps vectors back by index", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          object: "list",
          data: [
            { object: "embedding", index: 1, embedding: vec(2) },
            { object: "embedding", index: 0, embedding: vec(1) },
          ],
          model: "text-embedding-3-small",
          usage: { prompt_tokens: 10, total_tokens: 10 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const p = openaiProvider("sk-test-not-real", { fetchImpl });
    expect(p).toMatchObject({ name: "openai", model: "text-embedding-3-small", paid: true });
    const out = await p.embed(["a", "b"], "document");
    expect(out[0]).toEqual(vec(1));
    expect(out[1]).toEqual(vec(2));
    expect(calls[0]!.url).toBe(OPENAI_EMBEDDINGS_URL);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-test-not-real");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      input: ["a", "b"],
      model: "text-embedding-3-small",
      dimensions: 1024,
      encoding_format: "float",
    });
  });

  it("fails on an HTTP error or a wrong dimension (never stores a bad vector)", async () => {
    const bad = openaiProvider("k", {
      fetchImpl: (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch,
    });
    await expect(bad.embed(["a"], "query")).rejects.toThrow("HTTP 429");
    const short = openaiProvider("k", {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    await expect(short.embed(["a"], "query")).rejects.toThrow("wrong dimension");
  });

  it("uses at most one paid provider: Voyage wins over OpenAI, local is always there", () => {
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(embeddingProviders().map((p) => p.name)).toEqual(["local-hash"]);
    process.env.OPENAI_API_KEY = "sk-test-not-real";
    expect(embeddingProviders().map((p) => p.name)).toEqual(["openai", "local-hash"]);
    process.env.VOYAGE_API_KEY = "pa-test-not-real";
    expect(embeddingProviders().map((p) => p.name)).toEqual(["voyage", "local-hash"]);
  });
});

describe("daily limits and failure brake (DB)", () => {
  let g: AiTestGroup;
  beforeAll(async () => {
    g = await aiTestGroup("budget");
  });

  const log = (purpose: string, status: string, n: number, at = new Date()) =>
    g.db.aiInteraction.createMany({
      data: Array.from({ length: n }, () => ({
        accountId: g.accountId,
        purpose,
        provider: "test",
        model: "m",
        request: {},
        status,
        createdAt: at,
      })),
    });

  it("parses limits safely (defaults on garbage, 0 = off)", () => {
    expect(dailyLimit("order_review", {})).toBe(100);
    expect(dailyLimit("embedding", {})).toBe(300);
    expect(dailyLimit("order_review", { AI_DAILY_REVIEW_LIMIT: "0" })).toBe(0);
    expect(dailyLimit("order_review", { AI_DAILY_REVIEW_LIMIT: "-5" })).toBe(100);
    expect(dailyLimit("order_review", { AI_DAILY_REVIEW_LIMIT: "abc" })).toBe(100);
  });

  it("stops at the daily cap, raises ONE alert, and counts only the last 24 h", async () => {
    await g.db.aiInteraction.deleteMany({});
    await log("order_review", "ok", 3, new Date(Date.now() - 25 * 3_600_000)); // older than 24 h: not counted
    await log("order_review", "ok", 2);
    const env = { AI_DAILY_REVIEW_LIMIT: "3" };
    expect(await checkBudget(g.accountId, "order_review", new Date(), env)).toMatchObject({
      allowed: true,
      used: 2,
    });
    await log("order_review", "ok", 1);
    const v = await checkBudget(g.accountId, "order_review", new Date(), env);
    expect(v).toMatchObject({ allowed: false, reason: "daily_limit", used: 3, limit: 3 });
    await checkBudget(g.accountId, "order_review", new Date(), env);
    expect(await g.db.alert.count({ where: { kind: LIMIT_ALERT_KIND, entityId: "order_review" } })).toBe(1);
    // Embeddings have their own cap.
    expect((await checkBudget(g.accountId, "embedding", new Date(), env)).allowed).toBe(true);
    expect(
      await checkBudget(g.accountId, "order_review", new Date(), { AI_DAILY_REVIEW_LIMIT: "0" }),
    ).toMatchObject({
      allowed: false,
      reason: "daily_limit",
    });
  });

  it(`pauses after ${FAILURE_STREAK} failed calls in a row within an hour, resumes after`, async () => {
    await g.db.aiInteraction.deleteMany({});
    await log("embedding", "api_error", FAILURE_STREAK);
    expect(await checkBudget(g.accountId, "embedding")).toMatchObject({
      allowed: false,
      reason: "failure_brake",
    });
    expect(await g.db.alert.count({ where: { kind: BRAKE_ALERT_KIND, entityId: "embedding" } })).toBe(1);
    // An hour later the brake is off again (one more try is allowed).
    expect((await checkBudget(g.accountId, "embedding", new Date(Date.now() + 61 * 60_000))).allowed).toBe(
      true,
    );
    // One success among the last calls releases it at once.
    await log("embedding", "ok", 1, new Date(Date.now() + 1000));
    expect((await checkBudget(g.accountId, "embedding", new Date(Date.now() + 2000))).allowed).toBe(true);
    const usage = await budgetUsage(g.accountId, new Date(Date.now() + 2000));
    expect(usage.embedding.used).toBe(FAILURE_STREAK + 1);
  });

  it("a review over the cap is skipped before Claude is called (also when asked by hand)", async () => {
    await g.db.aiInteraction.deleteMany({});
    await setPolicyEnabled(g.owner, AI_APPROVAL_DECISION, true);
    const m = mockLlm();
    setLlmClientForTests(m.client);
    process.env.AI_DAILY_REVIEW_LIMIT = "1";
    const a = await checkedOrder(g, "#8101");
    const b = await checkedOrder(g, "#8102");
    expect((await reviewOrder(g.accountId, a.id)).status).toBe("suggested");
    expect(await reviewOrder(g.accountId, b.id, { force: true })).toEqual({
      status: "skipped",
      reason: "daily_limit",
    });
    expect(m.requests).toHaveLength(1);
  });

  it("paid embeddings are metered and stop at the cap; the free local vectors still get written", async () => {
    await g.db.aiInteraction.deleteMany({});
    let paidCalls = 0;
    const paid: EmbeddingProvider = {
      name: "openai",
      model: "text-embedding-3-small",
      paid: true,
      async embed(texts) {
        paidCalls++;
        return texts.map((_, i) => vec(i));
      },
    };
    setOpenAiProviderForTests(paid);
    delete process.env.VOYAGE_API_KEY;
    process.env.AI_DAILY_EMBEDDING_LIMIT = "0";
    const o = await checkedOrder(g, "#8103");
    await g.db.review.create({
      data: {
        accountId: g.accountId,
        orderId: o.id,
        decision: "APPROVE",
        decidedAt: new Date(),
        findings: [],
      },
    });
    await embedPendingReviews(g.accountId);
    expect(paidCalls).toBe(0);
    expect(await g.db.reviewEmbedding.count({ where: { provider: "local-hash" } })).toBeGreaterThan(0);
    expect(await g.db.reviewEmbedding.count({ where: { provider: "openai" } })).toBe(0);
    process.env.AI_DAILY_EMBEDDING_LIMIT = "10";
    await embedPendingReviews(g.accountId);
    expect(paidCalls).toBe(1);
    expect(await g.db.aiInteraction.count({ where: { purpose: "embedding", status: "ok" } })).toBe(1);
    const row = await g.db.aiInteraction.findFirstOrThrow({ where: { purpose: "embedding" } });
    expect(row.request).toEqual({ kind: "document", inputs: expect.any(Number) }); // counts only, no case text
    // Already embedded: nothing is paid for twice.
    await embedPendingReviews(g.accountId);
    expect(paidCalls).toBe(1);
  });
});
