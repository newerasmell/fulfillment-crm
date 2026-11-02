import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import { systemDb } from "@/server/db/client";
import { buildUpgradeBrief } from "./brief";
import { diffSpecs, type SpecDiff } from "./diff";
import { normaliseDocument, type NormalisedSpec } from "./normalise";
import { ALERT_KINDS, demoteVendorConnections, raiseAlertEverywhere } from "./safety";
import { SPEC_SOURCES, type SpecSource } from "./sources";

/**
 * P9-01: the daily vendor spec watcher (SPEC §8). Per source: fetch → Zod-check the envelope → normalise →
 * hash → compare with the last ApiSpecVersion. A new hash stores a new version with its structured diff and
 * upgrade brief, alerts every account's admins, and — on a breaking change — drops that vendor's CANARY/LIVE
 * connections to DRY_RUN. The first fetch only records a baseline. Fetch failures are counted per source and
 * alerted once after FAILURE_ALERT_AFTER days in a row. Spec documents are public; no credentials are used.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const FAILURE_ALERT_AFTER = 3;
const MAX_SPEC_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;

const OpenApiEnvelope = z.looseObject({
  openapi: z.string(),
  info: z.looseObject({ title: z.string(), version: z.string() }),
  paths: z.record(z.string(), z.unknown()),
});
const PostmanEnvelope = z.looseObject({
  info: z.looseObject({ name: z.string() }),
  item: z.array(z.unknown()),
});

/** What is stored in ApiSpecVersion.diff (the diff plus the brief, so history needs no recomputation). */
export interface StoredDiff extends SpecDiff {
  previousId: string;
  brief: string;
}

export class SpecFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecFetchError";
  }
}

export async function fetchSpec(source: SpecSource, fetchImpl: FetchLike): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(source.url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SpecFetchError(`network: ${scrubText((err as Error).message).slice(0, 200)}`);
  }
  if (!res.ok) throw new SpecFetchError(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_SPEC_BYTES) throw new SpecFetchError("too_large");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SpecFetchError("not_json");
  }
  const parsed = (source.format === "openapi" ? OpenApiEnvelope : PostmanEnvelope).safeParse(json);
  if (!parsed.success) throw new SpecFetchError("unexpected_shape");
  return parsed.data as Record<string, unknown>;
}

export type SpecOutcome =
  | { vendor: string; outcome: "baseline" | "unchanged"; versionId?: string }
  | { vendor: string; outcome: "changed"; versionId: string; diff: StoredDiff; demoted: number }
  | { vendor: string; outcome: "failed"; error: string };

async function markSource(id: string, ok: boolean, error?: string) {
  const now = new Date();
  const db = systemDb();
  const row = await db.apiWatchSource.upsert({
    where: { id },
    create: ok
      ? { id, lastCheckedAt: now, lastOkAt: now, failures: 0 }
      : { id, lastCheckedAt: now, lastError: error ?? "failed", failures: 1 },
    update: ok
      ? { lastCheckedAt: now, lastOkAt: now, lastError: null, failures: 0 }
      : { lastCheckedAt: now, lastError: error ?? "failed", failures: { increment: 1 } },
  });
  return row;
}

export async function watchSource(
  source: SpecSource,
  opts: { fetchImpl: FetchLike; now?: () => Date },
): Promise<SpecOutcome> {
  const now = opts.now ?? (() => new Date());
  let doc: Record<string, unknown>;
  try {
    doc = await fetchSpec(source, opts.fetchImpl);
  } catch (err) {
    const error = err instanceof SpecFetchError ? err.message : "unexpected";
    const row = await markSource(source.vendor, false, error);
    logger.warn({ vendor: source.vendor, error, failures: row.failures }, "spec fetch failed");
    if (row.failures === FAILURE_ALERT_AFTER) {
      await raiseAlertEverywhere({
        kind: ALERT_KINDS.specFetchFailed,
        severity: "WARNING",
        title: `${source.label}: API spec could not be fetched ${row.failures} days in a row (${error})`,
        body: `Source: ${source.url}\nChanges in this vendor's API are not being watched until the fetch works again.`,
        entityType: "ApiWatchSource",
        entityId: source.vendor,
      });
    }
    return { vendor: source.vendor, outcome: "failed", error };
  }

  const { hash, spec } = normaliseDocument(source.format, doc);
  const db = systemDb();
  const last = await db.apiSpecVersion.findFirst({
    where: { vendor: source.vendor },
    orderBy: [{ fetchedAt: "desc" }, { id: "desc" }],
  });
  await markSource(source.vendor, true);
  if (last?.hash === hash) return { vendor: source.vendor, outcome: "unchanged", versionId: last.id };

  const fetchedAt = now();
  if (!last) {
    const v = await db.apiSpecVersion.create({
      data: {
        vendor: source.vendor,
        sourceUrl: source.url,
        fetchedAt,
        hash,
        normalised: spec as unknown as Prisma.InputJsonValue,
      },
    });
    logger.info({ vendor: source.vendor, hash }, "spec baseline recorded");
    return { vendor: source.vendor, outcome: "baseline", versionId: v.id };
  }

  const diff = diffSpecs(last.normalised as unknown as NormalisedSpec, spec);
  const brief = buildUpgradeBrief({
    source,
    diff,
    previous: { hash: last.hash, fetchedAt: last.fetchedAt },
    current: { hash, fetchedAt },
  });
  const stored: StoredDiff = { ...diff, previousId: last.id, brief };
  const v = await db.apiSpecVersion.create({
    data: {
      vendor: source.vendor,
      sourceUrl: source.url,
      fetchedAt,
      hash,
      normalised: spec as unknown as Prisma.InputJsonValue,
      diff: stored as unknown as Prisma.InputJsonValue,
    },
  });
  const { breaking, additive, info } = diff.counts;
  logger.warn({ vendor: source.vendor, breaking, additive, info }, "vendor API spec changed");

  let demoted = 0;
  if (breaking > 0) {
    demoted = (
      await demoteVendorConnections(source.vendor, `${source.label} API spec changed (${breaking} breaking)`)
    ).length;
  }
  await raiseAlertEverywhere({
    kind: ALERT_KINDS.specChange,
    severity: breaking ? "CRITICAL" : additive ? "WARNING" : "INFO",
    title: `${source.label} API changed: ${breaking} breaking, ${additive} additive, ${info} informational`,
    body: brief,
    entityType: "ApiSpecVersion",
    entityId: v.id,
  });
  return { vendor: source.vendor, outcome: "changed", versionId: v.id, diff: stored, demoted };
}

/** The daily job: every source, each isolated (one vendor's outage never hides another vendor's change). */
export async function runSpecWatch(
  opts: { fetchImpl?: FetchLike; now?: () => Date; sources?: readonly SpecSource[] } = {},
): Promise<SpecOutcome[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const out: SpecOutcome[] = [];
  for (const source of opts.sources ?? SPEC_SOURCES) {
    try {
      out.push(await watchSource(source, { fetchImpl, now: opts.now }));
    } catch (err) {
      logger.error({ vendor: source.vendor, err: (err as Error).message }, "spec watch failed");
      out.push({ vendor: source.vendor, outcome: "failed", error: "internal" });
    }
  }
  return out;
}
