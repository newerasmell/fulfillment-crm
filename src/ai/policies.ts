import { z } from "zod";
import type { AiLevel, Prisma } from "@/generated/prisma/client";
import { DomainError, type Actor } from "@/server/accounts";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { AI_APPROVAL_DECISION } from "@/server/pipeline";
import { globalKillSwitch } from "./config";

/**
 * P8-03 autonomy levels per group × decision type (SPEC §7.4):
 *   L0 Shadow  — the AI suggests, people decide; agreement is measured.
 *   L1 Assist  — the AI's fixes can be applied with one click; a person still approves.
 *   L2 Autopilot (order_approval only) — clean orders the AI confidently approves are approved by the AI
 *              through the pipeline's approve guard; everything else goes to people.
 * Promotion (an OWNER's click, one level at a time) needs, in the window: ≥ minDecisions compared decisions,
 * ≥ minAgreement agreement and zero critical misses. Demotion to L0 is automatic on any critical miss since the
 * last level change, or when agreement falls below the threshold (enforcePolicies). The group's AI stop
 * (AiControl.killSwitch) and the env AI_KILL_SWITCH stop everything.
 */

export { AI_APPROVAL_DECISION };
export const ADDRESS_FIX_DECISION = "address_fix";

export const DECISION_TYPES = {
  [AI_APPROVAL_DECISION]: { maxLevel: "L2" },
  [ADDRESS_FIX_DECISION]: { maxLevel: "L1" },
} as const satisfies Record<string, { maxLevel: AiLevel }>;
export type DecisionType = keyof typeof DECISION_TYPES;
export const DECISION_TYPE_LIST = Object.keys(DECISION_TYPES) as DecisionType[];
export const isDecisionType = (v: string): v is DecisionType => Object.hasOwn(DECISION_TYPES, v);

const LEVELS: AiLevel[] = ["L0", "L1", "L2"];
const levelIndex = (l: AiLevel) => LEVELS.indexOf(l);

/** SPEC minimums: an owner may make the rule stricter, never looser. */
export const SPEC_MIN_DECISIONS = 300;
export const SPEC_MIN_AGREEMENT = 0.98;

export const Thresholds = z.object({
  windowDays: z.number().int().min(7).max(180).default(30),
  minDecisions: z.number().int().min(SPEC_MIN_DECISIONS).max(100_000).default(SPEC_MIN_DECISIONS),
  minAgreement: z.number().min(SPEC_MIN_AGREEMENT).max(1).default(SPEC_MIN_AGREEMENT),
  /** L2: the AI's confidence must be at least this to approve on its own. */
  autoConfidence: z.number().min(0.8).max(1).default(0.95),
  /** Share of autopilot approvals a person audits every day. */
  auditRate: z.number().min(0.05).max(1).default(0.05),
  /** Agreement demotion only once this many decisions are in the window (noise guard). */
  demoteMinSample: z.number().int().min(20).max(10_000).default(50),
  /**
   * High-value orders always need a person: total ≥ amount in the order's currency. A currency without an
   * amount here counts as high value (unknown → human).
   */
  highValue: z
    .record(z.string().regex(/^[A-Z]{3}$/), z.number().positive())
    .default({ EUR: 300, BGN: 590, RON: 1500, HUF: 120_000, CZK: 7500, PLN: 1300 }),
});
export type Thresholds = z.infer<typeof Thresholds>;

/** Stored thresholds, defaults for anything missing or invalid (a bad row never loosens the rule). */
export function parseThresholds(v: unknown): Thresholds {
  const r = Thresholds.safeParse(v && typeof v === "object" ? v : {});
  return r.success ? r.data : Thresholds.parse({});
}

export interface PolicyView {
  id: string | null;
  decisionType: DecisionType;
  level: AiLevel;
  enabled: boolean;
  thresholds: Thresholds;
  maxLevel: AiLevel;
}

type Db = ReturnType<typeof accountDb> | Prisma.TransactionClient;

export async function loadPolicy(db: Db, decisionType: DecisionType): Promise<PolicyView> {
  const row = await (db as Prisma.TransactionClient).aiPolicy.findFirst({ where: { decisionType } });
  return {
    id: row?.id ?? null,
    decisionType,
    level: row?.level ?? "L0",
    enabled: row?.enabled ?? false,
    thresholds: parseThresholds(row?.thresholds),
    maxLevel: DECISION_TYPES[decisionType].maxLevel,
  };
}

export async function listPolicies(accountId: string) {
  const db = accountDb(accountId);
  return Promise.all(DECISION_TYPE_LIST.map((t) => loadPolicy(db, t)));
}

/** Is the AI stopped for this group (group switch or global env)? */
export async function aiStopped(db: Db): Promise<boolean> {
  if (globalKillSwitch()) return true;
  const c = await (db as Prisma.TransactionClient).aiControl.findFirst({ select: { killSwitch: true } });
  return c?.killSwitch ?? false;
}

export async function aiControlView(accountId: string) {
  const c = await accountDb(accountId).aiControl.findFirst();
  return {
    killSwitch: c?.killSwitch ?? false,
    changedAt: c?.changedAt ?? null,
    changedById: c?.changedById ?? null,
    note: c?.note ?? null,
    global: globalKillSwitch(),
  };
}

// ───────────────────────── stats ─────────────────────────

export interface PolicyStats {
  windowDays: number;
  decisions: number;
  agreed: number;
  agreement: number | null;
  criticalMisses: number;
  /** Critical misses since the last level change (what triggers demotion). */
  criticalSinceLevel: number;
  levelSince: Date | null;
  autopilot: number;
}

export async function policyStats(
  accountId: string,
  decisionType: DecisionType,
  thresholds: Thresholds,
  now = new Date(),
): Promise<PolicyStats> {
  const db = accountDb(accountId);
  const since = new Date(now.getTime() - thresholds.windowDays * 86_400_000);
  const flag = decisionType === AI_APPROVAL_DECISION ? "decisionAgreed" : "fixesAgreed";
  const lastLevel = await db.aiPolicyEvent.findFirst({
    where: { decisionType, toLevel: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const levelSince = lastLevel?.createdAt ?? null;
  const [decisions, agreed, critical, criticalSince, autopilot] = await Promise.all([
    db.aiSuggestion.count({ where: { evaluatedAt: { gte: since }, [flag]: { not: null } } }),
    db.aiSuggestion.count({ where: { evaluatedAt: { gte: since }, [flag]: true } }),
    decisionType === AI_APPROVAL_DECISION
      ? db.aiSuggestion.count({ where: { evaluatedAt: { gte: since }, criticalMiss: true } })
      : Promise.resolve(0),
    decisionType === AI_APPROVAL_DECISION
      ? db.aiSuggestion.count({
          where: { criticalMiss: true, ...(levelSince ? { evaluatedAt: { gte: levelSince } } : {}) },
        })
      : Promise.resolve(0),
    decisionType === AI_APPROVAL_DECISION
      ? db.aiSuggestion.count({ where: { autoApprovedAt: { gte: since } } })
      : Promise.resolve(0),
  ]);
  return {
    windowDays: thresholds.windowDays,
    decisions,
    agreed,
    agreement: decisions ? agreed / decisions : null,
    criticalMisses: critical,
    criticalSinceLevel: criticalSince,
    levelSince,
    autopilot,
  };
}

export interface PromotionCheck {
  eligible: boolean;
  next: AiLevel | null;
  missing: ("decisions" | "agreement" | "critical" | "max_level" | "disabled" | "stopped")[];
}

/** The SPEC promotion rule (pure). */
export function promotionCheck(
  p: Pick<PolicyView, "level" | "enabled" | "maxLevel" | "thresholds">,
  s: Pick<PolicyStats, "decisions" | "agreement" | "criticalMisses">,
  stopped = false,
): PromotionCheck {
  const missing: PromotionCheck["missing"] = [];
  const next =
    levelIndex(p.level) < levelIndex(p.maxLevel) ? (LEVELS[levelIndex(p.level) + 1] ?? null) : null;
  if (!next) missing.push("max_level");
  if (!p.enabled) missing.push("disabled");
  if (stopped) missing.push("stopped");
  if (s.decisions < p.thresholds.minDecisions) missing.push("decisions");
  if (s.agreement == null || s.agreement < p.thresholds.minAgreement) missing.push("agreement");
  if (s.criticalMisses > 0) missing.push("critical");
  return { eligible: missing.length === 0, next, missing };
}

/** Automatic demotion rule (pure): returns the cause, or null to keep the level. */
export function demotionCause(
  p: Pick<PolicyView, "level" | "enabled" | "thresholds">,
  s: Pick<PolicyStats, "decisions" | "agreement" | "criticalSinceLevel">,
): "demote_critical" | "demote_agreement" | null {
  if (p.level === "L0" || !p.enabled) return null;
  if (s.criticalSinceLevel > 0) return "demote_critical";
  if (s.decisions >= p.thresholds.demoteMinSample && (s.agreement ?? 0) < p.thresholds.minAgreement)
    return "demote_agreement";
  return null;
}

// ───────────────────────── changes ─────────────────────────

const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

async function writePolicy(
  tx: Prisma.TransactionClient,
  accountId: string,
  decisionType: DecisionType,
  change: { level?: AiLevel; enabled?: boolean; thresholds?: Thresholds },
  event: { cause: string; userId: string | null; stats?: unknown },
) {
  const before = await tx.aiPolicy.findFirst({ where: { decisionType } });
  const row = before
    ? await tx.aiPolicy.update({
        where: { id: before.id },
        data: {
          ...(change.level ? { level: change.level } : {}),
          ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
          ...(change.thresholds ? { thresholds: json(change.thresholds) } : {}),
        },
      })
    : await tx.aiPolicy.create({
        data: {
          accountId,
          decisionType,
          level: change.level ?? "L0",
          enabled: change.enabled ?? false,
          thresholds: json(change.thresholds ?? Thresholds.parse({})),
        },
      });
  const levelChanged = (before?.level ?? "L0") !== row.level;
  const enabledChanged = (before?.enabled ?? false) !== row.enabled;
  if (levelChanged || enabledChanged || event.cause === "thresholds") {
    await tx.aiPolicyEvent.create({
      data: {
        accountId,
        policyId: row.id,
        decisionType,
        fromLevel: levelChanged ? (before?.level ?? "L0") : null,
        toLevel: levelChanged ? row.level : null,
        fromEnabled: enabledChanged ? (before?.enabled ?? false) : null,
        toEnabled: enabledChanged ? row.enabled : null,
        cause: event.cause,
        userId: event.userId,
        stats: event.stats === undefined ? undefined : json(event.stats),
      },
    });
    await tx.auditLog.create({
      data: {
        accountId,
        userId: event.userId,
        action: `ai.policy.${event.cause}`,
        entityType: "AiPolicy",
        entityId: row.id,
        before: json(
          before ? { level: before.level, enabled: before.enabled, thresholds: before.thresholds } : null,
        ),
        after: json({ level: row.level, enabled: row.enabled, thresholds: row.thresholds }),
      },
    });
  }
  return row;
}

function decisionTypeOf(raw: string): DecisionType {
  if (!isDecisionType(raw)) throw new DomainError("invalid_decision_type");
  return raw;
}

/** Switch a decision type on (at its current level; L0 shadow for a new one) or off. OWNER only. */
export async function setPolicyEnabled(actor: Actor, rawType: string, enabled: boolean) {
  assertCan(actor.role, "ai.manage");
  const decisionType = decisionTypeOf(rawType);
  return withAccountTransaction(actor.accountId, (tx) =>
    writePolicy(
      tx,
      actor.accountId,
      decisionType,
      { enabled },
      { cause: enabled ? "enable" : "disable", userId: actor.userId },
    ),
  );
}

/** One level up, only when the SPEC rule holds right now (re-evaluated here, not trusted from the UI). */
export async function promotePolicy(actor: Actor, rawType: string, now = new Date()) {
  assertCan(actor.role, "ai.manage");
  const decisionType = decisionTypeOf(rawType);
  const db = accountDb(actor.accountId);
  const policy = await loadPolicy(db, decisionType);
  const stats = await policyStats(actor.accountId, decisionType, policy.thresholds, now);
  const check = promotionCheck(policy, stats, await aiStopped(db));
  if (!check.eligible || !check.next) throw new DomainError(`not_eligible:${check.missing.join(",")}`);
  return withAccountTransaction(actor.accountId, async (tx) => {
    // The level must still be the one that was evaluated (two owners clicking at once promote once).
    const current = await loadPolicy(tx, decisionType);
    if (current.level !== policy.level || !current.enabled) throw new DomainError("stale");
    return writePolicy(
      tx,
      actor.accountId,
      decisionType,
      { level: check.next! },
      {
        cause: "promote",
        userId: actor.userId,
        stats,
      },
    );
  });
}

/** A person may always lower a level (to any lower one). */
export async function demotePolicy(actor: Actor, rawType: string, to: AiLevel) {
  assertCan(actor.role, "ai.manage");
  const decisionType = decisionTypeOf(rawType);
  if (!LEVELS.includes(to)) throw new DomainError("invalid_level");
  return withAccountTransaction(actor.accountId, async (tx) => {
    const current = await loadPolicy(tx, decisionType);
    if (levelIndex(to) >= levelIndex(current.level)) throw new DomainError("not_lower");
    return writePolicy(
      tx,
      actor.accountId,
      decisionType,
      { level: to },
      { cause: "demote_manual", userId: actor.userId },
    );
  });
}

export async function saveThresholds(actor: Actor, rawType: string, raw: unknown) {
  assertCan(actor.role, "ai.manage");
  const decisionType = decisionTypeOf(rawType);
  const thresholds = Thresholds.parse(raw);
  return withAccountTransaction(actor.accountId, (tx) =>
    writePolicy(
      tx,
      actor.accountId,
      decisionType,
      { thresholds },
      { cause: "thresholds", userId: actor.userId },
    ),
  );
}

/** The group's AI stop. On: no AI review runs and no AI approval is accepted (pipeline guard). OWNER only. */
export async function setAiKillSwitch(actor: Actor, on: boolean, note?: string | null) {
  assertCan(actor.role, "ai.manage");
  const text = note?.trim().slice(0, 500) || null;
  return withAccountTransaction(actor.accountId, async (tx) => {
    const before = await tx.aiControl.findFirst();
    const now = new Date();
    const row = before
      ? await tx.aiControl.update({
          where: { id: before.id },
          data: { killSwitch: on, changedAt: now, changedById: actor.userId, note: text },
        })
      : await tx.aiControl.create({
          data: {
            accountId: actor.accountId,
            killSwitch: on,
            changedAt: now,
            changedById: actor.userId,
            note: text,
          },
        });
    await tx.auditLog.create({
      data: {
        accountId: actor.accountId,
        userId: actor.userId,
        action: on ? "ai.kill_switch.on" : "ai.kill_switch.off",
        entityType: "AiControl",
        entityId: row.id,
        before: json({ killSwitch: before?.killSwitch ?? false }),
        after: json({ killSwitch: on, note: text }),
        ip: actor.ip ?? null,
        userAgent: actor.userAgent?.slice(0, 300) ?? null,
      },
    });
    return row;
  });
}

export const POLICY_DEMOTED_ALERT = "ai_policy_demoted";

/**
 * Automatic demotion (worker, after each evaluation and audit verdict): any critical miss since the last level
 * change, or agreement below the threshold, drops the policy to L0 and raises an alert for the owners.
 */
export async function enforcePolicies(accountId: string, now = new Date()) {
  const out: { decisionType: DecisionType; cause: string }[] = [];
  for (const decisionType of DECISION_TYPE_LIST) {
    const policy = await loadPolicy(accountDb(accountId), decisionType);
    if (policy.level === "L0" || !policy.enabled) continue;
    const stats = await policyStats(accountId, decisionType, policy.thresholds, now);
    const cause = demotionCause(policy, stats);
    if (!cause) continue;
    await withAccountTransaction(accountId, async (tx) => {
      const current = await loadPolicy(tx, decisionType);
      if (current.level === "L0") return;
      await writePolicy(tx, accountId, decisionType, { level: "L0" }, { cause, userId: null, stats });
      await tx.alert.create({
        data: {
          accountId,
          kind: POLICY_DEMOTED_ALERT,
          severity: "CRITICAL",
          title:
            cause === "demote_critical"
              ? `AI policy ${decisionType} dropped to L0 (shadow): a critical miss`
              : `AI policy ${decisionType} dropped to L0 (shadow): agreement below the threshold`,
          entityType: "AiPolicy",
          entityId: current.id,
        },
      });
    });
    out.push({ decisionType, cause });
  }
  return out;
}
