import type { Prisma } from "@/generated/prisma/client";
import { SHOPIFY_API_VERSION } from "@/integrations/shopify/config";
import { logger } from "@/lib/logger";
import { systemDb } from "@/server/db/client";
import { sha256 } from "./normalise";
import { ALERT_KINDS, raiseAlertEverywhere } from "./safety";
import { SHOPIFY_SOURCE } from "./sources";

/**
 * Shopify API version deprecation watch (SPEC §4/§8). Shopify releases a stable Admin API version every
 * quarter and supports each one for at least 12 months. Two signals:
 *  1. the calendar: our pinned version's support window, from its YYYY-MM handle (daily, no network);
 *  2. what Shopify reports: `publicApiVersions { handle supported }`, read by the live check of a connected
 *     store and recorded here as ApiSpecVersion(vendor SHOPIFY) — global, the list is the same for every shop.
 */

export const SUPPORT_MONTHS = 12;
export const WARN_DAYS = 90;
export const CRITICAL_DAYS = 30;

export interface ApiVersionInfo {
  handle: string;
  supported: boolean;
}

export interface ShopifyVersionsSpec {
  pinned: string;
  versions: ApiVersionInfo[];
}

/** Earliest end of support of a YYYY-MM version (release month + 12 months, first day, UTC). */
export function supportEndsAt(handle: string): Date | null {
  const m = /^(\d{4})-(\d{2})$/.exec(handle);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + SUPPORT_MONTHS, 1));
}

export type VersionStatus =
  | { level: "ok"; daysLeft: number | null }
  | { level: "warning" | "critical"; daysLeft: number | null; reason: string };

/** Pure: how urgent an upgrade of the pinned version is. */
export function evaluatePinnedVersion(
  pinned: string,
  now: Date,
  reported?: readonly ApiVersionInfo[],
): VersionStatus {
  const end = supportEndsAt(pinned);
  const daysLeft = end ? Math.floor((end.getTime() - now.getTime()) / 86_400_000) : null;
  if (reported?.length) {
    const mine = reported.find((v) => v.handle === pinned);
    if (!mine || !mine.supported)
      return { level: "critical", daysLeft, reason: `Shopify no longer lists ${pinned} as supported` };
  }
  if (daysLeft !== null && daysLeft <= CRITICAL_DAYS)
    return { level: "critical", daysLeft, reason: `support for ${pinned} ends in ${daysLeft} days` };
  if (daysLeft !== null && daysLeft <= WARN_DAYS)
    return { level: "warning", daysLeft, reason: `support for ${pinned} ends in ${daysLeft} days` };
  if (reported?.length) {
    const dated = reported.filter((v) => v.supported && /^\d{4}-\d{2}$/.test(v.handle)).map((v) => v.handle);
    if (dated.length > 1 && dated.sort()[0] === pinned)
      return {
        level: "warning",
        daysLeft,
        reason: `${pinned} is the oldest supported version (next to be retired)`,
      };
  }
  return { level: "ok", daysLeft };
}

async function latestReported(): Promise<ApiVersionInfo[] | undefined> {
  const last = await systemDb().apiSpecVersion.findFirst({
    where: { vendor: SHOPIFY_SOURCE },
    orderBy: [{ fetchedAt: "desc" }, { id: "desc" }],
  });
  return (last?.normalised as unknown as ShopifyVersionsSpec | undefined)?.versions;
}

/** Stores the version list Shopify reported if it changed since the last record. */
export async function recordShopifyVersions(versions: ApiVersionInfo[], now = new Date()) {
  const sorted = [...versions].sort((a, b) => a.handle.localeCompare(b.handle));
  const spec: ShopifyVersionsSpec = { pinned: SHOPIFY_API_VERSION, versions: sorted };
  const hash = sha256(JSON.stringify(sorted));
  const db = systemDb();
  const last = await db.apiSpecVersion.findFirst({
    where: { vendor: SHOPIFY_SOURCE },
    orderBy: [{ fetchedAt: "desc" }, { id: "desc" }],
  });
  if (last?.hash === hash) return { changed: false };
  const before = new Map(
    ((last?.normalised as unknown as ShopifyVersionsSpec | undefined)?.versions ?? []).map((v) => [
      v.handle,
      v.supported,
    ]),
  );
  const after = new Map(sorted.map((v) => [v.handle, v.supported]));
  const diff = last
    ? {
        previousId: last.id,
        added: sorted.filter((v) => !before.has(v.handle)).map((v) => v.handle),
        removed: [...before.keys()].filter((h) => !after.has(h)),
        supportChanged: sorted
          .filter((v) => before.has(v.handle) && before.get(v.handle) !== v.supported)
          .map((v) => `${v.handle}: ${v.supported ? "supported" : "unsupported"}`),
      }
    : undefined;
  await db.apiSpecVersion.create({
    data: {
      vendor: SHOPIFY_SOURCE,
      sourceUrl: "shopify:publicApiVersions",
      fetchedAt: now,
      hash,
      normalised: spec as unknown as Prisma.InputJsonValue,
      ...(diff ? { diff: diff as unknown as Prisma.InputJsonValue } : {}),
    },
  });
  return { changed: true };
}

/** Daily: alerts admins when the pinned Shopify version needs an upgrade soon. */
export async function runShopifyVersionWatch(now = new Date()) {
  const status = evaluatePinnedVersion(SHOPIFY_API_VERSION, now, await latestReported());
  await systemDb().apiWatchSource.upsert({
    where: { id: SHOPIFY_SOURCE },
    create: { id: SHOPIFY_SOURCE, lastCheckedAt: now, lastOkAt: now },
    update: { lastCheckedAt: now, lastOkAt: now, lastError: null, failures: 0 },
  });
  if (status.level === "ok") return status;
  logger.warn({ pinned: SHOPIFY_API_VERSION, ...status }, "shopify api version needs an upgrade");
  await raiseAlertEverywhere({
    kind: ALERT_KINDS.shopifyVersion,
    severity: status.level === "critical" ? "CRITICAL" : "WARNING",
    title: `Shopify Admin API ${SHOPIFY_API_VERSION}: ${status.reason}`,
    body: [
      `Pinned version: ${SHOPIFY_API_VERSION} (src/integrations/shopify/config.ts).`,
      "Read the Shopify release notes of the newer versions, bump SHOPIFY_API_VERSION, re-check every query",
      "in src/integrations/shopify/ against the new schema and run the query-cost and Shopify tests.",
    ].join("\n"),
    entityType: "ShopifyApiVersion",
    entityId: SHOPIFY_API_VERSION,
  });
  return status;
}
