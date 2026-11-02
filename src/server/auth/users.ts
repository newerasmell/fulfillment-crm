import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { recordAudit } from "@/server/audit";
import { systemDb, withSystemTransaction } from "@/server/db/client";
import { sealToString } from "@/server/security/vault";
import { totpAad } from "./login";
import { hashPassword, MIN_PASSWORD_LENGTH } from "./password";
import { newTotpSecret, totpUri } from "./totp";

export const NewUserInput = z.object({
  email: z.email().transform((e) => e.trim().toLowerCase()),
  name: z.string().trim().min(1).max(200),
  password: z.string().min(MIN_PASSWORD_LENGTH),
});

/**
 * Inserts a user with an already-chosen password and TOTP secret in one statement (the id is generated
 * up front so the encrypted secret can be bound to it). People normally get here through an invitation
 * (src/server/invitations.ts), where they choose both themselves; nobody else ever sees them.
 */
export async function insertUserInTx(
  tx: Prisma.TransactionClient,
  input: { email: string; name: string; password: string; totpSecret: string; totpLastStep?: number | null },
) {
  const id = randomUUID();
  return tx.user.create({
    data: {
      id,
      email: input.email,
      name: input.name,
      passwordHash: await hashPassword(input.password),
      totpSecretEnc: sealToString(input.totpSecret, totpAad(id)),
      totpEnabled: true,
      totpLastStep: input.totpLastStep ?? null,
    },
    select: { id: true, email: true, name: true },
  });
}

/** Tests and local seeding only: creates a user and returns its TOTP secret. */
export async function createUser(raw: z.input<typeof NewUserInput>) {
  const input = NewUserInput.parse(raw);
  const totpSecret = newTotpSecret();
  const user = await withSystemTransaction((tx) => insertUserInTx(tx, { ...input, totpSecret }));
  await recordAudit({
    action: "user.create",
    entityType: "User",
    entityId: user.id,
    after: { email: user.email },
  });
  return { user, totpSecret, otpauthUri: totpUri(totpSecret, user.email) };
}

/** Tests and local seeding only: an OWNER with known credentials plus their first account. */
export async function bootstrapOwner(input: {
  email: string;
  name: string;
  accountName: string;
  password: string;
}) {
  const created = await createUser({ email: input.email, name: input.name, password: input.password });
  const db = systemDb();
  const account = await db.account.create({ data: { name: input.accountName } });
  await db.membership.create({ data: { accountId: account.id, userId: created.user.id, role: "OWNER" } });
  return { ...created, account };
}

/** Invalidates every session of the user (password reset, removal, suspicion). */
export async function revokeSessions(userId: string) {
  await systemDb().user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
}
