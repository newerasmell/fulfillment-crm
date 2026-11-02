import type { Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { parseDiff, type FieldChange } from "@/server/review/diff";
import type { ScopedActor } from "@/server/stores";
import { shape } from "./case-text";
import { maskValue } from "./fields";

/**
 * P8-04 weekly rule mining (SPEC §7.3): repeated operator corrections (Review diffs) are clustered into
 * deterministic validator / auto-fix proposals, e.g. "HU phones starting 06 → +36". An admin accepts or rejects
 * each one; an accepted proposal is only RECORDED as work for a developer (a Claude Code session writes the
 * validator with tests) — nothing is generated or executed at runtime.
 *
 * Clusters (pure, mineCorrections):
 *   phone_prefix — the phone's digits keep their tail and the start changes (06… → +36…), per country;
 *   zip_format   — the postcode keeps its digits and only the format changes (12345 → 123 45), per country;
 *   value_map    — the same city / province value is corrected to the same value again and again, per country.
 */

const SUPERSEDED = "superseded";
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

export interface MinedCluster {
  key: string;
  kind: "phone_prefix" | "zip_format" | "value_map";
  field: string;
  country: string | null;
  pattern: Record<string, string>;
  titleBg: string;
  titleEn: string;
  support: number;
  orderIds: Set<string>;
  examples: { from: string | null; to: string | null }[];
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface CorrectionRow {
  orderId: string;
  countryCode: string | null;
  decidedAt: Date;
  change: FieldChange;
}

const digits = (v: string) => v.replace(/\D/g, "");

/** 06301234567 → +36301234567 gives {from: "06", to: "+36"} (the common tail is at least 6 digits). */
export function phonePrefixChange(from: string | null, to: string | null) {
  if (!from || !to) return null;
  const f = digits(from);
  const plus = to.trim().startsWith("+");
  const t = digits(to);
  let n = 0;
  while (n < f.length && n < t.length && f[f.length - 1 - n] === t[t.length - 1 - n]) n++;
  if (n < 6) return null;
  // An international number keeps at least a two-digit calling code ("+36", not "+3" plus a shared "6").
  while (plus && t.length - n < 2 && n > 6) n--;
  const fromPrefix = f.slice(0, f.length - n);
  const toPrefix = (plus ? "+" : "") + t.slice(0, t.length - n);
  if (fromPrefix === toPrefix || (!fromPrefix && !plus)) return null;
  return { from: fromPrefix || "(none)", to: toPrefix };
}

export function zipFormatChange(from: string | null, to: string | null) {
  if (!from || !to || digits(from) !== digits(to) || !digits(from)) return null;
  const a = shape(from);
  const b = shape(to);
  return a === b ? null : { from: a, to: b };
}

const VALUE_FIELDS = new Set(["shippingAddress.city", "shippingAddress.province"]);
const cleanValue = (v: string | null) => (v ?? "").replace(/\s+/g, " ").trim();

export function mineCorrections(rows: readonly CorrectionRow[], minOrders = 5): MinedCluster[] {
  const clusters = new Map<string, MinedCluster>();
  const add = (
    row: CorrectionRow,
    base: Omit<MinedCluster, "support" | "orderIds" | "examples" | "firstSeenAt" | "lastSeenAt">,
  ) => {
    const c =
      clusters.get(base.key) ??
      ({
        ...base,
        support: 0,
        orderIds: new Set(),
        examples: [],
        firstSeenAt: row.decidedAt,
        lastSeenAt: row.decidedAt,
      } as MinedCluster);
    c.support++;
    c.orderIds.add(row.orderId);
    if (c.examples.length < 3)
      c.examples.push({
        from: maskValue(row.change.field, row.change.from),
        to: maskValue(row.change.field, row.change.to),
      });
    if (row.decidedAt < c.firstSeenAt) c.firstSeenAt = row.decidedAt;
    if (row.decidedAt > c.lastSeenAt) c.lastSeenAt = row.decidedAt;
    clusters.set(base.key, c);
  };
  for (const row of rows) {
    const country = row.countryCode?.toUpperCase() ?? null;
    const cc = country ?? "??";
    const { field, from, to } = row.change;
    if (field === "phone") {
      const p = phonePrefixChange(from, to);
      if (p)
        add(row, {
          key: `phone_prefix:${cc}:${p.from}→${p.to}`,
          kind: "phone_prefix",
          field,
          country,
          pattern: { from: p.from, to: p.to },
          titleBg: `${cc}: телефони, започващи с ${p.from} → ${p.to}`,
          titleEn: `${cc}: phones starting ${p.from} → ${p.to}`,
        });
    } else if (field === "shippingAddress.zip") {
      const z = zipFormatChange(from, to);
      if (z)
        add(row, {
          key: `zip_format:${cc}:${z.from}→${z.to}`,
          kind: "zip_format",
          field,
          country,
          pattern: { from: z.from, to: z.to },
          titleBg: `${cc}: пощенски код ${z.from} → ${z.to}`,
          titleEn: `${cc}: postcode ${z.from} → ${z.to}`,
        });
    } else if (VALUE_FIELDS.has(field)) {
      const a = cleanValue(from);
      const b = cleanValue(to);
      if (a && b && a.toLowerCase() !== b.toLowerCase()) {
        const label = field === "shippingAddress.city" ? ["град", "city"] : ["област", "province"];
        add(row, {
          key: `value_map:${field}:${cc}:${a.toLowerCase()}→${b}`,
          kind: "value_map",
          field,
          country,
          pattern: { from: a, to: b },
          titleBg: `${cc}: ${label[0]} „${a}“ → „${b}“`,
          titleEn: `${cc}: ${label[1]} "${a}" → "${b}"`,
        });
      }
    }
  }
  return [...clusters.values()]
    .filter((c) => c.orderIds.size >= minOrders)
    .sort((a, b) => b.orderIds.size - a.orderIds.size);
}

/** Weekly job: cluster the corrections of the last `days` and upsert proposals (decided ones keep their status). */
export async function mineRules(
  accountId: string,
  now = new Date(),
  opts: { days?: number; minOrders?: number } = {},
) {
  const db = accountDb(accountId);
  const since = new Date(now.getTime() - (opts.days ?? 90) * 86_400_000);
  const reviews = await db.review.findMany({
    where: {
      decision: { not: null },
      decidedAt: { gte: since },
      OR: [{ reasonCode: null }, { reasonCode: { not: SUPERSEDED } }],
    },
    select: { orderId: true, diff: true, decidedAt: true, order: { select: { countryCode: true } } },
    take: 20_000,
  });
  const rows: CorrectionRow[] = reviews.flatMap((r) =>
    parseDiff(r.diff).map((change) => ({
      orderId: r.orderId,
      countryCode: r.order.countryCode,
      decidedAt: r.decidedAt!,
      change,
    })),
  );
  const clusters = mineCorrections(rows, opts.minOrders ?? 5);
  for (const c of clusters) {
    const data = {
      kind: c.kind,
      field: c.field,
      country: c.country,
      pattern: json(c.pattern),
      titleBg: c.titleBg,
      titleEn: c.titleEn,
      examples: json(c.examples),
      support: c.support,
      distinctOrders: c.orderIds.size,
      firstSeenAt: c.firstSeenAt,
      lastSeenAt: c.lastSeenAt,
      minedAt: now,
    };
    await db.aiRuleProposal.upsert({
      where: { accountId_key: { accountId, key: c.key } },
      create: { accountId, key: c.key, ...data },
      update: data,
    });
  }
  return clusters.length;
}

/** The developer brief of a proposal (markdown, for a Claude Code session). Deterministic text, no code. */
export function proposalBrief(p: {
  key: string;
  kind: string;
  field: string;
  country: string | null;
  pattern: unknown;
  titleEn: string;
  support: number;
  distinctOrders: number;
  examples: unknown;
}) {
  const pattern = (p.pattern ?? {}) as Record<string, string>;
  const examples = Array.isArray(p.examples)
    ? (p.examples as { from: string | null; to: string | null }[])
    : [];
  return [
    `# Validator proposal: ${p.titleEn}`,
    "",
    `- Key: \`${p.key}\``,
    `- Kind: ${p.kind} · field \`${p.field}\` · country ${p.country ?? "any"}`,
    `- Evidence: ${p.support} operator corrections on ${p.distinctOrders} orders (Review diffs).`,
    `- Pattern: \`${pattern.from ?? ""}\` → \`${pattern.to ?? ""}\``,
    "",
    "Examples (masked):",
    ...examples.map((e) => `- \`${e.from ?? "∅"}\` → \`${e.to ?? "∅"}\``),
    "",
    "Task: add a deterministic finding with a suggestedFix to the validator engine (src/server/checks) or the",
    "vendor validators, with bg/en messages and unit tests built from synthetic values. Do not auto-apply COD or",
    "recipient changes. Record the change in docs/PROGRESS.md.",
  ].join("\n");
}

export async function decideProposal(
  actor: ScopedActor,
  id: string,
  verdict: "accept" | "reject",
  note?: string | null,
  now = new Date(),
) {
  assertCan(actor.role, "ai.rules");
  const text = note?.trim().slice(0, 1000) || null;
  await withAccountTransaction(actor.accountId, async (tx) => {
    const p = await tx.aiRuleProposal.findUnique({ where: { id } });
    if (!p) throw new DomainError("not_found");
    const moved = await tx.aiRuleProposal.updateMany({
      where: { id, status: "PROPOSED" },
      data: {
        status: verdict === "accept" ? "ACCEPTED" : "REJECTED",
        decidedById: actor.userId,
        decidedAt: now,
        decisionNote: text,
      },
    });
    if (!moved.count) throw new DomainError("already_decided");
    await tx.auditLog.create({
      data: {
        accountId: actor.accountId,
        userId: actor.userId,
        action: `ai.rule.${verdict}`,
        entityType: "AiRuleProposal",
        entityId: id,
        after: json({ key: p.key, note: text }),
      },
    });
    if (verdict === "accept")
      // A task for the developer: the proposal becomes code-level rules with tests in a Claude Code session.
      await tx.alert.create({
        data: {
          accountId: actor.accountId,
          kind: "ai_rule_accepted",
          isTask: true,
          severity: "INFO",
          title: `Accepted validator proposal for a developer: ${p.titleEn}`,
          body: proposalBrief(p),
          entityType: "AiRuleProposal",
          entityId: id,
        },
      });
  });
}
