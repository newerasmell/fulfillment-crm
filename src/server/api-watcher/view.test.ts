import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapOwner } from "@/server/auth/users";
import { ForbiddenError } from "@/server/auth/rbac";
import { accountDb, systemDb } from "@/server/db/client";
import { raiseAlert } from "./safety";
import { apiWatchOverview, resolveApiAlert } from "./view";

describe("API changes read model (DB)", () => {
  let a: { accountId: string; userId: string };
  let b: { accountId: string };
  let companyX: string;
  let companyY: string;
  let storeY: string;

  beforeAll(async () => {
    const mk = async (n: string) => {
      const r = await bootstrapOwner({
        email: `view-${n}-${Date.now()}@example.com`,
        name: "O",
        accountName: `View group ${n}`,
        password: "correct horse battery staple",
      });
      return { accountId: r.account.id, userId: r.user.id };
    };
    a = await mk("a");
    b = await mk("b");
    companyX = (await systemDb().company.findFirstOrThrow({ where: { accountId: a.accountId } })).id;
    companyY = (
      await accountDb(a.accountId).company.create({ data: { accountId: a.accountId, name: "Company Y" } })
    ).id;
    storeY = (
      await accountDb(a.accountId).store.create({
        data: {
          accountId: a.accountId,
          companyId: companyY,
          domain: "view-y.myshopify.com",
          code: "VY",
          name: "Store Y",
          currency: "EUR",
        },
      })
    ).id;
    await raiseAlert(a.accountId, {
      kind: "api.spec_change",
      severity: "CRITICAL",
      title: "Spec A",
      entityType: "ApiSpecVersion",
      entityId: "v-a",
    });
    await raiseAlert(a.accountId, {
      kind: "api.live_check",
      severity: "CRITICAL",
      title: "Store Y broken",
      entityType: "Store",
      entityId: storeY,
    });
    await raiseAlert(b.accountId, {
      kind: "api.spec_change",
      severity: "INFO",
      title: "Spec B",
      entityId: "v-b",
    });
    await accountDb(a.accountId).alert.create({
      data: { accountId: a.accountId, kind: "shopify_import_failed", title: "Not an API alert" },
    });
  });

  it("shows only this account's API alerts", async () => {
    const { alerts, sources } = await apiWatchOverview(a.accountId, null);
    expect(alerts.map((x) => x.title).sort()).toEqual(["Spec A", "Store Y broken"]);
    expect(sources.map((s) => s.id)).toEqual(["FHB_V3", "FHB_JOY", "EUSHIPMENTS", "SHOPIFY", "LIVE_CHECK"]);
    expect((await apiWatchOverview(b.accountId, null)).alerts.map((x) => x.title)).toEqual(["Spec B"]);
  });

  it("hides alerts about stores of companies outside a restricted member's scope", async () => {
    expect((await apiWatchOverview(a.accountId, [companyX])).alerts.map((x) => x.title)).toEqual(["Spec A"]);
    expect((await apiWatchOverview(a.accountId, [companyY])).alerts).toHaveLength(2);
  });

  it("resolving: admins only, own account only, audited", async () => {
    const [alert] = (await apiWatchOverview(a.accountId, null)).alerts.filter((x) => x.title === "Spec A");
    const actor = { ...a, role: "OWNER" as const, companyScope: null };
    await expect(resolveApiAlert({ ...actor, role: "OPERATOR" }, alert!.id)).rejects.toThrow(ForbiddenError);
    await expect(resolveApiAlert({ ...actor, accountId: b.accountId }, alert!.id)).rejects.toThrow(
      "not_found",
    );
    await resolveApiAlert(actor, alert!.id);
    expect((await apiWatchOverview(a.accountId, null)).alerts.map((x) => x.title)).toEqual([
      "Store Y broken",
    ]);
    const audit = await accountDb(a.accountId).auditLog.findFirst({
      where: { action: "alert.resolve", entityId: alert!.id },
    });
    expect(audit?.userId).toBe(a.userId);
  });

  it("resolves an alert older than the overview's newest 50, and respects the company scope", async () => {
    const old = await accountDb(a.accountId).alert.create({
      data: {
        accountId: a.accountId,
        kind: "api.spec_change",
        title: "Old",
        createdAt: new Date("2020-01-01T00:00:00Z"),
      },
    });
    await accountDb(a.accountId).alert.createMany({
      data: Array.from({ length: 55 }, (_, i) => ({
        accountId: a.accountId,
        kind: "api.spec_change",
        title: `Newer ${i}`,
        entityId: `n-${i}`,
      })),
    });
    const actor = { ...a, role: "ADMIN" as const, companyScope: null };
    await resolveApiAlert(actor, old.id);
    expect((await accountDb(a.accountId).alert.findUniqueOrThrow({ where: { id: old.id } })).status).toBe(
      "RESOLVED",
    );
    await expect(resolveApiAlert(actor, old.id)).rejects.toThrow("not_found"); // already resolved

    const [storeAlert] = await accountDb(a.accountId).alert.findMany({
      where: { entityType: "Store", entityId: storeY },
    });
    await expect(resolveApiAlert({ ...actor, companyScope: [companyX] }, storeAlert!.id)).rejects.toThrow(
      "not_found",
    );
    await resolveApiAlert({ ...actor, companyScope: [companyY] }, storeAlert!.id);
  });
});
