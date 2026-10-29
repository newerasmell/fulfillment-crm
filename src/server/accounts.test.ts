import { beforeAll, describe, expect, it } from "vitest";
import type { Role } from "@/generated/prisma/client";
import { bootstrapOwner, createUser } from "@/server/auth/users";
import { ForbiddenError } from "@/server/auth/rbac";
import { systemDb } from "@/server/db/client";
import { changeMemberRole, createAccount, listMembers, removeMember, type Actor } from "./accounts";

const PASSWORD = "correct horse battery staple";
let n = 0;

async function addUser(accountId: string, role: Role) {
  const u = await createUser({
    email: `m-${Date.now()}-${++n}@example.com`,
    name: `U${n}`,
    password: PASSWORD,
  });
  const m = await systemDb().membership.create({ data: { accountId, userId: u.user.id, role } });
  return { userId: u.user.id, membershipId: m.id };
}

describe("accounts and memberships", () => {
  let owner: Actor;
  beforeAll(async () => {
    const r = await bootstrapOwner({
      email: `acc-owner-${Date.now()}@example.com`,
      name: "O",
      accountName: "Company One",
      password: PASSWORD,
    });
    owner = { userId: r.user.id, accountId: r.account.id, role: "OWNER" };
  });

  it("an owner can create a second account (two memberships to switch between)", async () => {
    const second = await createAccount(owner, { name: "Company Two" });
    const ms = await systemDb().membership.findMany({
      where: { userId: owner.userId },
      orderBy: { createdAt: "asc" },
    });
    expect(ms.map((m) => [m.accountId, m.role])).toEqual([
      [owner.accountId, "OWNER"],
      [second.id, "OWNER"],
    ]);
  });

  it("non-owners cannot create accounts", async () => {
    await expect(createAccount({ ...owner, role: "ADMIN" }, { name: "Nope" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("admins manage members but cannot touch owners", async () => {
    const admin = await addUser(owner.accountId, "ADMIN");
    const asAdmin: Actor = { userId: admin.userId, accountId: owner.accountId, role: "ADMIN" };
    const viewer = await addUser(owner.accountId, "VIEWER");
    await changeMemberRole(asAdmin, viewer.membershipId, "WAREHOUSE");
    await expect(changeMemberRole(asAdmin, viewer.membershipId, "OWNER")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const ownerMembership = (await listMembers(owner)).find((m) => m.role === "OWNER")!;
    await expect(changeMemberRole(asAdmin, ownerMembership.id, "VIEWER")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(removeMember(asAdmin, ownerMembership.id)).rejects.toBeInstanceOf(ForbiddenError);
    await removeMember(asAdmin, viewer.membershipId);
    await expect(
      changeMemberRole({ ...owner, role: "OPERATOR" }, admin.membershipId, "VIEWER"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the last owner cannot be demoted or removed", async () => {
    const ownerMembership = (await listMembers(owner)).find((m) => m.user.id === owner.userId)!;
    await expect(changeMemberRole(owner, ownerMembership.id, "ADMIN")).rejects.toMatchObject({
      code: "last_owner",
    });
    await expect(removeMember(owner, ownerMembership.id)).rejects.toMatchObject({ code: "last_owner" });
  });

  it("two owners demoting each other at the same time leave at least one owner", async () => {
    const acc = await createAccount(owner, { name: "Race Co" });
    const a = await systemDb().membership.findFirstOrThrow({
      where: { accountId: acc.id, userId: owner.userId },
    });
    const b = await addUser(acc.id, "OWNER");
    const actorA: Actor = { userId: owner.userId, accountId: acc.id, role: "OWNER" };
    const actorB: Actor = { userId: b.userId, accountId: acc.id, role: "OWNER" };
    const results = await Promise.allSettled([
      changeMemberRole(actorA, b.membershipId, "ADMIN"),
      changeMemberRole(actorB, a.id, "ADMIN"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await systemDb().membership.count({ where: { accountId: acc.id, role: "OWNER" } })).toBe(1);
  });

  it("members of another account are not visible or changeable", async () => {
    const other = await bootstrapOwner({
      email: `iso-${Date.now()}@example.com`,
      name: "I",
      accountName: "Isolated",
      password: PASSWORD,
    });
    const members = await listMembers(owner);
    expect(members.some((m) => m.user.id === other.user.id)).toBe(false);
    const foreign = await systemDb().membership.findFirstOrThrow({ where: { userId: other.user.id } });
    await expect(removeMember(owner, foreign.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("every change is audit-logged", async () => {
    const actions = (await systemDb().auditLog.findMany({ where: { accountId: owner.accountId } })).map(
      (a) => a.action,
    );
    expect(actions).toEqual(expect.arrayContaining(["member.role_change", "member.remove"]));
  });
});
