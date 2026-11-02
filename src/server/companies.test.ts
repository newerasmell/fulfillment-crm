import { generate } from "otplib";
import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { bootstrapOwner, createUser } from "@/server/auth/users";
import { accountDb, systemDb } from "@/server/db/client";
import {
  companyScopeOf,
  companyWhere,
  createCompany,
  listCompanies,
  setCompanyArchived,
  setMemberCompanies,
} from "./companies";
import { completeEnrolment, enrolmentForm, inviteMember } from "./invitations";

const PASSWORD = "correct horse battery staple";

describe("companyFilter (pure)", () => {
  it("prefers the company picked in the sidebar, else the member's scope", async () => {
    const { companyFilter } = await import("./companies");
    expect(companyFilter({ companyScope: null, activeCompanyId: null })).toEqual({});
    expect(companyFilter({ companyScope: ["a", "b"], activeCompanyId: null })).toEqual({
      companyId: { in: ["a", "b"] },
    });
    expect(companyFilter({ companyScope: ["a", "b"], activeCompanyId: "b" })).toEqual({ companyId: "b" });
  });
});

describe("group → companies", () => {
  let owner: Actor;
  let firstCompanyId: string;
  beforeAll(async () => {
    const r = await bootstrapOwner({
      email: `grp-${Date.now()}@example.com`,
      name: "O",
      accountName: "Група",
      password: PASSWORD,
    });
    owner = { userId: r.user.id, accountId: r.account.id, role: "OWNER" };
    firstCompanyId = (await systemDb().company.findFirstOrThrow({ where: { accountId: r.account.id } })).id;
  });

  it("a new group starts with one company named like it", async () => {
    expect((await listCompanies(owner)).map((c) => c.name)).toEqual(["Група"]);
  });

  it("owners and admins create companies; names are unique per group", async () => {
    await createCompany(owner, { name: "Фирма Б" });
    await createCompany({ ...owner, role: "ADMIN" }, { name: "Фирма В" });
    await expect(createCompany(owner, { name: "Фирма Б" })).rejects.toMatchObject({ code: "company_exists" });
    await expect(createCompany({ ...owner, role: "OPERATOR" }, { name: "X" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect((await listCompanies(owner)).map((c) => c.name)).toEqual(["Група", "Фирма Б", "Фирма В"]);
  });

  it("archiving hides a company but keeps it (owner only), and can be undone", async () => {
    const v = (await listCompanies(owner)).find((c) => c.name === "Фирма В")!;
    await expect(setCompanyArchived({ ...owner, role: "ADMIN" }, v.id, true)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await setCompanyArchived(owner, v.id, true);
    expect((await listCompanies(owner)).map((c) => c.name)).not.toContain("Фирма В");
    expect((await listCompanies(owner, { includeArchived: true })).map((c) => c.name)).toContain("Фирма В");
    await setCompanyArchived(owner, v.id, false);
    expect((await listCompanies(owner)).map((c) => c.name)).toContain("Фирма В");
  });

  it("operators can be limited to some companies; owners and admins always see all", async () => {
    const u = await createUser({ email: `op-${Date.now()}@example.com`, name: "Op", password: PASSWORD });
    const m = await systemDb().membership.create({
      data: { accountId: owner.accountId, userId: u.user.id, role: "OPERATOR" },
    });
    expect(await companyScopeOf(owner.accountId, m.id, "OPERATOR")).toBeNull(); // no rows = all
    const b = (await listCompanies(owner)).find((c) => c.name === "Фирма Б")!;
    await setMemberCompanies(owner, m.id, { all: false, companyIds: [b.id] });
    const scope = await companyScopeOf(owner.accountId, m.id, "OPERATOR");
    expect(scope).toEqual([b.id]);
    const operator = {
      userId: u.user.id,
      accountId: owner.accountId,
      role: "OPERATOR" as const,
      companyScope: scope,
    };
    expect((await listCompanies(operator)).map((c) => c.name)).toEqual(["Фирма Б"]);
    expect(companyWhere(scope)).toEqual({ companyId: { in: [b.id] } });
    expect(companyWhere(null)).toEqual({});
    // an empty restriction is refused instead of silently meaning "all"
    await expect(setMemberCompanies(owner, m.id, { all: false, companyIds: [] })).rejects.toMatchObject({
      code: "pick_company",
    });
    // operators cannot change anyone's access
    await expect(setMemberCompanies(operator, m.id, { all: true })).rejects.toBeInstanceOf(ForbiddenError);
    await setMemberCompanies(owner, m.id, { all: true });
    expect(await companyScopeOf(owner.accountId, m.id, "OPERATOR")).toBeNull();
  });

  it("owners and admins cannot be restricted (no self-widening, no escalation through admins)", async () => {
    const b = (await listCompanies(owner)).find((c) => c.name === "Фирма Б")!;
    const ownerMembership = await systemDb().membership.findFirstOrThrow({
      where: { accountId: owner.accountId, role: "OWNER" },
    });
    await expect(
      setMemberCompanies(owner, ownerMembership.id, { all: false, companyIds: [b.id] }),
    ).rejects.toMatchObject({
      code: "role_sees_all",
    });
    const u = await createUser({ email: `adm-${Date.now()}@example.com`, name: "Adm", password: PASSWORD });
    const admin = await systemDb().membership.create({
      data: { accountId: owner.accountId, userId: u.user.id, role: "ADMIN" },
    });
    await expect(
      setMemberCompanies(owner, admin.id, { all: false, companyIds: [b.id] }),
    ).rejects.toMatchObject({
      code: "role_sees_all",
    });
    expect(await companyScopeOf(owner.accountId, admin.id, "ADMIN")).toBeNull();
    // inviting an ADMIN with companies: the companies are ignored
    const { invitationId } = await inviteMember(owner, {
      email: `ia-${Date.now()}@example.com`,
      role: "ADMIN",
      companyIds: [b.id],
    });
    expect(await systemDb().invitationCompany.count({ where: { invitationId } })).toBe(0);
  });

  it("promotion to admin clears a restriction so it cannot silently come back on demotion", async () => {
    const { changeMemberRole } = await import("./accounts");
    const b = (await listCompanies(owner)).find((c) => c.name === "Фирма Б")!;
    const u = await createUser({ email: `promo-${Date.now()}@example.com`, name: "P", password: PASSWORD });
    const m = await systemDb().membership.create({
      data: { accountId: owner.accountId, userId: u.user.id, role: "OPERATOR" },
    });
    await setMemberCompanies(owner, m.id, { all: false, companyIds: [b.id] });
    await changeMemberRole(owner, m.id, "ADMIN");
    await changeMemberRole(owner, m.id, "OPERATOR");
    expect(await companyScopeOf(owner.accountId, m.id, "OPERATOR")).toBeNull();
  });

  it("an archived company stays in an existing restriction but cannot be newly given", async () => {
    const c = await createCompany(owner, { name: `Архив ${Date.now()}` });
    const u = await createUser({ email: `arch-${Date.now()}@example.com`, name: "A", password: PASSWORD });
    const m = await systemDb().membership.create({
      data: { accountId: owner.accountId, userId: u.user.id, role: "VIEWER" },
    });
    await setMemberCompanies(owner, m.id, { all: false, companyIds: [c.id] });
    await setCompanyArchived(owner, c.id, true);
    await setMemberCompanies(owner, m.id, { all: false, companyIds: [c.id] }); // re-saving keeps it
    expect(await companyScopeOf(owner.accountId, m.id, "VIEWER")).toEqual([c.id]);
    const u2 = await createUser({ email: `arch2-${Date.now()}@example.com`, name: "A2", password: PASSWORD });
    const m2 = await systemDb().membership.create({
      data: { accountId: owner.accountId, userId: u2.user.id, role: "VIEWER" },
    });
    await expect(setMemberCompanies(owner, m2.id, { all: false, companyIds: [c.id] })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      inviteMember(owner, { email: "z2@example.com", role: "VIEWER", companyIds: [c.id] }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("companies of another group cannot be referenced", async () => {
    const other = await bootstrapOwner({
      email: `grp2-${Date.now()}@example.com`,
      name: "X",
      accountName: "Друга група",
      password: PASSWORD,
    });
    const foreign = await systemDb().company.findFirstOrThrow({ where: { accountId: other.account.id } });
    const u = await createUser({ email: `op2-${Date.now()}@example.com`, name: "Op", password: PASSWORD });
    const m = await systemDb().membership.create({
      data: { accountId: owner.accountId, userId: u.user.id, role: "VIEWER" },
    });
    await expect(
      setMemberCompanies(owner, m.id, { all: false, companyIds: [foreign.id] }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      inviteMember(owner, { email: "z@example.com", role: "VIEWER", companyIds: [foreign.id] }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      accountDb(owner.accountId).store.create({
        data: {
          accountId: owner.accountId,
          companyId: foreign.id,
          domain: "x.example",
          code: "XXX",
          name: "x",
          currency: "EUR",
        },
      }),
    ).rejects.toThrow(); // composite FK: a store cannot belong to another group's company
    expect(firstCompanyId).toBeTruthy();
  });

  it("an invitation's company restriction becomes the new member's restriction", async () => {
    const b = (await listCompanies(owner)).find((c) => c.name === "Фирма Б")!;
    const email = `scoped-${Date.now()}@example.com`;
    const { token } = await inviteMember(owner, { email, role: "WAREHOUSE", companyIds: [b.id] });
    const f = await enrolmentForm(token);
    const user = await completeEnrolment(token, {
      name: "W",
      password: PASSWORD,
      passwordRepeat: PASSWORD,
      code: await generate({ secret: f.secret }),
      sealedSecret: f.sealed,
    });
    const m = await systemDb().membership.findFirstOrThrow({ where: { userId: user.id } });
    expect(await companyScopeOf(owner.accountId, m.id, m.role)).toEqual([b.id]);
  });
});
