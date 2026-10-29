import { systemDb } from "@/server/db/client";

// Failed attempts allowed inside the window, per email and per IP.
export const LOGIN_WINDOW_MS = 15 * 60_000;
export const MAX_FAILURES_PER_EMAIL = 5;
export const MAX_FAILURES_PER_IP = 20;

const emailKey = (email: string) => `email:${email.toLowerCase()}`;
const ipKey = (ip: string) => `ip:${ip}`;

export async function isLoginRateLimited(email: string, ip: string | null, now = new Date()) {
  const since = new Date(now.getTime() - LOGIN_WINDOW_MS);
  const db = systemDb();
  const byEmail = await db.loginAttempt.count({
    where: { key: emailKey(email), success: false, createdAt: { gte: since } },
  });
  if (byEmail >= MAX_FAILURES_PER_EMAIL) return true;
  if (!ip) return false;
  const byIp = await db.loginAttempt.count({
    where: { key: ipKey(ip), success: false, createdAt: { gte: since } },
  });
  return byIp >= MAX_FAILURES_PER_IP;
}

export async function recordLoginAttempt(email: string, ip: string | null, success: boolean) {
  const keys = [emailKey(email), ...(ip ? [ipKey(ip)] : [])];
  await systemDb().loginAttempt.createMany({ data: keys.map((key) => ({ key, success })) });
}
