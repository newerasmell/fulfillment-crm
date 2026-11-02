import { logger } from "@/lib/logger";
import type { Finding } from "@/server/checks/findings";
import { accountDb } from "@/server/db/client";
import { embeddingCounts, nearestReviews, upsertReviewEmbedding } from "@/server/db/vector";
import { parseDiff } from "@/server/review/diff";
import { caseText, type CaseInput } from "./case-text";
import { embeddingProviders, textHash } from "./embeddings";
import { maskValue } from "./fields";

/**
 * P8-01: embeddings of decided reviews + similar-case retrieval with pgvector. A decided Review becomes a "case"
 * (case-text.ts: country, address/phone shapes, finding codes, corrected fields) embedded by every configured
 * provider; an order to review is embedded the same way and the nearest decided reviews of the SAME group are
 * returned (RLS + explicit accountId), never the order's own earlier reviews.
 */

/** Superseded sessions (closed by another reviewer's decision) are not decisions. */
const SUPERSEDED = "superseded";

const findingCodes = (v: unknown) =>
  Array.isArray(v)
    ? (v as Finding[]).map((f) => f?.code).filter((c): c is string => typeof c === "string")
    : [];

type ReviewForCase = {
  findings: unknown;
  diff: unknown;
  order: {
    countryCode: string | null;
    paymentMethod: string;
    phone: string | null;
    shippingAddress: unknown;
    shippingAddressOriginal: unknown;
  };
};

/** The case of a decided review: the data as the operator saw it (diff `from` values over the original). */
export function reviewCase(r: ReviewForCase): CaseInput {
  const diff = parseDiff(r.diff);
  const base = (r.order.shippingAddressOriginal ?? r.order.shippingAddress ?? {}) as Record<string, unknown>;
  const pick = (k: string) => {
    const c = diff.find((d) => d.field === `shippingAddress.${k}`);
    if (c) return c.from;
    const v = base[k];
    return typeof v === "string" ? v : null;
  };
  const phoneChange = diff.find((d) => d.field === "phone");
  return {
    countryCode: r.order.countryCode,
    paymentMethod: r.order.paymentMethod,
    phone: phoneChange ? phoneChange.from : r.order.phone,
    address: { address1: pick("address1"), address2: pick("address2"), city: pick("city"), zip: pick("zip") },
    findingCodes: findingCodes(r.findings),
    correctedFields: diff.map((d) => d.field),
  };
}

/** Embeds decided reviews that have no vector (or a stale one) yet, for every configured provider. */
export async function embedPendingReviews(accountId: string, limit = 200) {
  const db = accountDb(accountId);
  let written = 0;
  for (const provider of embeddingProviders()) {
    const reviews = await db.review.findMany({
      where: {
        decision: { not: null },
        OR: [{ reasonCode: null }, { reasonCode: { not: SUPERSEDED } }],
        embeddings: { none: { provider: provider.name } },
      },
      orderBy: { decidedAt: "desc" },
      take: limit,
      select: {
        id: true,
        findings: true,
        diff: true,
        order: {
          select: {
            countryCode: true,
            paymentMethod: true,
            phone: true,
            shippingAddress: true,
            shippingAddressOriginal: true,
          },
        },
      },
    });
    for (let i = 0; i < reviews.length; i += 64) {
      const chunk = reviews.slice(i, i + 64);
      const texts = chunk.map((r) => caseText(reviewCase(r)));
      let vectors: number[][];
      try {
        vectors = await provider.embed(texts, "document");
      } catch (err) {
        logger.warn({ provider: provider.name, err: String(err) }, "review embedding failed");
        break;
      }
      for (const [j, review] of chunk.entries()) {
        await upsertReviewEmbedding(accountId, {
          reviewId: review.id,
          provider: provider.name,
          model: provider.model,
          textHash: textHash(texts[j]!),
          vector: vectors[j]!,
        });
        written++;
      }
    }
  }
  return written;
}

export interface SimilarCase {
  reviewId: string;
  distance: number;
  decision: string;
  reasonCode: string | null;
  countryCode: string | null;
  findingCodes: string[];
  /** Operator corrections, personal values masked. */
  corrections: { field: string; from: string | null; to: string | null }[];
}

/** The k most similar decided reviews for this case (first provider that has vectors and answers). */
export async function similarCases(
  accountId: string,
  input: CaseInput,
  opts: { k?: number; excludeOrderId?: string | null } = {},
): Promise<{ provider: string | null; cases: SimilarCase[] }> {
  const k = opts.k ?? 20;
  const counts = await embeddingCounts(accountId);
  const text = caseText(input);
  for (const provider of embeddingProviders()) {
    if (!counts[provider.name]) continue;
    let vector: number[] | undefined;
    try {
      [vector] = await provider.embed([text], "query");
    } catch (err) {
      logger.warn({ provider: provider.name, err: String(err) }, "query embedding failed");
      continue;
    }
    if (!vector) continue;
    const near = await nearestReviews(accountId, {
      provider: provider.name,
      vector,
      k,
      excludeOrderId: opts.excludeOrderId ?? null,
    });
    if (!near.length) return { provider: provider.name, cases: [] };
    const rows = await accountDb(accountId).review.findMany({
      where: { id: { in: near.map((n) => n.reviewId) } },
      select: {
        id: true,
        decision: true,
        reasonCode: true,
        findings: true,
        diff: true,
        order: { select: { countryCode: true } },
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const cases = near.flatMap((n): SimilarCase[] => {
      const r = byId.get(n.reviewId);
      if (!r?.decision) return [];
      return [
        {
          reviewId: r.id,
          distance: Math.round(n.distance * 1000) / 1000,
          decision: r.decision,
          reasonCode: r.reasonCode,
          countryCode: r.order.countryCode,
          findingCodes: findingCodes(r.findings),
          corrections: parseDiff(r.diff).map((d) => ({
            field: d.field,
            from: maskValue(d.field, d.from),
            to: maskValue(d.field, d.to),
          })),
        },
      ];
    });
    return { provider: provider.name, cases };
  }
  return { provider: null, cases: [] };
}
