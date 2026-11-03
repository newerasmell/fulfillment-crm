import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Embedding providers for similar-case retrieval (P8-01). Anthropic has no embeddings endpoint, so:
 *   - "voyage": Voyage AI (POST https://api.voyageai.com/v1/embeddings, Bearer VOYAGE_API_KEY, model voyage-3.5,
 *     output_dimension 1024) — only when VOYAGE_API_KEY is set;
 *   - "local-hash": deterministic feature hashing of the case tokens into 1024 dimensions, L2-normalised. Needs
 *     no key and no network, so retrieval always works. Every decided review always gets a local-hash vector;
 *     a voyage vector is added when the key is set. Vectors of different providers are never compared.
 */

export const EMBEDDING_DIMS = 1024;

export interface EmbeddingProvider {
  readonly name: "voyage" | "local-hash";
  readonly model: string;
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
}

/** FNV-1a 32-bit with a seed. */
function fnv1a(text: string, seed: number) {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Tokens are whitespace-separated "key:value" features (see case-text.ts); a token "w*N" has weight N. */
export function hashEmbed(text: string, dims = EMBEDDING_DIMS): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    const m = /^(.*)\*(\d+(?:\.\d+)?)$/.exec(raw);
    const token = m?.[1] ?? raw;
    const weight = m?.[2] ? Number(m[2]) : 1;
    const idx = fnv1a(token, 0) % dims;
    const sign = fnv1a(token, 0x9e3779b9) & 1 ? 1 : -1;
    v[idx] = (v[idx] ?? 0) + sign * weight;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm > 0 ? v.map((x) => x / norm) : v;
}

export const localHashProvider: EmbeddingProvider = {
  name: "local-hash",
  model: "fnv1a-1024-v1",
  async embed(texts) {
    return texts.map((t) => hashEmbed(t));
  },
};

const VoyageResponse = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()), index: z.number().int() })),
  model: z.string().optional(),
});

export const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

export function voyageProvider(
  apiKey: string,
  opts: { model?: string; fetchImpl?: typeof fetch } = {},
): EmbeddingProvider {
  const model = opts.model ?? "voyage-3.5";
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    name: "voyage",
    model,
    async embed(texts, kind) {
      if (!texts.length) return [];
      const res = await doFetch(VOYAGE_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ input: texts, model, input_type: kind, output_dimension: EMBEDDING_DIMS }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`voyage embeddings failed: HTTP ${res.status}`);
      const parsed = VoyageResponse.parse(await res.json());
      const out = new Array<number[]>(texts.length);
      for (const d of parsed.data) {
        if (d.embedding.length !== EMBEDDING_DIMS) throw new Error("voyage returned a wrong dimension");
        out[d.index] = d.embedding;
      }
      if (out.some((e) => !e)) throw new Error("voyage returned too few embeddings");
      return out;
    },
  };
}

let voyageOverride: EmbeddingProvider | null | undefined;
/** Tests only: replace the Voyage provider (null = force "not configured"; undefined = from env). */
export function setVoyageProviderForTests(p: EmbeddingProvider | null | undefined) {
  voyageOverride = p;
}

/** Providers to store vectors for, in retrieval preference order (voyage first when configured). */
export function embeddingProviders(): EmbeddingProvider[] {
  const key = process.env.VOYAGE_API_KEY?.trim();
  const voyage =
    voyageOverride !== undefined
      ? voyageOverride
      : key
        ? voyageProvider(key, { model: process.env.VOYAGE_MODEL?.trim() || undefined })
        : null;
  return voyage ? [voyage, localHashProvider] : [localHashProvider];
}

export const textHash = (text: string) => createHash("sha256").update(text).digest("hex");
