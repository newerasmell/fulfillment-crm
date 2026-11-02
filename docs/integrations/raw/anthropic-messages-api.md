# Anthropic Messages API — verbatim excerpts (captured 2026-11-02)

Untouched excerpts of Anthropic's Claude API reference as shipped in the claude-api skill bundled with Claude Code
2.1.316 (models table cached 2026-10-06). Only the passages our request uses are copied; each block names its
source file. Do not edit; refresh by re-copying. Live docs: https://platform.claude.com/docs/en/api/messages

## curl/examples.md — Basic Message Request (lines 13-27)

## Basic Message Request

```bash
curl https://api.anthropic.com/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2026-10-21" \
  -d '{
    "model": "claude-opus-5-5",
    "max_tokens": 16000,
    "messages": [
      {"role": "user", "content": "What is the capital of France?"}
    ]
  }'
```

## curl/examples.md — tool_use response block (lines 124-153)

When Claude responds with a `tool_use` block, send the result back:

```bash
curl https://api.anthropic.com/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2026-10-21" \
  -d '{
    "model": "claude-opus-5-5",
    "max_tokens": 16000,
    "tools": [{
      "name": "get_weather",
      "description": "Get current weather for a location",
      "input_schema": {
        "type": "object",
        "properties": {
          "location": {"type": "string", "description": "City name"}
        },
        "required": ["location"]
      }
    }],
    "messages": [
      {"role": "user", "content": "What is the weather in Paris?"},
      {"role": "assistant", "content": [
        {"type": "text", "text": "Let me check the weather."},
        {"type": "tool_use", "id": "toolu_abc123", "name": "get_weather", "input": {"location": "Paris"}}
      ]},
      {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_abc123", "content": "72°F and sunny"}
      ]}

## curl/examples.md — parsing usage / stop_reason (lines 44-52)

echo "$response" | jq -r '.content[0].text'

# Read usage fields
input_tokens=$(echo "$response" | jq -r '.usage.input_tokens')
output_tokens=$(echo "$response" | jq -r '.usage.output_tokens')

# Read stop reason (for tool-use loops)
stop_reason=$(echo "$response" | jq -r '.stop_reason')


## curl/examples.md — prompt caching (line 179)

For 1-hour TTL: `"cache_control": {"type": "ephemeral", "ttl": "1h"}`. Top-level `"cache_control"` on the request body auto-places on the last cacheable block. Verify hits via the response `usage.cache_creation_input_tokens` / `usage.cache_read_input_tokens` fields.

## shared/api-version-migration.md — version 2026-10-21 (lines 75, 79, 99)

**TL;DR:** upgrade the SDK (or send `anthropic-version: 2026-10-21` for raw HTTP), then: remove `temperature`, `top_p` and `top_k` from the Messages requests that switch (asking first about non-default values, change 1); never put a `document` block directly in an `assistant` message or a `text` block with non-empty `citations` in a `user` message; and if the code reads Admin API or Claude Enterprise Analytics API responses, read the replacement fields below. With the upgrade, make the code changes the new SDK or CLI release needs, which change 5 lists, with their detail from the migration guide.

**Platforms.** `2026-10-21` works on the Claude API, Claude Platform on AWS, Claude Models on Google Cloud (Anthropic managed), Microsoft Foundry and Google Cloud Vertex AI, and on Amazon Bedrock for Claude 4.7 and later models.

**[BREAKS]** On `2026-10-21`, a Messages request that sends `temperature`, `top_p` or `top_k` returns a 400 error on every model - even at its default value, such as `"temperature": 1`. The same applies to each request in a Message Batch created with `2026-10-21`. Delete the three fields from every request that switches to `2026-10-21`, including batch request `params` and any `extra_body` entry that carries them: an `extra_body` entry still puts the field in the request JSON, so the API rejects it. Leave them on a call that stays on its current version (Platforms note). Where one is set to a non-default value, settle the non-default-value **[DECIDE]** after the example below before deleting it or upgrading the SDK. **[DECIDE]** For your own wrappers and config that forward them (a `temperature` argument on a helper, a config key), stop sending the value to Claude; removing the argument from a public signature breaks that code's callers, so that part is the user's call. A third-party library between the code and the API (LangChain, LiteLLM, and the like) may send these fields when it is configured with them: remove them from its configuration, check how it sets `anthropic-version`, and list it in the report.

## shared/tool-use-concepts.md — forced tool use / strict (line 106)

**Claude Fable 5.1, Claude Mythos 5.1, Claude Opus 5.5, and Claude Sonnet 5.5 reject forced tool use:** `{"type": "any"}` and `{"type": "tool", "name": ...}` return a 400 there (`tool_choice: type "tool" and "any" are not supported for this model.` - on `count_tokens` and Batches too). It is a model-specific restriction (Claude Fable 5 and Claude Opus 5 accept them). Because `auto` does not guarantee a call, check that one was made and retry if it wasn't. Use `{"type": "auto"}` and state the expectation in the prompt ("Use the get_weather tool to answer") - `strict: true` on the tool keeps the schema-valid-arguments guarantee `any` gave you - or structured outputs (`output_config.format`) when the forced call only existed to extract JSON. `auto` and `none` are unaffected; `disable_parallel_tool_use` with `auto` still means at most one call (the "exactly one" combination with `any`/`tool` is gone). Combining `tool_choice` `any` with `strict: true` applies only on models that support forced tool use. See `shared/model-migration.md` -> Migrating to Claude Fable 5.1 from Claude Fable 5.

## shared/model-migration.md — fallbacks: "default" (lines 1001-1011)

**1. `fallbacks: "default"` - recommended for every caller.** Claude Opus 5's safety classifiers can decline a request; the `fallbacks` parameter re-runs a declined request on another model server-side instead of returning the refusal to you. Previously you named the substitute yourself (`"fallbacks": [{"model": "claude-opus-4-8"}]`). The new `"default"` mode picks Anthropic's recommended fallback automatically, routed **by refusal category** - cyber-category refusals go to Claude Opus 4.8.

```http
POST /v1/messages
anthropic-beta: server-side-fallback-2026-07-01

{"model": "claude-opus-5", "fallbacks": "default", "max_tokens": 1024,
 "messages": [{"role": "user", "content": "Say OK."}]}
```

**Prefer `"default"` over pinning a model.** Different fallback models carry different classifiers, so the right substitute depends on *why* the request was declined - and `"default"` removes the migration you would otherwise owe when a pinned fallback model is deprecated. Note the header is `server-side-fallback-2026-07-01`, distinct from the `-2026-06-01` header that gates the array form; the array form's semantics (content blocks, `usage.iterations`, sticky routing) are unchanged and documented in the Claude Fable 5.1 refusal section below.

## shared/model-migration.md — Claude Sonnet 5.5 refusals + fallback (line 2196)

Claude Sonnet 5.5 declines in more categories than Claude Sonnet 5. A decline is a normal HTTP 200 with `stop_reason: "refusal"` and a `stop_details` category: `"cyber"` (could enable cyber harm, such as malware or exploit development - finding vulnerabilities in source code is allowed), `"bio"` (could enable biological harm), `"frontier_llm"` (could assist the development of competing AI models), `"reasoning_extraction"` (asks the model to reproduce its internal reasoning in the response text), and `"general_harms"` (another usage-policy area - benign work can also trigger it). Branch on `stop_reason` before reading `content` (handling: § `refusal` stop reason under § Migrating to Claude Fable 5.1). Server-side fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`, Claude API only) retries `"cyber"` and `"frontier_llm"` declines on Claude Sonnet 5; it doesn't retry `"bio"`, `"reasoning_extraction"`, or `"general_harms"` declines. The SDK middleware or your own retry are the alternatives; a fallback runs without Claude Sonnet 5.5's thinking blocks unless it goes to Claude Opus 5.5 on the Claude API or Google Cloud (breaking change 3), and a client-side retry must drop `between_tools` (breaking change 1); with server-side fallback, a `between_tools` request that falls back to Claude Sonnet 5 runs there with `thinking: {"type": "disabled"}`. Whether a refusal that arrives before any output is billed depends on its refusal category, and it counts against rate limits either way. Real-time cyber safeguards are new for code coming from Sonnet 4.6, Sonnet 4.5, and Haiku 4.5 - for legitimate security work, point the user to the [Cyber Verification Program](https://support.claude.com/en/articles/14604842-real-time-cyber-safeguards-on-claude-opus-and-sonnet). The biology safeguards are the same as Claude Sonnet 5's and leave everyday health and educational questions unaffected; if the `bio` classifier gets in the way of an organization's life-sciences work, it can apply to the Life Sciences Verification Program. If a prompt asks the model to write out its reasoning as a substitute for thinking, remove that instruction (it invites `reasoning_extraction` declines) and read `display: "summarized"` blocks instead.

## shared/model-migration.md — no server-side fallback for Claude Haiku 5.5 (line 2355)

**There is no server-side fallback for Claude Haiku 5.5** - don't add the `fallbacks` parameter to its requests: with `fallbacks: "default"` a declined request stays declined, and a list of fallback models returns a 400. Handle the refusal in the client and try a different prompt. If the `bio` classifier blocks an organization's life-sciences work, it can apply to the Life Sciences Verification Program.

## shared/model-migration.md — Haiku 5.5 summary row (line 34)

| Migrating to Claude Haiku 5.5 | Migrating Claude Haiku 4.5 -> Claude Haiku 5.5 (`budget_tokens` 400s - adaptive thinking only, on by default; non-default sampling params 400; prefill 400; computer use via the toolset on the Claude API and Google Cloud; preserved thinking's history-editing check; newer tokenizer; account-bound thinking blocks; `effort`, default `medium`; safeguard refusals with no server-side fallback; 1M context / 128K output; prompting guidance) |

## shared/platform-availability.md — server-side fallbacks (line 54)

| &nbsp;&nbsp;Server-side `fallbacks` | beta | beta | No | No | No | `"default"` -> beta `server-side-fallback-2026-07-01`; array form -> beta `server-side-fallback-2026-06-01` |
