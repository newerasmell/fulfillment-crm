# OpenAI embeddings (optional memory provider for the AI reviewer)

Used only when `OPENAI_API_KEY` is set and `VOYAGE_API_KEY` is not (src/ai/embeddings.ts `openaiProvider`).
Reference: OpenAI API reference, "Embeddings → Create embeddings" (https://platform.openai.com/docs/api-reference/embeddings/create).

## Request we send
`POST https://api.openai.com/v1/embeddings`, header `Authorization: Bearer $OPENAI_API_KEY`, JSON body:

| field | value | reference |
|---|---|---|
| `input` | array of strings (≤ 64 per call) | "Input text to embed … array of strings" |
| `model` | `text-embedding-3-small` (`OPENAI_EMBEDDING_MODEL`) | "ID of the model to use" |
| `dimensions` | `1024` | "The number of dimensions the resulting output embeddings should have. Only supported in text-embedding-3 and later models." |
| `encoding_format` | `float` | "The format to return the embeddings in. Can be either float or base64." |

## Response fields we read (Zod-parsed)
`data[].index`, `data[].embedding` (must have 1024 numbers), optional `model`, optional `usage.prompt_tokens` /
`usage.total_tokens`. Anything else is ignored.

## Cost safety (src/ai/budget.ts)
- One request per call, no automatic retries inside the provider.
- Every paid call is logged in `AiInteraction` (purpose `embedding`: counts and status only, no case text) and counted
  against `AI_DAILY_EMBEDDING_LIMIT` (default 300 calls per group per rolling 24 h).
- 5 failed calls in a row within an hour pause paid embeddings for an hour; both events raise one alert.
- Each decided review is embedded once per provider; nothing polls OpenAI.
