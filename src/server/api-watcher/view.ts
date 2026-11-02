import type { Role } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import type { CompanyScope } from "@/server/companies";
import { accountDb, systemDb } from "@/server/db/client";
import type { SpecDiff } from "./diff";
import { SPEC_SOURCES, SHOPIFY_SOURCE, LIVE_CHECK_SOURCE, sourceLabel } from "./sources";

/**
 * Read model for Settings → API changes. Spec versions and source status are global (the same vendor docs for
 * everyone); alerts are this account's, and alerts about a store/connection of a company outside the member's
 * scope are hidden.
 */

export interface SourceRow {
  id: string;
  label: string;
  url: string | null;
  lastCheckedAt: Date | null;
  lastOkAt: Date | null;
  lastError: string | null;
  failures: number;
  latestVersion: { id: string; fetchedAt: Date; hash: string } | null;
}

export interface VersionRow {
  id: string;
  vendor: string;
  label: string;
  fetchedAt: Date;
  hash: string;
  counts: SpecDiff["counts"] | null;
  brief: string | null;
  baseline: boolean;
}

export interface AlertRow {
  id: string;
  kind: string;
  severity: string;
  status: string;
  title: string;
  body: string | null;
  createdAt: Date;
}

const SOURCE_IDS = [...SPEC_SOURCES.map((s) => s.vendor), SHOPIFY_SOURCE, LIVE_CHECK_SOURCE];

export async function apiWatchOverview(accountId: string, companyScope: CompanyScope, take = 20) {
  const sys = systemDb();
  const [sourceRows, versions, alerts] = await Promise.all([
    sys.apiWatchSource.findMany({ where: { id: { in: SOURCE_IDS } } }),
    sys.apiSpecVersion.findMany({
      orderBy: [{ fetchedAt: "desc" }, { id: "desc" }],
      take,
      select: { id: true, vendor: true, fetchedAt: true, hash: true, diff: true },
    }),
    accountDb(accountId).alert.findMany({
      where: { kind: { startsWith: "api." }, status: { not: "RESOLVED" } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
    }),
  ]);

  const latest = await Promise.all(
    SOURCE_IDS.map((vendor) =>
      sys.apiSpecVersion.findFirst({
        where: { vendor },
        orderBy: [{ fetchedAt: "desc" }, { id: "desc" }],
        select: { id: true, fetchedAt: true, hash: true },
      }),
    ),
  );
  const sources: SourceRow[] = SOURCE_IDS.map((id, i) => {
    const row = sourceRows.find((r) => r.id === id);
    return {
      id,
      label: sourceLabel(id),
      url: SPEC_SOURCES.find((s) => s.vendor === id)?.url ?? null,
      lastCheckedAt: row?.lastCheckedAt ?? null,
      lastOkAt: row?.lastOkAt ?? null,
      lastError: row?.lastError ?? null,
      failures: row?.failures ?? 0,
      latestVersion: latest[i] ?? null,
    };
  });

  const versionRows: VersionRow[] = versions.map((v) => {
    const d = v.diff as (Partial<SpecDiff> & { brief?: string }) | null;
    return {
      id: v.id,
      vendor: v.vendor,
      label: sourceLabel(v.vendor),
      fetchedAt: v.fetchedAt,
      hash: v.hash,
      counts: d?.counts ?? null,
      brief: typeof d?.brief === "string" ? d.brief : null,
      baseline: !d,
    };
  });

  let visible = alerts;
  if (companyScope) {
    const db = accountDb(accountId);
    const storeIds = alerts.filter((a) => a.entityType === "Store").map((a) => a.entityId!);
    const connIds = alerts.filter((a) => a.entityType === "FulfillmentConnection").map((a) => a.entityId!);
    const [stores, conns] = await Promise.all([
      db.store.findMany({ where: { id: { in: storeIds } }, select: { id: true, companyId: true } }),
      db.fulfillmentConnection.findMany({
        where: { id: { in: connIds } },
        select: { id: true, companyId: true },
      }),
    ]);
    const allowed = new Set(
      [...stores, ...conns].filter((x) => x.companyId && companyScope.includes(x.companyId)).map((x) => x.id),
    );
    visible = alerts.filter(
      (a) =>
        (a.entityType !== "Store" && a.entityType !== "FulfillmentConnection") ||
        allowed.has(a.entityId ?? ""),
    );
  }
  const alertRows: AlertRow[] = visible.map((a) => ({
    id: a.id,
    kind: a.kind,
    severity: a.severity,
    status: a.status,
    title: a.title,
    body: a.body,
    createdAt: a.createdAt,
  }));
  return { sources, versions: versionRows, alerts: alertRows };
}

/**
 * Marks one API-watch alert resolved (Settings → API changes). Resolving re-arms the alert: if the problem is
 * still there on the next daily run, a new one is raised. Never changes a mode.
 */
export async function resolveApiAlert(
  actor: { accountId: string; userId: string; role: Role; companyScope: CompanyScope },
  alertId: string,
) {
  assertCan(actor.role, "apiWatch.read");
  const { alerts } = await apiWatchOverview(actor.accountId, actor.companyScope, 1);
  if (!alerts.some((a) => a.id === alertId)) throw new DomainError("not_found");
  await accountDb(actor.accountId).alert.update({
    where: { id: alertId },
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "alert.resolve",
    entityType: "Alert",
    entityId: alertId,
  });
}
