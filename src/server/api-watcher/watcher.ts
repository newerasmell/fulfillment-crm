import { readFile } from "node:fs/promises";
import path from "node:path";
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
 * connections to DRY_RUN. Fetch failures are counted per source and alerted once after FAILURE_ALERT_AFTER days
 * in a row. Spec documents are public; no credentials are used.
 *
 * Baseline: the first run seeds it from the committed raw copy our adapters were written against
 * (source.rawFile, part of the deployed build) and diffs the first live fetch against it, so a change made
 * between the last `pnpm docs:refresh` and the first deploy is still alerted. Only when the raw copy is missing
 * or unreadable does the first live fetch become the baseline.
 *
 * Crash safety: a changed version is stored with `diff.applied = false`, then connections are demoted and
 * alerts raised, then `applied` is set to true. Every run first finishes any unapplied latest version (both steps
 * are idempotent), so a failure midway is completed by the pg-boss retry or the next day's run.
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
  /** false until demotion and alerts are done; rows written before this flag existed count as applied. */
  applied?: boolean;
}

/** Loads the committed raw spec of a source (null when absent/unreadable). Test seam. */
export type BaselineLoader = (source: SpecSource) => Promise<Record<string, unknown> | null>;

function envelopeFor(source: SpecSource) {
  return source.format === "openapi" ? OpenApiEnvelope : PostmanEnvelope;
}

export const readCommittedSpec: BaselineLoader = async (source) => {
  try {
    const text = await readFile(path.join(process.cwd(), source.rawFile), "utf8");
    const parsed = envelopeFor(source).safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data as Record<string, unknown>;
    logger.warn({ vendor: source.vendor }, "committed raw spec has an unexpected shape");
  } catch (err) {
    logger.warn({ vendor: source.vendor, err: (err as Error).message }, "committed raw spec not readable");
  }
  return null;
};

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
  const parsed = envelopeFor(source).safeParse(json);
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

/** Demotion + alert for a stored change; idempotent, then marks the version applied. */
async function applyVersion(source: SpecSource, versionId: string, stored: StoredDiff): Promise<number> {
  const { breaking, additive, info } = stored.counts;
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
    body: stored.brief,
    entityType: "ApiSpecVersion",
    entityId: versionId,
  });
  await systemDb().apiSpecVersion.update({
    where: { id: versionId },
    data: { diff: { ...stored, applied: true } as unknown as Prisma.InputJsonValue },
  });
  return demoted;
}

const latestVersion = (vendor: string) =>
  systemDb().apiSpecVersion.findFirst({
    where: { vendor },
    orderBy: [{ fetchedAt: "desc" }, { id: "desc" }],
  });

/** Finishes the latest version's side effects if an earlier run stored it but failed before they were done. */
async function finishUnapplied(source: SpecSource) {
  const last = await latestVersion(source.vendor);
  const stored = last?.diff as unknown as StoredDiff | null | undefined;
  if (!last || !stored || stored.applied !== false) return;
  logger.warn({ vendor: source.vendor, versionId: last.id }, "finishing an unapplied spec change");
  await applyVersion(source, last.id, stored);
}

export async function watchSource(
  source: SpecSource,
  opts: { fetchImpl: FetchLike; now?: () => Date; baseline?: BaselineLoader },
): Promise<SpecOutcome> {
  const now = opts.now ?? (() => new Date());
  await finishUnapplied(source);
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
  let last = await latestVersion(source.vendor);
  await markSource(source.vendor, true);
  if (last?.hash === hash) return { vendor: source.vendor, outcome: "unchanged", versionId: last.id };

  const fetchedAt = now();
  if (!last) {
    const committed = await (opts.baseline ?? readCommittedSpec)(source);
    const seed = committed ? normaliseDocument(source.format, committed) : null;
    const fromLive = !seed || seed.hash === hash;
    const v = await db.apiSpecVersion.create({
      data: {
        vendor: source.vendor,
        sourceUrl: fromLive ? source.url : `repo:${source.rawFile}`,
        // The committed baseline sorts before the live version that is diffed against it.
        fetchedAt: fromLive ? fetchedAt : new Date(fetchedAt.getTime() - 1000),
        hash: fromLive ? hash : seed.hash,
        normalised: (fromLive ? spec : seed.spec) as unknown as Prisma.InputJsonValue,
      },
    });
    logger.info({ vendor: source.vendor, hash: v.hash, fromLive }, "spec baseline recorded");
    if (fromLive) return { vendor: source.vendor, outcome: "baseline", versionId: v.id };
    last = v;
  }

  const diff = diffSpecs(last.normalised as unknown as NormalisedSpec, spec);
  const brief = buildUpgradeBrief({
    source,
    diff,
    previous: { hash: last.hash, fetchedAt: last.fetchedAt },
    current: { hash, fetchedAt },
  });
  const stored: StoredDiff = { ...diff, previousId: last.id, brief, applied: false };
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
  const demoted = await applyVersion(source, v.id, stored);
  return {
    vendor: source.vendor,
    outcome: "changed",
    versionId: v.id,
    diff: { ...stored, applied: true },
    demoted,
  };
}

/** The daily job: every source, each isolated (one vendor's outage never hides another vendor's change). */
export async function runSpecWatch(
  opts: {
    fetchImpl?: FetchLike;
    now?: () => Date;
    sources?: readonly SpecSource[];
    baseline?: BaselineLoader;
  } = {},
): Promise<SpecOutcome[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const out: SpecOutcome[] = [];
  for (const source of opts.sources ?? SPEC_SOURCES) {
    try {
      out.push(await watchSource(source, { fetchImpl, now: opts.now, baseline: opts.baseline }));
    } catch (err) {
      logger.error({ vendor: source.vendor, err: (err as Error).message }, "spec watch failed");
      out.push({ vendor: source.vendor, outcome: "failed", error: "internal" });
    }
  }
  return out;
}
