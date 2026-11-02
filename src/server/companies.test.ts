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

  it("members can be limited to some companies; owners always see all", async () => {
    const u = await createUser({ email: `op-${Date.now()}@example.com`, name: "Op", password: PASSWORD });
    const m = await systemDb().membership.create({
      data: { accountId: owner.accountId, userId: u.user.id, role: "OPERATOR" },
    });
    expect(await companyScopeOf(owner.accountId, m.id, "OPERATOR")).toBeNull(); // no rows = all
    const b = (await listCompanies(owner)).find((c) => c.name === "Фирма Б")!;
    await setMemberCompanies(owner, m.id, [b.id]);
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
    const ownerMembership = await systemDb().membership.findFirstOrThrow({
      where: { accountId: owner.accountId, role: "OWNER" },
    });
    await expect(setMemberCompanies(owner, ownerMembership.id, [b.id])).rejects.toMatchObject({
      code: "owner_sees_all",
    });
    await expect(setMemberCompanies(operator, m.id, [])).rejects.toBeInstanceOf(ForbiddenError);
    await setMemberCompanies(owner, m.id, []); // back to all
    expect(await companyScopeOf(owner.accountId, m.id, "OPERATOR")).toBeNull();
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
    await expect(setMemberCompanies(owner, m.id, [foreign.id])).rejects.toMatchObject({ code: "not_found" });
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
