import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accountDb,
  basePrisma,
  scopeArgs,
  systemDb,
  TenantScopeError,
  withAccountTransaction,
} from "./client";

describe("scopeArgs (pure)", () => {
  it("adds accountId to where and create data", () => {
    expect(scopeArgs("Product", "findMany", { where: { sku: "X" } }, "A")).toEqual({
      where: { sku: "X", accountId: "A" },
    });
    expect(scopeArgs("Product", "findUnique", { where: { id: "p1" } }, "A").where).toEqual({
      id: "p1",
      accountId: "A",
    });
    expect(scopeArgs("Product", "create", { data: { sku: "X", name: "n" } }, "A").data).toEqual({
      sku: "X",
      name: "n",
      accountId: "A",
    });
    expect(scopeArgs("Product", "createMany", { data: [{ sku: "1" }, { sku: "2" }] }, "A").data).toEqual([
      { sku: "1", accountId: "A" },
      { sku: "2", accountId: "A" },
    ]);
  });

  it("scopes Account by id and leaves global models alone", () => {
    expect(scopeArgs("Account", "findMany", {}, "A").where).toEqual({ id: "A" });
    expect(scopeArgs("User", "findMany", { where: { email: "x" } }, "A").where).toEqual({ email: "x" });
  });

  it("rejects a foreign accountId anywhere", () => {
    expect(() => scopeArgs("Product", "findMany", { where: { accountId: "B" } }, "A")).toThrow(
      TenantScopeError,
    );
    expect(() => scopeArgs("Product", "create", { data: { accountId: "B" } }, "A")).toThrow(TenantScopeError);
    expect(() =>
      scopeArgs("Product", "update", { where: { id: "x" }, data: { accountId: "B" } }, "A"),
    ).toThrow(TenantScopeError);
    expect(() =>
      scopeArgs("Product", "upsert", { where: { id: "x" }, create: { accountId: "B" }, update: {} }, "A"),
    ).toThrow(TenantScopeError);
    expect(() =>
      scopeArgs("Product", "create", { data: { account: { connect: { id: "B" } } } }, "A"),
    ).toThrow(TenantScopeError);
    expect(() => scopeArgs("Account", "create", { data: { name: "x" } }, "A")).toThrow(TenantScopeError);
  });
});

describe("account isolation (database)", () => {
  let A: string;
  let B: string;
  let productB: string;

  beforeAll(async () => {
    const sys = systemDb();
    A = (await sys.account.create({ data: { name: "Account A" } })).id;
    B = (await sys.account.create({ data: { name: "Account B" } })).id;
    await sys.product.create({ data: { accountId: A, sku: "A-1", name: "A product" } });
    productB = (await sys.product.create({ data: { accountId: B, sku: "B-1", name: "B product" } })).id;
    await sys.credential.create({
      data: { accountId: B, label: "b", ciphertext: "c", iv: "i", authTag: "t", hint: "••••" },
    });
  });

  afterAll(async () => {
    await systemDb().account.deleteMany({ where: { id: { in: [A, B] } } });
  });

  it("account A sees only its own rows", async () => {
    const db = accountDb(A);
    const products = await db.product.findMany();
    expect(products.map((p) => p.sku)).toEqual(["A-1"]);
    expect(await db.product.findUnique({ where: { id: productB } })).toBeNull();
    expect(await db.credential.count()).toBe(0);
    expect((await db.account.findMany()).map((a) => a.id)).toEqual([A]);
  });

  it("account A cannot update or delete account B rows", async () => {
    const db = accountDb(A);
    await expect(db.product.update({ where: { id: productB }, data: { name: "hacked" } })).rejects.toThrow();
    expect((await db.product.deleteMany({ where: { id: productB } })).count).toBe(0);
    expect((await db.product.updateMany({ data: { name: "x" } })).count).toBe(1); // only its own
    const b = await systemDb().product.findUnique({ where: { id: productB } });
    expect(b?.name).toBe("B product");
  });

  it("account A cannot create rows for account B", async () => {
    await expect(
      accountDb(A).product.create({ data: { accountId: B, sku: "evil", name: "x" } }),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it("RLS blocks cross-account access even without the repository layer", async () => {
    await withAccountTransaction(A, async (tx) => {
      const all = await tx.product.findMany(); // no where clause at all
      expect(all.every((p) => p.accountId === A)).toBe(true);
      expect(await tx.product.findUnique({ where: { id: productB } })).toBeNull();
    });
    await expect(
      withAccountTransaction(A, (tx) => tx.product.create({ data: { accountId: B, sku: "rls", name: "x" } })),
    ).rejects.toThrow(/row-level security/i);
  });

  it("without a scope the database returns nothing (default deny)", async () => {
    const rows = await basePrisma().$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Product"`;
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it("every table with accountId has forced RLS", async () => {
    const rows = await basePrisma().$queryRaw<{ table: string; rls: boolean; forced: boolean }[]>`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
      FROM information_schema.columns col
      JOIN pg_class c ON c.relname = col.table_name
      WHERE col.table_schema = 'public' AND col.column_name = 'accountId'`;
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows)
      expect({ table: r.table, rls: r.rls, forced: r.forced }).toEqual({
        table: r.table,
        rls: true,
        forced: true,
      });
  });
});
