import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Role } from "@/generated/prisma/client";
import { DomainError, type Actor } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { MIN_PASSWORD_LENGTH } from "@/server/auth/password";
import { assertCan, canAssignRole, ForbiddenError, ROLES } from "@/server/auth/rbac";
import { newTotpSecret, totpUri, verifyTotp } from "@/server/auth/totp";
import { insertUserInTx } from "@/server/auth/users";
import {
  isUniqueViolation,
  systemDb,
  withAccountTransaction,
  withSystemTransaction,
} from "@/server/db/client";
import { openFromString, sealToString } from "@/server/security/vault";

/**
 * Invitations replace handing out passwords. An admin gets a single-use link (shown once); the invitee
 * either enrols (chooses a password + scans a fresh 2FA key) or, if they already have a profile, logs in and
 * accepts. The invitation page looks the same whether or not the email already has a profile, and an
 * existing user is never added to a company without accepting.
 * The 2FA key for a new profile is generated fresh on every page view and travels only inside the form,
 * sealed (AES-GCM, bound to the invitation, 30-minute expiry): someone who previews the link learns nothing
 * the invitee will later use.
 * Residual risk until links are delivered by email: whoever holds the link (the inviter) can open it first.
 */

export const INVITE_TTL_MS = 72 * 3600_000;
export const OWNER_INVITE_TTL_MS = 24 * 3600_000;

const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const enrolAad = (invitationId: string) => `enrol:${invitationId}`;
export const ENROL_FORM_TTL_MS = 30 * 60_000;

export const InviteInput = z.object({
  email: z.email().transform((e) => e.trim().toLowerCase()),
  name: z.string().trim().max(200).optional(),
  role: z.enum(ROLES as [Role, ...Role[]]),
});

export async function inviteMember(actor: Actor, raw: z.input<typeof InviteInput>) {
  assertCan(actor.role, "members.manage");
  const input = InviteInput.parse(raw);
  if (!canAssignRole(actor.role, input.role)) throw new ForbiddenError("members.grantOwner");
  const token = newToken();
  const invitation = await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    // Serialises concurrent invites (one open invitation per email and company: a new link replaces the old).
    await lockForUpdate("Membership");
    await tx.invitation.updateMany({
      where: { email: input.email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return tx.invitation.create({
      data: {
        accountId: actor.accountId,
        email: input.email,
        name: input.name || null,
        role: input.role,
        tokenHash: hashToken(token),
        invitedById: actor.userId,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "member.invite",
    entityType: "Invitation",
    entityId: invitation.id,
    after: { email: input.email, role: input.role },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return { invitationId: invitation.id, token, expiresAt: invitation.expiresAt };
}

export async function listOpenInvitations(actor: Actor) {
  assertCan(actor.role, "members.manage");
  return withAccountTransaction(actor.accountId, (tx) =>
    tx.invitation.findMany({
      where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
  );
}

export async function revokeInvitation(actor: Actor, invitationId: string) {
  assertCan(actor.role, "members.manage");
  const res = await withAccountTransaction(actor.accountId, (tx) =>
    tx.invitation.updateMany({
      where: { id: invitationId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  );
  if (res.count !== 1) throw new DomainError("not_found");
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "member.invite_revoke",
    entityType: "Invitation",
    entityId: invitationId,
  });
}

/** GATE P0-G1: a new company and an OWNER invitation for it. The link is printed once by the CLI. */
export async function createOwnerInvitation(input: { email: string; accountName: string }) {
  const email = z.email().parse(input.email.trim().toLowerCase());
  const accountName = z.string().trim().min(2).max(200).parse(input.accountName);
  const token = newToken();
  const { account, invitation } = await withSystemTransaction(async (tx) => {
    const account = await tx.account.create({ data: { name: accountName } });
    const invitation = await tx.invitation.create({
      data: {
        accountId: account.id,
        email,
        role: "OWNER",
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + OWNER_INVITE_TTL_MS),
      },
    });
    return { account, invitation };
  });
  await recordAudit({
    accountId: account.id,
    action: "account.create",
    entityType: "Account",
    entityId: account.id,
    after: { name: accountName, ownerInvitation: invitation.id },
  });
  return { account, token, expiresAt: invitation.expiresAt };
}

/** Looks an invitation up by its token (system scope: the visitor is not in the company yet). */
export async function findOpenInvitation(token: string) {
  if (!token || token.length > 100) return null;
  const inv = await systemDb().invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { account: { select: { name: true } } },
  });
  if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt <= new Date()) return null;
  const user = await systemDb().user.findUnique({ where: { email: inv.email }, select: { id: true } });
  return { invitation: inv, accountName: inv.account.name, existingUserId: user?.id ?? null };
}

/**
 * The enrolment form's 2FA key: a NEW secret on every call, returned with a sealed copy for the form.
 * Nothing is stored, so previewing the link reveals nothing that the invitee will use.
 */
export async function enrolmentForm(token: string) {
  const found = await findOpenInvitation(token);
  if (!found) throw new DomainError("invalid_invitation");
  const secret = newTotpSecret();
  const sealed = sealToString(
    JSON.stringify({ s: secret, exp: Date.now() + ENROL_FORM_TTL_MS }),
    enrolAad(found.invitation.id),
  );
  return {
    secret,
    sealed,
    otpauthUri: totpUri(secret, found.invitation.email),
    email: found.invitation.email,
    name: found.invitation.name,
    accountName: found.accountName,
  };
}

function openSealedSecret(sealed: string, invitationId: string): string {
  let parsed: { s?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(openFromString(sealed, enrolAad(invitationId)));
  } catch {
    throw new DomainError("invalid_invitation");
  }
  if (typeof parsed.s !== "string" || typeof parsed.exp !== "number")
    throw new DomainError("invalid_invitation");
  if (parsed.exp < Date.now()) throw new DomainError("form_expired");
  return parsed.s;
}

export const EnrolInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    password: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
    passwordRepeat: z.string(),
    code: z.string().trim(),
    sealedSecret: z.string().min(1).max(2000),
  })
  .refine((v) => v.password === v.passwordRepeat, { message: "password_mismatch", path: ["passwordRepeat"] });

/** New user: creates the profile and the membership and consumes the invitation — all or nothing. */
export async function completeEnrolment(token: string, raw: z.input<typeof EnrolInput>) {
  const input = EnrolInput.parse(raw);
  const found = await findOpenInvitation(token);
  if (!found) throw new DomainError("invalid_invitation");
  const inv = found.invitation;
  const secret = openSealedSecret(input.sealedSecret, inv.id);
  const step = await verifyTotp(secret, input.code);
  if (step === null) throw new DomainError("invalid_code");
  // An existing profile joins by signing in and accepting, never by creating a second one.
  if (found.existingUserId) throw new DomainError("use_login");
  const user = await withSystemTransaction(async (tx) => {
    const consumed = await tx.invitation.updateMany({
      where: { id: inv.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { acceptedAt: new Date() },
    });
    if (consumed.count !== 1) throw new DomainError("invalid_invitation");
    const user = await insertUserInTx(tx, {
      email: inv.email,
      name: input.name,
      password: input.password,
      totpSecret: secret,
      totpLastStep: step, // the code just typed cannot be replayed at login
    });
    await tx.membership.create({ data: { accountId: inv.accountId, userId: user.id, role: inv.role } });
    return user;
  }).catch((err: unknown) => {
    // The same email got a profile elsewhere a moment ago: it now has to sign in and accept instead.
    if (isUniqueViolation(err)) throw new DomainError("use_login");
    throw err;
  });
  await recordAudit({
    accountId: inv.accountId,
    userId: user.id,
    action: "member.join",
    entityType: "Invitation",
    entityId: inv.id,
    after: { email: user.email, role: inv.role, newUser: true },
  });
  return user;
}

/** Existing user (logged in as the invited email): joins the company. */
export async function acceptInvitation(token: string, userId: string) {
  const found = await findOpenInvitation(token);
  if (!found || found.existingUserId !== userId) throw new DomainError("invalid_invitation");
  const inv = found.invitation;
  await withSystemTransaction(async (tx) => {
    const consumed = await tx.invitation.updateMany({
      where: { id: inv.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { acceptedAt: new Date() },
    });
    if (consumed.count !== 1) throw new DomainError("invalid_invitation");
    const existing = await tx.membership.findUnique({
      where: { userId_accountId: { userId, accountId: inv.accountId } },
    });
    if (!existing) await tx.membership.create({ data: { accountId: inv.accountId, userId, role: inv.role } });
  });
  await recordAudit({
    accountId: inv.accountId,
    userId,
    action: "member.join",
    entityType: "Invitation",
    entityId: inv.id,
    after: { role: inv.role, newUser: false },
  });
}
