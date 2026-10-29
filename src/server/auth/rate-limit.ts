import { systemDb } from "@/server/db/client";

/**
 * Login rate limiting, shared by all web instances. Every attempt is recorded BEFORE the credentials are
 * checked, so a burst of parallel requests is counted too. Limits per 15 minutes:
 *  - email + IP: 5 failures (the normal lockout; a stranger elsewhere cannot lock the user out with it),
 *  - email alone: 30 failures (ceiling against distributed guessing),
 *  - IP alone: 20 failures (one source trying many emails).
 */
export const LOGIN_WINDOW_MS = 15 * 60_000;
export const MAX_FAILURES_PER_EMAIL_IP = 5;
export const MAX_FAILURES_PER_EMAIL = 30;
export const MAX_FAILURES_PER_IP = 20;

const keysFor = (email: string, ip: string | null) => {
  const e = email.toLowerCase();
  return {
    emailIp: `email-ip:${e}|${ip ?? "-"}`,
    email: `email:${e}`,
    ip: ip ? `ip:${ip}` : null,
  };
};

/** Records the attempt as failed (until proven otherwise) and tells whether the caller is over a limit. */
export async function beginLoginAttempt(email: string, ip: string | null, now = new Date()) {
  const db = systemDb();
  const k = keysFor(email, ip);
  const keys = [k.emailIp, k.email, ...(k.ip ? [k.ip] : [])];
  const rows = await db.loginAttempt.createManyAndReturn({
    data: keys.map((key) => ({ key, success: false, createdAt: now })),
    select: { id: true },
  });
  const since = new Date(now.getTime() - LOGIN_WINDOW_MS);
  const count = (key: string) =>
    db.loginAttempt.count({ where: { key, success: false, createdAt: { gte: since } } });
  // Counts include this attempt, hence ">".
  const limited =
    (await count(k.emailIp)) > MAX_FAILURES_PER_EMAIL_IP ||
    (await count(k.email)) > MAX_FAILURES_PER_EMAIL ||
    (k.ip ? (await count(k.ip)) > MAX_FAILURES_PER_IP : false);
  return { ids: rows.map((r) => r.id), limited };
}

/** The attempt does not count as a failure (successful login, or just a missing 2FA code). */
export async function settleLoginAttempt(ids: string[]) {
  await systemDb().loginAttempt.updateMany({ where: { id: { in: ids } }, data: { success: true } });
}
