import { z } from "zod";

/**
 * The one place that talks to the Claude Messages API (POST /v1/messages, raw HTTP). A thin interface so the
 * reviewer never depends on the transport: tests and the e2e seed install a mock with setLlmClientForTests(),
 * and swapping in the official SDK later is a change to this file only. No vendor/model call happens without
 * ANTHROPIC_API_KEY: llmClient() is null then and the AI is off.
 *
 * Every header and body field is quoted from the API reference in docs/integrations/anthropic.md (untouched
 * excerpts: docs/integrations/raw/anthropic-messages-api.md); add a field there before sending it here.
 * Header `anthropic-version: 2026-10-21` (no temperature / top_p / top_k on this version), `x-api-key`; forced
 * tool_choice is refused by claude-sonnet-5-5, so the caller sends tool_choice auto + `strict: true` on the tool
 * and asks for the tool in the prompt; a classifier decline is HTTP 200 with stop_reason "refusal"; server-side
 * `fallbacks: "default"` needs the beta header server-side-fallback-2026-07-01 (not for Haiku).
 */

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2026-10-21";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type LlmResult =
  | { ok: true; status: number; body: unknown; latencyMs: number }
  | { ok: false; status: number | null; body: unknown; error: string; latencyMs: number };

export interface LlmClient {
  readonly provider: string;
  send(body: Record<string, unknown>): Promise<LlmResult>;
}

let override: LlmClient | null = null;

/** Tests / e2e seed only: replace the transport (pass null to restore). */
export function setLlmClientForTests(client: LlmClient | null) {
  override = client;
}

/** The transport in use, or null when the AI has no key (feature off). */
export function llmClient(): LlmClient | null {
  if (override) return override;
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  return key ? anthropicHttpClient(key) : null;
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Overall wall-time budget of one send() (all attempts, waits included). Kept well below the ai.review job's
 * expireInSeconds (queues.ts) so pg-boss never re-queues a review while the first run is still waiting on the model.
 */
export const LLM_DEADLINE_MS = 240_000;

/**
 * Messages API over fetch: 2 retries on 408/409/429/5xx/529 and network errors, honouring retry-after, all within
 * one overall deadline (no new attempt or wait starts past it; each attempt's timeout is capped by what is left).
 */
export function anthropicHttpClient(
  apiKey: string,
  opts: {
    fetchImpl?: typeof fetch;
    maxRetries?: number;
    timeoutMs?: number;
    baseDelayMs?: number;
    deadlineMs?: number;
    now?: () => number;
  } = {},
): LlmClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? 2;
  const baseDelay = opts.baseDelayMs ?? 1000;
  const deadline = opts.deadlineMs ?? LLM_DEADLINE_MS;
  const clock = opts.now ?? Date.now;
  return {
    provider: "anthropic",
    async send(body) {
      const started = clock();
      const left = () => deadline - (clock() - started);
      let last: LlmResult | null = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        };
        if (body.fallbacks !== undefined) headers["anthropic-beta"] = FALLBACK_BETA;
        let retryAfterMs: number | null = null;
        try {
          const res = await doFetch(ANTHROPIC_URL, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(Math.max(1, Math.min(opts.timeoutMs ?? 120_000, left()))),
          });
          const text = await res.text();
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* keep the text */
          }
          if (res.ok) return { ok: true, status: res.status, body: parsed, latencyMs: clock() - started };
          last = {
            ok: false,
            status: res.status,
            body: parsed,
            error: apiErrorMessage(parsed) ?? `HTTP ${res.status}`,
            latencyMs: clock() - started,
          };
          if (!RETRYABLE.has(res.status)) return last;
          const ra = Number(res.headers.get("retry-after"));
          if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(ra * 1000, 30_000);
        } catch (err) {
          last = {
            ok: false,
            status: null,
            body: null,
            error: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : "network error",
            latencyMs: clock() - started,
          };
        }
        if (attempt >= maxRetries) break;
        const wait = retryAfterMs ?? baseDelay * 2 ** attempt;
        // Out of budget: return the last failure instead of starting a wait/attempt the job could outlive.
        if (left() - wait < 1000) break;
        await sleep(wait);
      }
      return last!;
    },
  };
}

function apiErrorMessage(body: unknown): string | null {
  const r = z.object({ error: z.object({ type: z.string(), message: z.string() }) }).safeParse(body);
  return r.success ? `${r.data.error.type}: ${r.data.error.message}`.slice(0, 500) : null;
}

/** The parts of a Messages API response the reviewer reads (unknown block types pass through untouched). */
export const MessageResponse = z.object({
  id: z.string(),
  model: z.string(),
  stop_reason: z.string().nullable(),
  content: z.array(z.object({ type: z.string() }).passthrough()),
  usage: z
    .object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() })
    .passthrough()
    .optional(),
});
export type MessageResponse = z.infer<typeof MessageResponse>;
