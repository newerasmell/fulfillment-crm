import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapOwner } from "@/server/auth/users";
import { accountDb, systemDb } from "@/server/db/client";
import { saveCredential } from "@/server/security/credentials";
import { createStore, getStore, listStores, updateStoreSettings, type ScopedActor } from "./stores";

describe("stores", () => {
  let owner: ScopedActor;
  let companyA: string;
  let companyB: string;
  let storeId: string;
  const settings = {
    name: "Store A",
    countries: ["BG"],
    codGateways: ["Cash on Delivery (COD)"],
    skuPrefix: "",
    notifyCustomer: true,
    writeBackMode: "READ_ONLY" as const,
    inventoryPushMode: "DISABLED" as const,
    inventoryBuffer: 0,
  };

  beforeAll(async () => {
    const r = await bootstrapOwner({
      email: `st-${Date.now()}@example.com`,
      name: "O",
      accountName: "Stores group",
      password: "correct horse battery staple",
    });
    owner = { userId: r.user.id, accountId: r.account.id, role: "OWNER", companyScope: null };
    companyA = (await systemDb().company.findFirstOrThrow({ where: { accountId: r.account.id } })).id;
    companyB = (await systemDb().company.create({ data: { accountId: r.account.id, name: "B" } })).id;
    storeId = (
      await createStore(owner, {
        companyId: companyA,
        name: "Store A",
        domain: "store-a.myshopify.com",
        code: "SA",
        currency: "EUR",
        clientId: "client-id-aaaa",
        clientSecret: "client-secret-aaaa",
      })
    ).id;
  });

  it("validates the domain, the code and uniqueness", async () => {
    const base = {
      companyId: companyA,
      name: "X",
      currency: "EUR",
      clientId: "client-id-x1",
      clientSecret: "client-secret-x1",
    };
    await expect(createStore(owner, { ...base, domain: "evil.com", code: "XA" })).rejects.toThrow();
    await expect(
      createStore(owner, { ...base, domain: "x.myshopify.com", code: "toolong" }),
    ).rejects.toThrow();
    await expect(
      createStore(owner, { ...base, domain: "store-a.myshopify.com", code: "XB" }),
    ).rejects.toMatchObject({ code: "store_exists" });
  });

  it("reuses only a Shopify app credential of the group", async () => {
    const existing = (await accountDb(owner.accountId).store.findUniqueOrThrow({ where: { id: storeId } }))
      .credentialId!;
    const s = await createStore(owner, {
      companyId: companyB,
      name: "B1",
      domain: "store-b.myshopify.com",
      code: "SB",
      currency: "EUR",
      credentialId: existing,
    });
    expect(s.credentialId).toBe(existing);
    const other = await saveCredential(accountDb(owner.accountId), owner.accountId, {
      label: "FHB key",
      secret: "not-json-at-all",
    });
    await expect(
      createStore(owner, {
        companyId: companyB,
        name: "B2",
        domain: "store-c.myshopify.com",
        code: "SC",
        currency: "EUR",
        credentialId: other.id,
      }),
    ).rejects.toMatchObject({ code: "invalid_credential" });
  });

  it("only owners/admins create stores; raising write-back or stock push is an owner decision", async () => {
    const admin = { ...owner, role: "ADMIN" as const };
    await expect(
      createStore(
        { ...owner, role: "OPERATOR" },
        {
          companyId: companyA,
          name: "Y",
          domain: "y.myshopify.com",
          code: "YY",
          currency: "EUR",
          clientId: "client-id-y1",
          clientSecret: "client-secret-y1",
        },
      ),
    ).rejects.toThrow();
    await updateStoreSettings(admin, storeId, { ...settings, skuPrefix: "SA-" });
    await expect(
      updateStoreSettings(admin, storeId, { ...settings, writeBackMode: "DRY_RUN" }),
    ).rejects.toThrow();
    await expect(
      updateStoreSettings(admin, storeId, { ...settings, inventoryPushMode: "LIVE" }),
    ).rejects.toThrow();
    await updateStoreSettings(owner, storeId, { ...settings, writeBackMode: "DRY_RUN" });
    await updateStoreSettings(admin, storeId, settings); // lowering is fine
    const audit = await accountDb(owner.accountId).auditLog.findMany({
      where: { entityId: storeId, action: "store.settings" },
    });
    expect(audit.length).toBeGreaterThanOrEqual(3);
  });

  it("restricted members see only their companies' stores", async () => {
    const restricted = { ...owner, role: "OPERATOR" as const, companyScope: [companyB] };
    await expect(getStore(restricted, storeId)).rejects.toMatchObject({ code: "not_found" });
    const names = (
      await listStores({ accountId: owner.accountId, companyScope: [companyB], activeCompanyId: null })
    ).map((s) => s.name);
    expect(names).toEqual(["B1"]);
  });
});
