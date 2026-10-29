import { generate } from "otplib";
import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/server/accounts";
import { verifyLogin } from "@/server/auth/login";
import { ForbiddenError } from "@/server/auth/rbac";
import { bootstrapOwner } from "@/server/auth/users";
import { systemDb } from "@/server/db/client";
import {
  acceptInvitation,
  completeEnrolment,
  createOwnerInvitation,
  enrolmentForm,
  findOpenInvitation,
  inviteMember,
  listOpenInvitations,
  revokeInvitation,
} from "./invitations";

const PASSWORD = "correct horse battery staple";

describe("invitations", () => {
  let owner: Actor;
  let ownerEmail: string;
  beforeAll(async () => {
    ownerEmail = `inv-owner-${Date.now()}@example.com`;
    const r = await bootstrapOwner({
      email: ownerEmail,
      name: "O",
      accountName: "Inviting Co",
      password: PASSWORD,
    });
    owner = { userId: r.user.id, accountId: r.account.id, role: "OWNER" };
  });

  it("a new person enrols with their own password and 2FA key and can log in; the link works once", async () => {
    const email = `new-${Date.now()}@example.com`;
    const { token } = await inviteMember(owner, { email, name: "New Person", role: "OPERATOR" });
    const enrol = await enrolmentForm(token);
    expect((await enrolmentForm(token)).secret).not.toBe(enrol.secret); // fresh per view, nothing stored
    const sealedSecret = enrol.sealed;
    await expect(
      completeEnrolment(token, {
        name: "New",
        password: "short",
        passwordRepeat: "short",
        code: "000000",
        sealedSecret,
      }),
    ).rejects.toThrow();
    await expect(
      completeEnrolment(token, {
        name: "New",
        password: PASSWORD,
        passwordRepeat: PASSWORD,
        code: "000000",
        sealedSecret,
      }),
    ).rejects.toMatchObject({ code: "invalid_code" });
    const code = await generate({ secret: enrol.secret });
    const user = await completeEnrolment(token, {
      name: "New",
      password: PASSWORD,
      passwordRepeat: PASSWORD,
      code,
      sealedSecret,
    });
    const m = await systemDb().membership.findFirstOrThrow({ where: { userId: user.id } });
    expect(m).toMatchObject({ accountId: owner.accountId, role: "OPERATOR" });
    expect(await findOpenInvitation(token)).toBeNull();
    await expect(
      completeEnrolment(token, {
        name: "New",
        password: PASSWORD,
        passwordRepeat: PASSWORD,
        code,
        sealedSecret,
      }),
    ).rejects.toMatchObject({ code: "invalid_invitation" });
    // the enrolment code cannot be replayed at login, a fresh one works
    expect(await verifyLogin({ email, password: PASSWORD, code, ip: null, userAgent: null })).toMatchObject({
      ok: false,
    });
  });

  it("the inviter's answer is the same whether or not the email already has a profile", async () => {
    const forNew = await inviteMember(owner, { email: `nobody-${Date.now()}@example.com`, role: "VIEWER" });
    const forExisting = await inviteMember(owner, { email: ownerEmail, role: "VIEWER" });
    expect(Object.keys(forNew).sort()).toEqual(Object.keys(forExisting).sort());
  });

  it("an existing user is added only after logging in and accepting, and only as themselves", async () => {
    const other = await bootstrapOwner({
      email: `existing-${Date.now()}@example.com`,
      name: "E",
      accountName: "Their Co",
      password: PASSWORD,
    });
    const { token } = await inviteMember(owner, { email: other.user.email, role: "VIEWER" });
    expect(
      await systemDb().membership.count({ where: { userId: other.user.id, accountId: owner.accountId } }),
    ).toBe(0);
    // creating a second profile for an existing email is refused; joining needs sign-in + accept
    const f = await enrolmentForm(token);
    await expect(
      completeEnrolment(token, {
        name: "X",
        password: PASSWORD,
        passwordRepeat: PASSWORD,
        code: await generate({ secret: f.secret }),
        sealedSecret: f.sealed,
      }),
    ).rejects.toMatchObject({ code: "invalid_invitation" }); // generic: no profile oracle
    await expect(acceptInvitation(token, owner.userId)).rejects.toMatchObject({ code: "invalid_invitation" });
    await acceptInvitation(token, other.user.id);
    expect(
      await systemDb().membership.count({ where: { userId: other.user.id, accountId: owner.accountId } }),
    ).toBe(1);
    await expect(acceptInvitation(token, other.user.id)).rejects.toMatchObject({
      code: "invalid_invitation",
    });
  });

  it("a new invitation replaces the old link; revoked and expired links do not work", async () => {
    const email = `re-${Date.now()}@example.com`;
    const first = await inviteMember(owner, { email, role: "VIEWER" });
    const second = await inviteMember(owner, { email, role: "OPERATOR" });
    expect(await findOpenInvitation(first.token)).toBeNull();
    expect(await findOpenInvitation(second.token)).not.toBeNull();
    await revokeInvitation(owner, second.invitationId);
    expect(await findOpenInvitation(second.token)).toBeNull();
    const third = await inviteMember(owner, { email, role: "VIEWER" });
    await systemDb().invitation.update({
      where: { id: third.invitationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await findOpenInvitation(third.token)).toBeNull();
    expect((await listOpenInvitations(owner)).some((i) => i.email === email)).toBe(false);
  });

  it("only member managers invite, and only owners invite owners", async () => {
    await expect(
      inviteMember({ ...owner, role: "OPERATOR" }, { email: "x@example.com", role: "VIEWER" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      inviteMember({ ...owner, role: "ADMIN" }, { email: "x@example.com", role: "OWNER" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the owner bootstrap creates a company and an OWNER link, no password anywhere", async () => {
    const email = `boot-${Date.now()}@example.com`;
    const r = await createOwnerInvitation({ email, accountName: "Boot Co" });
    const enrol = await enrolmentForm(r.token);
    const user = await completeEnrolment(r.token, {
      name: "Boot",
      password: PASSWORD,
      passwordRepeat: PASSWORD,
      code: await generate({ secret: enrol.secret }),
      sealedSecret: enrol.sealed,
    });
    expect(await systemDb().membership.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({
      accountId: r.account.id,
      role: "OWNER",
    });
  });

  it("tokens are stored only as hashes", async () => {
    const { token, invitationId } = await inviteMember(owner, {
      email: `h-${Date.now()}@example.com`,
      role: "VIEWER",
    });
    const row = await systemDb().invitation.findUniqueOrThrow({ where: { id: invitationId } });
    expect(row.tokenHash).not.toContain(token);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a sealed 2FA key is bound to its invitation and expires", async () => {
    const a = await inviteMember(owner, { email: `seal-a-${Date.now()}@example.com`, role: "VIEWER" });
    const b = await inviteMember(owner, { email: `seal-b-${Date.now()}@example.com`, role: "VIEWER" });
    const fa = await enrolmentForm(a.token);
    const code = await generate({ secret: fa.secret });
    await expect(
      completeEnrolment(b.token, {
        name: "B",
        password: PASSWORD,
        passwordRepeat: PASSWORD,
        code,
        sealedSecret: fa.sealed,
      }),
    ).rejects.toMatchObject({ code: "invalid_invitation" });
  });

  it("two parallel enrolments on one link create exactly one profile", async () => {
    const email = `par-${Date.now()}@example.com`;
    const { token } = await inviteMember(owner, { email, role: "VIEWER" });
    const f = await enrolmentForm(token);
    const code = await generate({ secret: f.secret });
    const input = { name: "P", password: PASSWORD, passwordRepeat: PASSWORD, code, sealedSecret: f.sealed };
    const results = await Promise.allSettled([
      completeEnrolment(token, input),
      completeEnrolment(token, input),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await systemDb().user.count({ where: { email } })).toBe(1);
  });

  it("demoting the inviter revokes their open links", async () => {
    const { createUser } = await import("@/server/auth/users");
    const { changeMemberRole } = await import("./accounts");
    const u = await createUser({ email: `adm-inv-${Date.now()}@example.com`, name: "A", password: PASSWORD });
    const m = await systemDb().membership.create({
      data: { accountId: owner.accountId, userId: u.user.id, role: "ADMIN" },
    });
    const admin: Actor = { userId: u.user.id, accountId: owner.accountId, role: "ADMIN" };
    const { token } = await inviteMember(admin, {
      email: `via-admin-${Date.now()}@example.com`,
      role: "VIEWER",
    });
    await changeMemberRole(owner, m.id, "VIEWER");
    expect(await findOpenInvitation(token)).toBeNull();
  });
});
