import { basePrisma, TenantScopeError } from "./client";

/**
 * pgvector access for ReviewEmbedding (P8-01). Prisma cannot read or write `vector` columns, and raw SQL is
 * disabled on the scoped clients, so this module is the one sanctioned raw-SQL path for vectors. Every call runs
 * in its own transaction with the same RLS setting as withAccountTransaction (app.account_id, bypass off) AND an
 * explicit accountId filter, and only takes numbers/ids as parameters (never SQL text).
 */

export const VECTOR_DIMS = 1024;

function literal(vector: readonly number[]) {
  if (vector.length !== VECTOR_DIMS || vector.some((x) => !Number.isFinite(x)))
    throw new Error(`vector must have ${VECTOR_DIMS} finite numbers`);
  return `[${vector.map((x) => Number(x.toFixed(7))).join(",")}]`;
}

async function inAccount<T>(
  accountId: string,
  fn: (tx: Parameters<Parameters<ReturnType<typeof basePrisma>["$transaction"]>[0]>[0]) => Promise<T>,
) {
  if (!accountId) throw new TenantScopeError("accountId is required");
  return basePrisma().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.account_id', ${accountId}, TRUE), set_config('app.bypass_rls', 'off', TRUE)`;
    return fn(tx);
  });
}

export interface EmbeddingRow {
  reviewId: string;
  provider: string;
  model: string;
  textHash: string;
  vector: readonly number[];
}

/** Insert or replace the embedding of one review for one provider. */
export async function upsertReviewEmbedding(accountId: string, row: EmbeddingRow) {
  const lit = literal(row.vector);
  await inAccount(
    accountId,
    (tx) =>
      tx.$executeRaw`
      INSERT INTO "ReviewEmbedding" (id, "accountId", "reviewId", provider, model, "textHash", embedding, "createdAt")
      VALUES (${`re_${row.reviewId}_${row.provider}`}, ${accountId}, ${row.reviewId}, ${row.provider}, ${row.model},
              ${row.textHash}, ${lit}::vector, now())
      ON CONFLICT ("reviewId", provider) DO UPDATE
        SET model = EXCLUDED.model, "textHash" = EXCLUDED."textHash", embedding = EXCLUDED.embedding`,
  );
}

export interface Neighbour {
  reviewId: string;
  /** Cosine distance (0 = identical direction, 2 = opposite). */
  distance: number;
}

/**
 * The k decided reviews of this account closest to `vector` (cosine distance, exact search), optionally leaving
 * out one order's own reviews. Only vectors of the same provider are compared.
 */
export async function nearestReviews(
  accountId: string,
  q: { provider: string; vector: readonly number[]; k: number; excludeOrderId?: string | null },
): Promise<Neighbour[]> {
  const lit = literal(q.vector);
  const k = Math.max(1, Math.min(Math.floor(q.k), 100));
  const rows = await inAccount(
    accountId,
    (tx) =>
      tx.$queryRaw<{ reviewId: string; distance: number }[]>`
      SELECT e."reviewId" AS "reviewId", (e.embedding <=> ${lit}::vector)::float8 AS distance
      FROM "ReviewEmbedding" e
      JOIN "Review" r ON r.id = e."reviewId" AND r."accountId" = e."accountId"
      WHERE e."accountId" = ${accountId} AND e.provider = ${q.provider} AND e.embedding IS NOT NULL
        AND r.decision IS NOT NULL
        AND (${q.excludeOrderId ?? null}::text IS NULL OR r."orderId" <> ${q.excludeOrderId ?? null}::text)
      ORDER BY e.embedding <=> ${lit}::vector, e."reviewId"
      LIMIT ${k}`,
  );
  return rows.map((r) => ({ reviewId: r.reviewId, distance: Number(r.distance) }));
}

/** How many stored vectors this account has per provider. */
export async function embeddingCounts(accountId: string): Promise<Record<string, number>> {
  const rows = await inAccount(
    accountId,
    (tx) =>
      tx.$queryRaw<{ provider: string; n: number }[]>`
      SELECT provider, count(*)::int AS n FROM "ReviewEmbedding"
      WHERE "accountId" = ${accountId} AND embedding IS NOT NULL GROUP BY provider`,
  );
  return Object.fromEntries(rows.map((r) => [r.provider, r.n]));
}
