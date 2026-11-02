import type { Prisma } from "@/generated/prisma/client";
import { accountDb, systemDb } from "@/server/db/client";

/**
 * Audit log: who did what, before/after. Every mutation in the app calls `recordAudit`.
 * Secret-looking fields are stripped from before/after so the log can never leak credentials.
 */

export interface AuditEntry {
  accountId?: string | null;
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

const SECRET_KEY = /pass(word)?|secret|token|ciphertext|authtag|^iv$|apikey|totp|credential(s)?$/i;

export function scrubForAudit(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || depth > 8) return value ?? null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => scrubForAudit(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "[REDACTED]" : scrubForAudit(v, depth + 1);
    }
    return out;
  }
  return value;
}

const asJson = (v: unknown) =>
  v === undefined ? undefined : (scrubForAudit(v) as Prisma.InputJsonValue | typeof Prisma.JsonNull);

export async function recordAudit(entry: AuditEntry) {
  const data = {
    userId: entry.userId ?? null,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    before: asJson(entry.before),
    after: asJson(entry.after),
    ip: entry.ip ?? null,
    userAgent: entry.userAgent?.slice(0, 300) ?? null,
  };
  if (entry.accountId) {
    return accountDb(entry.accountId).auditLog.create({ data: { ...data, accountId: entry.accountId } });
  }
  // System-level events (e.g. a failed login, no account known yet).
  return systemDb().auditLog.create({ data: { ...data, accountId: null } });
}

export interface AuditListOptions {
  take?: number;
  cursor?: string;
  action?: string;
}

export async function listAudit(accountId: string, opts: AuditListOptions = {}) {
  const take = Math.min(Math.max(opts.take ?? 50, 1), 200);
  const rows = await accountDb(accountId).auditLog.findMany({
    where: opts.action ? { action: opts.action } : {},
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > take;
  return { rows: rows.slice(0, take), nextCursor: hasMore ? rows[take - 1]?.id : undefined };
}
