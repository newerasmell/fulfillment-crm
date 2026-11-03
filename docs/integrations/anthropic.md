# Anthropic Messages API — the reference for `src/ai/llm.ts` and `src/ai/prompt.ts`

Source: Anthropic's Claude API reference as shipped in the `claude-api` skill bundled with Claude Code 2.1.316
(models table "cached: 2026-10-06"), read 2026-11-02. Untouched excerpts: `raw/anthropic-messages-api.md`.
Live docs: https://platform.claude.com/docs/en/api/messages. If this file and the raw excerpts disagree, the raw
excerpts (and then the live docs) win — fix this file.

We call one endpoint, raw HTTP (no SDK dependency yet): `POST https://api.anthropic.com/v1/messages`. Every header
and body field we send is listed below with the reference line that allows it. Anything not listed here must not be
added to the request without first adding its quote here.

## Headers

| Header | Value we send | Reference |
|---|---|---|
| `x-api-key` | `ANTHROPIC_API_KEY` (env, never logged; the logged request body has no headers) | curl/examples.md: `-H "x-api-key: $ANTHROPIC_API_KEY"` |
| `anthropic-version` | `2026-10-21` | curl/examples.md: `-H "anthropic-version: 2026-10-21"`; api-version-migration.md: "send `anthropic-version: 2026-10-21` for raw HTTP" |
| `content-type` | `application/json` | curl/examples.md: `-H "Content-Type: application/json"` |
| `anthropic-beta` | `server-side-fallback-2026-07-01`, only when the body has `fallbacks` | model-migration.md: "`anthropic-beta: server-side-fallback-2026-07-01`" + "`fallbacks: \"default\"` ... Note the header is `server-side-fallback-2026-07-01`, distinct from the `-2026-06-01` header that gates the array form" |

Version consequences (api-version-migration.md): "On `2026-10-21`, a Messages request that sends `temperature`,
`top_p` or `top_k` returns a 400 error on every model" — we send none of them.

## Body fields

| Field | What we send | Reference |
|---|---|---|
| `model` | `AI_REVIEWER_MODEL` (default `claude-sonnet-5-5`) / `AI_CHEAP_MODEL` (default `claude-haiku-5-5`) | Models table: "Claude Sonnet 5.5 \| `claude-sonnet-5-5`", "Claude Haiku 5.5 \| `claude-haiku-5-5`"; "Use only the exact model ID strings from the table ... never append date suffixes" |
| `max_tokens` | 8000 | curl/examples.md basic request (`"max_tokens": 16000`); a non-streaming request — "For non-streaming requests, default to `~16000`"; 8000 is a deliberate cap for one short tool call |
| `system` | `[{type:"text", text, cache_control:{type:"ephemeral"}}]` | curl/examples.md / README "Manual Cache Control": `system: [{ type: "text", text: ..., cache_control: { type: "ephemeral" } }]` |
| `tools` | one tool `{name, description, input_schema, strict: true}` | "Strict tool use (no beta): set `strict: true` as a top-level field on the tool definition (alongside `name`/`description`/`input_schema`), not on `tool_choice`. Schema must have `additionalProperties: false` + `required`." |
| `tool_choice` | `{type:"auto"}` | tool-use-concepts.md: "Claude Fable 5.1, Claude Mythos 5.1, Claude Opus 5.5, and Claude Sonnet 5.5 reject forced tool use: `{"type": "any"}` and `{"type": "tool", "name": ...}` return a 400 ... Use `{"type": "auto"}` and state the expectation in the prompt ... `strict: true` on the tool keeps the schema-valid-arguments guarantee" |
| `output_config.effort` | `low` (cheap model) / `medium` (reviewer) | "Effort (GA, no beta header): `output_config: {effort: \"low\"\|\"medium\"\|\"high\"\|\"xhigh\"\|\"max\"}` - inside `output_config`, not top-level"; thinking table: Claude Sonnet 5.5 and Claude Haiku 5.5 support `low`–`max` |
| `fallbacks` | `"default"`, **not for Haiku** | model-migration.md: "The new `\"default\"` mode picks Anthropic's recommended fallback automatically, routed by refusal category"; Sonnet 5.5: "Server-side fallback (`fallbacks: \"default\"`, beta `server-side-fallback-2026-07-01`, Claude API only)"; Haiku 5.5: "There is no server-side fallback for Claude Haiku 5.5 - don't add the `fallbacks` parameter to its requests" (prompt.ts omits it for `claude-haiku*`) |
| `messages` | one `user` message (text) | curl/examples.md basic request |

Not sent on purpose: `thinking` (Sonnet 5.5 and Haiku 5.5 run adaptive when it is omitted — thinking table
"Omitting `thinking`: Runs adaptive"; `{type:"disabled"}` is a 400 on Sonnet 5.5), `temperature`/`top_p`/`top_k`
(400 on 2026-10-21), assistant prefill ("Assistant message prefills ... return a 400 error").

## Response fields we read

| Field | Use | Reference |
|---|---|---|
| `id`, `model` | logged; `model` stored on the suggestion (may differ after a fallback) | README "Refusal Fallbacks": "Served by ${response.model}" |
| `stop_reason` | `refusal` → status `refusal`; `max_tokens` → status `max_tokens` | Stop reasons table: `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal`; "a classifier decline arrives as a normal HTTP 200 with `stop_reason: \"refusal\"`" |
| `content[]` | the `tool_use` block named `submit_review`; its `input` is Zod-parsed (ReviewOutput); other block types (`thinking`, `text`, `fallback`) pass through | curl/examples.md: `{"type": "tool_use", "id": "toolu_abc123", "name": "get_weather", "input": {...}}`; "Always parse tool inputs with `JSON.parse()`" (we receive parsed JSON) |
| `usage.input_tokens`, `usage.output_tokens` | logged | curl/examples.md: `jq -r '.usage.input_tokens'`, `'.usage.output_tokens'` |
| error body `{error:{type,message}}` | logged as `api_error` | error-codes reference (typed API errors); the client keeps the raw body |

## Retries and time budget

"`max_retries`/`maxRetries` default 2 (retries 408/409/429/5xx + connection errors)" — our client does the same
(plus 529), honours `retry-after`, and caps the whole send at `LLM_DEADLINE_MS` (240 s) so the `ai.review` job
(expireInSeconds 600) never expires under a running call. "Timeouts are retried - wall-clock can reach
`timeout × (max_retries+1)`" — that is why the deadline exists.

## Tests

`src/ai/ai.test.ts` → "Anthropic HTTP client (mocked fetch)" and "Messages API reference shape": the documented
response shape (`tool_use` + `usage` + `stop_reason`) and the documented error shape, the request headers and the
body fields above. Automated tests never call the API. There is no recorded production response yet (no key in
the build environment by design): at GATE P8-G1 the owner sets the key; the first real calls are logged verbatim
in AiInteraction (Настройки → AI асистент → Лог) — compare one with this file and, if a field differs, fix this
file, the raw excerpt, the schema and the test together.
