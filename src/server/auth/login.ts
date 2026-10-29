import { recordAudit } from "@/server/audit";
import { systemDb } from "@/server/db/client";
import { openFromString } from "@/server/security/vault";
import { dummyPasswordHash, verifyPassword } from "./password";
import { isLoginRateLimited, recordLoginAttempt } from "./rate-limit";
import { verifyTotp } from "./totp";

export type LoginFailure = "invalid" | "rate_limited" | "totp_required";

export interface LoginInput {
  email: string;
  password: string;
  code: string;
  ip: string | null;
  userAgent: string | null;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  sessionVersion: number;
}

export const totpAad = (userId: string) => `totp:${userId}`;

/**
 * Email + password + TOTP. Every user has 2FA (SPEC §9); a user without an enrolled secret cannot log in.
 * Errors are deliberately generic ("invalid") so they do not reveal which factor failed.
 */
export async function verifyLogin(
  input: LoginInput,
): Promise<{ ok: true; user: SessionUser } | { ok: false; reason: LoginFailure }> {
  const email = input.email.trim().toLowerCase();
  if (await isLoginRateLimited(email, input.ip)) {
    await recordAudit({
      action: "auth.login_rate_limited",
      after: { email },
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return { ok: false, reason: "rate_limited" };
  }
  if (!input.code.trim()) return { ok: false, reason: "totp_required" };

  const db = systemDb();
  const user = await db.user.findUnique({ where: { email } });
  const passwordOk = await verifyPassword(user?.passwordHash ?? (await dummyPasswordHash()), input.password);

  let step: number | null = null;
  if (user && passwordOk && !user.disabled && user.totpEnabled && user.totpSecretEnc) {
    const secret = openFromString(user.totpSecretEnc, totpAad(user.id));
    step = await verifyTotp(secret, input.code, user.totpLastStep);
  }

  if (!user || step === null) {
    await recordLoginAttempt(email, input.ip, false);
    await recordAudit({
      userId: user?.id ?? null,
      action: "auth.login_failed",
      after: { email },
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return { ok: false, reason: "invalid" };
  }

  // Conditional update: two concurrent logins with the same code cannot both succeed.
  const claimed = await db.user.updateMany({
    where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
    data: { totpLastStep: step, lastLoginAt: new Date() },
  });
  if (claimed.count !== 1) {
    await recordLoginAttempt(email, input.ip, false);
    return { ok: false, reason: "invalid" };
  }
  await recordLoginAttempt(email, input.ip, true);
  await recordAudit({ userId: user.id, action: "auth.login", ip: input.ip, userAgent: input.userAgent });
  return {
    ok: true,
    user: { id: user.id, email: user.email, name: user.name, sessionVersion: user.sessionVersion },
  };
}
