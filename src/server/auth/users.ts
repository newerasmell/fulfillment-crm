import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Role } from "@/generated/prisma/client";
import { recordAudit } from "@/server/audit";
import { systemDb } from "@/server/db/client";
import { sealToString } from "@/server/security/vault";
import { totpAad } from "./login";
import { hashPassword, MIN_PASSWORD_LENGTH } from "./password";
import { newTotpSecret, totpUri } from "./totp";

export const NewUserInput = z.object({
  email: z.email().transform((e) => e.trim().toLowerCase()),
  name: z.string().trim().min(1).max(200),
  password: z.string().min(MIN_PASSWORD_LENGTH).optional(),
});

export function generatePassword() {
  return randomBytes(18).toString("base64url");
}

/**
 * Creates a user with a fresh TOTP secret. The password (if generated) and the otpauth URI are returned
 * ONCE so they can be handed to the person; neither is stored in clear.
 */
export async function createUser(
  raw: z.input<typeof NewUserInput>,
  actor?: { userId?: string; accountId?: string },
) {
  const input = NewUserInput.parse(raw);
  const password = input.password ?? generatePassword();
  const totpSecret = newTotpSecret();
  const db = systemDb();
  const user = await db.user.create({
    data: {
      email: input.email,
      name: input.name,
      passwordHash: await hashPassword(password),
      totpEnabled: true,
    },
  });
  await db.user.update({
    where: { id: user.id },
    data: { totpSecretEnc: sealToString(totpSecret, totpAad(user.id)) },
  });
  await recordAudit({
    accountId: actor?.accountId ?? null,
    userId: actor?.userId ?? null,
    action: "user.create",
    entityType: "User",
    entityId: user.id,
    after: { email: user.email, name: user.name },
  });
  return {
    user: { id: user.id, email: user.email, name: user.name },
    password: input.password ? undefined : password,
    totpSecret,
    otpauthUri: totpUri(totpSecret, user.email),
  };
}

/** First OWNER + first account in one step (used at GATE P0-G1). */
export async function bootstrapOwner(input: {
  email: string;
  name: string;
  accountName: string;
  password?: string;
}) {
  const created = await createUser({ email: input.email, name: input.name, password: input.password });
  const db = systemDb();
  const account = await db.account.create({ data: { name: input.accountName } });
  await db.membership.create({
    data: { accountId: account.id, userId: created.user.id, role: "OWNER" satisfies Role },
  });
  await recordAudit({
    accountId: account.id,
    userId: created.user.id,
    action: "account.create",
    entityType: "Account",
    entityId: account.id,
    after: { name: account.name },
  });
  return { ...created, account };
}

/** Invalidates every session of the user (password reset, removal, suspicion). */
export async function revokeSessions(userId: string) {
  await systemDb().user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
}
