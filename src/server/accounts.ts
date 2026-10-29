import { z } from "zod";
import type { Role } from "@/generated/prisma/client";
import { recordAudit } from "@/server/audit";
import { assertCan, ForbiddenError, ROLES } from "@/server/auth/rbac";
import { accountDb, systemDb, withAccountTransaction } from "@/server/db/client";

/** Who is acting, in which account. Built from the session by the web layer. */
export interface Actor {
  userId: string;
  accountId: string;
  role: Role;
  ip?: string | null;
  userAgent?: string | null;
}

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

const RoleSchema = z.enum(ROLES as [Role, ...Role[]]);

export const NewAccountInput = z.object({ name: z.string().trim().min(2).max(200) });

/** A new company. The creator becomes its OWNER. */
export async function createAccount(actor: Actor, raw: z.input<typeof NewAccountInput>) {
  assertCan(actor.role, "account.create");
  const { name } = NewAccountInput.parse(raw);
  const sys = systemDb();
  const account = await sys.account.create({ data: { name } });
  await sys.membership.create({ data: { accountId: account.id, userId: actor.userId, role: "OWNER" } });
  await recordAudit({
    accountId: account.id,
    userId: actor.userId,
    action: "account.create",
    entityType: "Account",
    entityId: account.id,
    after: { name, createdFromAccountId: actor.accountId },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return account;
}

export async function listMembers(actor: Actor) {
  assertCan(actor.role, "account.read");
  return accountDb(actor.accountId).membership.findMany({
    select: {
      id: true,
      role: true,
      createdAt: true,
      user: { select: { id: true, email: true, name: true, disabled: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}

/** Changing or removing members must never leave the account without an OWNER. */
async function guardOwnerChange(actor: Actor, membershipId: string, nextRole: Role | null) {
  return withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    // Lock the account's memberships so two concurrent demotions cannot both see "2 owners".
    await lockForUpdate("Membership");
    const target = await tx.membership.findUnique({ where: { id: membershipId } });
    if (!target) throw new DomainError("not_found");
    if ((target.role === "OWNER" || nextRole === "OWNER") && actor.role !== "OWNER") {
      throw new ForbiddenError("members.grantOwner");
    }
    if (target.role === "OWNER" && nextRole !== "OWNER") {
      const owners = await tx.membership.count({ where: { role: "OWNER" } });
      if (owners <= 1) throw new DomainError("last_owner");
    }
    if (nextRole) {
      return {
        before: target,
        after: await tx.membership.update({ where: { id: membershipId }, data: { role: nextRole } }),
      };
    }
    await tx.membership.delete({ where: { id: membershipId } });
    return { before: target, after: null };
  });
}

export async function changeMemberRole(actor: Actor, membershipId: string, role: Role) {
  assertCan(actor.role, "members.manage");
  RoleSchema.parse(role);
  const { before, after } = await guardOwnerChange(actor, membershipId, role);
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "member.role_change",
    entityType: "Membership",
    entityId: membershipId,
    before: { role: before.role },
    after: { role: after?.role },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return after;
}

export async function removeMember(actor: Actor, membershipId: string) {
  assertCan(actor.role, "members.manage");
  const { before } = await guardOwnerChange(actor, membershipId, null);
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "member.remove",
    entityType: "Membership",
    entityId: membershipId,
    before: { userId: before.userId, role: before.role },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}
