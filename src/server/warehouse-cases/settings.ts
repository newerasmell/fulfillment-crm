import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";

/**
 * Per company (owner request 2026-11-18): the warehouse email addresses of „Блокирани в склад“, the company's own
 * Gmail the emails are sent from, when each email is due and the customer email. Each company sends from its own
 * Gmail; the CRM only assembles the text (copy / paste) and records what was sent.
 */

export interface EscalationSettings {
  companyId: string;
  senderEmail: string | null;
  warehouseTo: string[];
  warehouseCc: string[];
  escalationTo: string[];
  flagHours: number;
  firstEmailHours: number;
  reminderHours: number;
  decisionHours: number;
  workDaysOnly: boolean;
  discountPercent: number | null;
  customerSubject: string | null;
  customerBody: string | null;
}

/** Owner: a stuck order must be shipped or cancelled within 2–3 days. */
export const ESCALATION_DEFAULTS = {
  flagHours: 12,
  firstEmailHours: 24,
  reminderHours: 48,
  decisionHours: 72,
  workDaysOnly: true,
} as const;

export const defaultsFor = (companyId: string): EscalationSettings => ({
  companyId,
  senderEmail: null,
  warehouseTo: [],
  warehouseCc: [],
  escalationTo: [],
  ...ESCALATION_DEFAULTS,
  discountPercent: null,
  customerSubject: null,
  customerBody: null,
});

const email = z.string().trim().toLowerCase().email().max(200);
/** "a@x.com, b@y.com" or one per line → a clean list (duplicates dropped). */
export function parseEmailList(raw: string) {
  const parts = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const r = email.safeParse(p);
    if (!r.success) throw new DomainError("invalid_email");
    if (!out.includes(r.data)) out.push(r.data);
  }
  if (out.length > 20) throw new DomainError("too_many_emails");
  return out;
}

const hours = z.coerce
  .number()
  .int()
  .min(1)
  .max(24 * 14);
export const EscalationInput = z
  .object({
    companyId: z.string().min(1).max(64),
    senderEmail: z.string().trim().max(200).optional().default(""),
    warehouseTo: z.string().max(4000).optional().default(""),
    warehouseCc: z.string().max(4000).optional().default(""),
    escalationTo: z.string().max(4000).optional().default(""),
    flagHours: hours,
    firstEmailHours: hours,
    reminderHours: hours,
    decisionHours: hours,
    workDaysOnly: z.boolean(),
    discountPercent: z
      .union([z.literal(""), z.coerce.number().int().min(1).max(90)])
      .optional()
      .default(""),
    customerSubject: z.string().trim().max(300).optional().default(""),
    customerBody: z.string().trim().max(5000).optional().default(""),
  })
  .refine(
    (v) =>
      v.flagHours <= v.firstEmailHours &&
      v.firstEmailHours < v.reminderHours &&
      v.reminderHours < v.decisionHours,
    { message: "order" },
  );

export async function getEscalationSettings(
  accountId: string,
  companyId: string,
): Promise<EscalationSettings> {
  const row = await accountDb(accountId).companyEscalationSettings.findUnique({
    where: { accountId_companyId: { accountId, companyId } },
  });
  return row ? toSettings(row) : defaultsFor(companyId);
}

export async function escalationSettingsByCompany(accountId: string) {
  const rows = await accountDb(accountId).companyEscalationSettings.findMany({});
  return new Map(rows.map((r) => [r.companyId, toSettings(r)]));
}

function toSettings(r: EscalationSettings & Record<string, unknown>): EscalationSettings {
  return {
    companyId: r.companyId,
    senderEmail: r.senderEmail,
    warehouseTo: r.warehouseTo,
    warehouseCc: r.warehouseCc,
    escalationTo: r.escalationTo,
    flagHours: r.flagHours,
    firstEmailHours: r.firstEmailHours,
    reminderHours: r.reminderHours,
    decisionHours: r.decisionHours,
    workDaysOnly: r.workDaysOnly,
    discountPercent: r.discountPercent,
    customerSubject: r.customerSubject,
    customerBody: r.customerBody,
  };
}

/** Saves a company's settings (owners and admins). */
export async function saveEscalationSettings(actor: ScopedActor, raw: z.input<typeof EscalationInput>) {
  assertCan(actor.role, "companies.manage");
  const parsed = EscalationInput.safeParse(raw);
  if (!parsed.success)
    throw new DomainError(parsed.error.issues.some((i) => i.message === "order") ? "hours_order" : "invalid");
  const v = parsed.data;
  if (actor.companyScope && !actor.companyScope.includes(v.companyId)) throw new DomainError("not_found");
  const db = accountDb(actor.accountId);
  const company = await db.company.findFirst({ where: { id: v.companyId }, select: { id: true } });
  if (!company) throw new DomainError("not_found");
  const sender = v.senderEmail ? parseEmailList(v.senderEmail) : [];
  if (sender.length > 1) throw new DomainError("invalid_email");
  const data = {
    senderEmail: sender[0] ?? null,
    warehouseTo: parseEmailList(v.warehouseTo),
    warehouseCc: parseEmailList(v.warehouseCc),
    escalationTo: parseEmailList(v.escalationTo),
    flagHours: v.flagHours,
    firstEmailHours: v.firstEmailHours,
    reminderHours: v.reminderHours,
    decisionHours: v.decisionHours,
    workDaysOnly: v.workDaysOnly,
    discountPercent: v.discountPercent === "" ? null : v.discountPercent,
    customerSubject: v.customerSubject || null,
    customerBody: v.customerBody || null,
    updatedById: actor.userId,
  };
  await db.companyEscalationSettings.upsert({
    where: { accountId_companyId: { accountId: actor.accountId, companyId: v.companyId } },
    create: { accountId: actor.accountId, companyId: v.companyId, ...data },
    update: data,
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "company.escalation_settings",
    entityType: "Company",
    entityId: v.companyId,
    after: { ...data, customerBody: data.customerBody ? `${data.customerBody.length} chars` : null },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}
