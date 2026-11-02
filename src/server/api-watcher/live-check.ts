import type { z } from "zod";
import type { ConnectionType } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { systemDb } from "@/server/db/client";
import { ALERT_KINDS, demoteConnection, demoteStore, raiseAlert } from "./safety";
import { LIVE_CHECK_SOURCE } from "./sources";

/**
 * P9-02: daily read-only live schema check (SPEC §8). For every store/connection that has credentials, the
 * adapter's LiveCheck runs its read-only probes (GET/list or GraphQL queries — never a write) and
 * Zod-validates the real responses. Outcomes:
 *  - breaking issue (response no longer matches our schema, field gone, query rejected): CRITICAL alert and the
 *    store/connection drops to DRY_RUN (never raised), audit-logged;
 *  - non-breaking issue (new field, unknown enum value, version retiring soon): WARNING alert only;
 *  - probe could not run (auth, network, vendor down): WARNING alert, no mode change — we did not learn
 *    anything about the schema.
 * Adapters plug in with `registerLiveCheck` (Shopify now; FHB v3, Joy and euShipments when their adapters exist).
 */

export type LiveCheckTargetType = "SHOPIFY" | ConnectionType;

export interface LiveCheckTarget {
  accountId: string;
  kind: "store" | "connection";
  id: string;
  name: string;
  type: LiveCheckTargetType;
}

export interface LiveCheckIssue {
  breaking: boolean;
  /** Which probe found it, e.g. "orders" or "GET /stock". */
  probe: string;
  code: "schema_mismatch" | "query_rejected" | "new_field" | "unknown_enum" | "version" | string;
  /** Path inside the response (no values: responses may hold personal data). */
  path?: string;
  message: string;
}

export interface LiveCheckReport {
  probes: string[];
  issues: LiveCheckIssue[];
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Test seam: the probes' HTTP goes through this when given (tests never reach a vendor). */
export interface LiveCheckContext {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: Date;
}

export interface LiveCheck {
  type: LiveCheckTargetType;
  /** Must only read. Throw when the probe cannot run at all (auth/network); report schema problems as issues. */
  run(target: LiveCheckTarget, ctx: LiveCheckContext): Promise<LiveCheckReport>;
}

const registry = new Map<LiveCheckTargetType, LiveCheck>();

export function registerLiveCheck(check: LiveCheck) {
  registry.set(check.type, check);
}

export function liveCheckFor(type: LiveCheckTargetType): LiveCheck | undefined {
  return registry.get(type);
}

export function registeredLiveChecks(): LiveCheckTargetType[] {
  return [...registry.keys()];
}

/** For tests only. */
export function unregisterLiveCheck(type: LiveCheckTargetType) {
  registry.delete(type);
}

// ───────────────────────── validation helpers for adapters ─────────────────────────

const MAX_ISSUES_PER_PROBE = 10;

const pathOf = (path: readonly PropertyKey[]) =>
  path
    .map((p) => (typeof p === "number" ? "[]" : String(p)))
    .join(".")
    .replace(/\.\[\]/g, "[]");

/** Keys present in the raw response that the schema does not know (Zod strips them). Names only. */
export function unknownKeys(raw: unknown, parsed: unknown, path = "", out = new Set<string>(), depth = 0) {
  if (depth > 12 || raw === null || parsed === null || typeof raw !== "object" || typeof parsed !== "object")
    return out;
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    raw.forEach((r, i) => unknownKeys(r, parsed[i], `${path}[]`, out, depth + 1));
    return out;
  }
  if (Array.isArray(raw) || Array.isArray(parsed)) return out;
  const p = parsed as Record<string, unknown>;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const at = path ? `${path}.${k}` : k;
    if (!(k in p)) out.add(at);
    else unknownKeys(v, p[k], at, out, depth + 1);
  }
  return out;
}

/**
 * Validates one probe's response: schema failures are breaking issues (with paths, never values), keys the
 * schema does not know are non-breaking "new_field" issues.
 */
export function validateProbe<S extends z.ZodType>(
  probe: string,
  schema: S,
  raw: unknown,
): { data?: z.infer<S>; issues: LiveCheckIssue[] } {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.slice(0, MAX_ISSUES_PER_PROBE).map((i) => ({
        breaking: true,
        probe,
        code: "schema_mismatch",
        path: pathOf(i.path),
        message: i.message.slice(0, 200),
      })),
    };
  }
  const extra = [...unknownKeys(raw, parsed.data)].slice(0, MAX_ISSUES_PER_PROBE);
  return {
    data: parsed.data,
    issues: extra.map((path) => ({ breaking: false, probe, code: "new_field", path, message: "new field" })),
  };
}

/** Unknown enum/status value: stored raw and alerted, never thrown (CLAUDE.md). */
export function checkEnum(
  probe: string,
  path: string,
  value: string | null | undefined,
  known: ReadonlySet<string>,
): LiveCheckIssue | undefined {
  if (value === null || value === undefined || known.has(value)) return undefined;
  return {
    breaking: false,
    probe,
    code: "unknown_enum",
    path,
    message: `unknown value "${value.slice(0, 60)}"`,
  };
}

// ───────────────────────── runner ─────────────────────────

export async function liveCheckTargets(): Promise<LiveCheckTarget[]> {
  const db = systemDb();
  const stores = await db.store.findMany({
    where: { credentialId: { not: null } },
    select: { id: true, accountId: true, name: true, connectionStatus: true },
    orderBy: { id: "asc" },
  });
  const conns = await db.fulfillmentConnection.findMany({
    where: { credentialId: { not: null }, enabled: true },
    select: { id: true, accountId: true, name: true, type: true },
    orderBy: { id: "asc" },
  });
  return [
    // A store whose connection test fails is the connection test's problem (its own status + UI), not ours.
    ...stores
      .filter((s) => (s.connectionStatus as { ok?: boolean }).ok === true)
      .map((s) => ({
        accountId: s.accountId,
        kind: "store" as const,
        id: s.id,
        name: s.name,
        type: "SHOPIFY" as const,
      })),
    ...conns.map((c) => ({
      accountId: c.accountId,
      kind: "connection" as const,
      id: c.id,
      name: c.name,
      type: c.type,
    })),
  ];
}

export type LiveCheckOutcome =
  | { status: "skipped" }
  | { status: "ok"; report: LiveCheckReport }
  | { status: "issues"; report: LiveCheckReport; breaking: boolean; demoted: boolean }
  | { status: "failed"; error: string };

const entityType = (t: LiveCheckTarget) => (t.kind === "store" ? "Store" : "FulfillmentConnection");

function issueLines(issues: LiveCheckIssue[]) {
  return issues
    .slice(0, 40)
    .map(
      (i) =>
        `- ${i.breaking ? "BREAKING" : "note"} [${i.probe}] ${i.code}${i.path ? ` at ${i.path}` : ""}: ${i.message}`,
    )
    .join("\n");
}

/** Runs one target's live check and acts on the result. Idempotent: alerts dedupe, demotion never raises. */
export async function runLiveCheck(
  target: LiveCheckTarget,
  ctx: LiveCheckContext = {},
): Promise<LiveCheckOutcome> {
  const check = liveCheckFor(target.type);
  if (!check) return { status: "skipped" };
  let report: LiveCheckReport;
  try {
    report = await check.run(target, ctx);
  } catch (err) {
    const error = ((err as { code?: string }).code ?? (err as Error).name ?? "error").slice(0, 60);
    logger.warn({ target: target.id, type: target.type, error }, "live check could not run");
    await raiseAlert(target.accountId, {
      kind: ALERT_KINDS.liveCheckFailed,
      severity: "WARNING",
      title: `Live check of ${target.name} could not run (${error})`,
      body: "The read-only probe failed before any response could be checked. Modes are unchanged.",
      entityType: entityType(target),
      entityId: target.id,
    });
    return { status: "failed", error };
  }
  if (!report.issues.length) return { status: "ok", report };

  const breaking = report.issues.filter((i) => i.breaking);
  let demoted = false;
  if (breaking.length) {
    const reason = `live check: ${breaking.length} breaking response mismatch(es)`;
    demoted = (
      target.kind === "store"
        ? await demoteStore(target.accountId, target.id, reason)
        : await demoteConnection(target.accountId, target.id, reason)
    ).demoted;
  }
  logger.warn(
    { target: target.id, type: target.type, breaking: breaking.length, total: report.issues.length, demoted },
    "live check found differences",
  );
  await raiseAlert(target.accountId, {
    kind: ALERT_KINDS.liveCheck,
    severity: breaking.length ? "CRITICAL" : "WARNING",
    title: breaking.length
      ? `${target.name}: real ${target.type} responses no longer match our schema${demoted ? " — dropped to DRY_RUN" : ""}`
      : `${target.name}: ${target.type} responses contain undocumented changes`,
    body: [
      breaking.length
        ? "Writes stay in DRY_RUN until the adapter is fixed and an OWNER raises the mode again."
        : "Nothing breaks today; check whether the schemas or status maps need the new values.",
      "",
      issueLines(report.issues),
    ].join("\n"),
    entityType: entityType(target),
    entityId: target.id,
  });
  return { status: "issues", report, breaking: breaking.length > 0, demoted };
}

export async function markLiveCheckSweep(now = new Date()) {
  await systemDb().apiWatchSource.upsert({
    where: { id: LIVE_CHECK_SOURCE },
    create: { id: LIVE_CHECK_SOURCE, lastCheckedAt: now, lastOkAt: now },
    update: { lastCheckedAt: now, lastOkAt: now, lastError: null, failures: 0 },
  });
}
