import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapOwner } from "@/server/auth/users";
import { ForbiddenError } from "@/server/auth/rbac";
import { systemDb } from "@/server/db/client";
import {
  addMember,
  changeMemberRole,
  createAccount,
  DomainError,
  listMembers,
  removeMember,
  type Actor,
} from "./accounts";

const PASSWORD = "correct horse battery staple";

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

  it("an owner can create a second account and switch between them (two memberships)", async () => {
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

  it("adds a new user with one-time onboarding secrets, then links an existing user elsewhere", async () => {
    const email = `op-${Date.now()}@example.com`;
    const r = await addMember(owner, { email, name: "Operator", role: "OPERATOR" });
    expect(r.onboarding?.password).toHaveLength(24);
    expect(r.onboarding?.otpauthUri).toMatch(/^otpauth:/);
    await expect(addMember(owner, { email, name: "Operator", role: "VIEWER" })).rejects.toThrow(DomainError);

    const other = await createAccount(owner, { name: "Company Three" });
    const linked = await addMember(
      { ...owner, accountId: other.id },
      { email, name: "Operator", role: "VIEWER" },
    );
    expect(linked.onboarding).toBeUndefined();
  });

  it("admins manage members but cannot touch owners", async () => {
    const admin = await addMember(owner, {
      email: `adm-${Date.now()}@example.com`,
      name: "Admin",
      role: "ADMIN",
    });
    const asAdmin: Actor = { userId: admin.membership.userId, accountId: owner.accountId, role: "ADMIN" };
    await expect(
      addMember(asAdmin, { email: `x-${Date.now()}@example.com`, name: "X", role: "OWNER" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const viewer = await addMember(asAdmin, {
      email: `v-${Date.now()}@example.com`,
      name: "V",
      role: "VIEWER",
    });
    await changeMemberRole(asAdmin, viewer.membership.id, "WAREHOUSE");
    const ownerMembership = (await listMembers(owner)).find((m) => m.role === "OWNER")!;
    await expect(changeMemberRole(asAdmin, ownerMembership.id, "VIEWER")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(removeMember(asAdmin, ownerMembership.id)).rejects.toBeInstanceOf(ForbiddenError);
    await removeMember(asAdmin, viewer.membership.id);
    await expect(
      addMember({ ...owner, role: "OPERATOR" }, { email: "y@example.com", name: "Y", role: "VIEWER" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the last owner cannot be demoted or removed", async () => {
    const ownerMembership = (await listMembers(owner)).find((m) => m.user.id === owner.userId)!;
    await expect(changeMemberRole(owner, ownerMembership.id, "ADMIN")).rejects.toMatchObject({
      code: "last_owner",
    });
    await expect(removeMember(owner, ownerMembership.id)).rejects.toMatchObject({ code: "last_owner" });
  });

  it("members of another account are not visible", async () => {
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
    expect(actions).toEqual(
      expect.arrayContaining(["account.create", "member.add", "member.role_change", "member.remove"]),
    );
  });
});
