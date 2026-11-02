import { beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import {
  accountDb,
  assertSafeDatabaseRole,
  basePrisma,
  scopeArgs,
  systemDb,
  TenantScopeError,
  withAccountTransaction,
} from "./client";

const GLOBAL = new Set(["User", "LoginAttempt", "ApiSpecVersion"]);
const SCOPED_MODELS = Object.values(Prisma.ModelName).filter((m) => !GLOBAL.has(m));
const delegateKey = (m: string) => m.charAt(0).toLowerCase() + m.slice(1);

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
    expect(scopeArgs("Account", "findMany", {}, "A").where).toEqual({ id: "A" });
  });

  it("rejects a foreign accountId anywhere, including nested writes", () => {
    const bad: [string, string, unknown][] = [
      ["Product", "findMany", { where: { accountId: "B" } }],
      ["Product", "create", { data: { accountId: "B" } }],
      ["Product", "update", { where: { id: "x" }, data: { accountId: "B" } }],
      ["Product", "upsert", { where: { id: "x" }, create: { accountId: "B" }, update: {} }],
      ["Product", "create", { data: { account: { connect: { id: "B" } } } }],
      ["Order", "create", { data: { lines: { create: [{ accountId: "B", title: "x" }] } } }],
      [
        "Order",
        "update",
        { where: { id: "o" }, data: { lines: { createMany: { data: [{ accountId: "B" }] } } } },
      ],
      [
        "Order",
        "update",
        {
          where: { id: "o" },
          data: { lines: { connectOrCreate: { where: { id: "l" }, create: { accountId: "B" } } } },
        },
      ],
      ["Account", "create", { data: { name: "x" } }],
    ];
    for (const [model, op, args] of bad)
      expect(() => scopeArgs(model, op, args, "A"), `${model}.${op}`).toThrow(TenantScopeError);
  });

  it("refuses account-less models through an account scope", () => {
    for (const m of GLOBAL) expect(() => scopeArgs(m, "findMany", {}, "A")).toThrow(TenantScopeError);
  });
});

describe("account isolation (database)", () => {
  type Seed = {
    account: string;
    credential: string;
    store: string;
    connection: string;
    product: string;
    order: string;
    line: string;
  };
  let A: Seed;
  let B: Seed;

  async function seed(name: string): Promise<Seed> {
    const sys = systemDb();
    const account = (await sys.account.create({ data: { name } })).id;
    const credential = (
      await sys.credential.create({
        data: { accountId: account, label: "c", ciphertext: "c", iv: "i", authTag: "t", hint: "••••" },
      })
    ).id;
    const store = (
      await sys.store.create({
        data: {
          accountId: account,
          domain: `${name}.example`,
          code: name.slice(-3),
          name,
          currency: "EUR",
          credentialId: credential,
        },
      })
    ).id;
    const connection = (
      await sys.fulfillmentConnection.create({ data: { accountId: account, type: "FHB_V3", name: "FHB" } })
    ).id;
    const product = (
      await sys.product.create({ data: { accountId: account, sku: `${name}-1`, name: `${name} product` } })
    ).id;
    const order = await sys.order.create({
      data: {
        accountId: account,
        source: "MANUAL",
        number: "1",
        currency: "EUR",
        subtotal: 10,
        total: 10,
        paymentMethod: "COD",
        placedAt: new Date(),
        lines: { create: [{ title: "x", quantity: 1, unitPrice: 10 }] },
      },
      include: { lines: true },
    });
    await sys.fulfillment.create({
      data: {
        accountId: account,
        orderId: order.id,
        connectionId: connection,
        externalId: `${name}-1`,
        status: "QUEUED",
      },
    });
    await sys.outboundRequest.create({
      data: {
        accountId: account,
        connectionId: connection,
        operation: "order.create",
        idempotencyKey: `${name}-1`,
        payload: {},
      },
    });
    return { account, credential, store, connection, product, order: order.id, line: order.lines[0]!.id };
  }

  beforeAll(async () => {
    A = await seed("Account AAA");
    B = await seed("Account BBB");
  });

  it("every scoped model: account A reads only its own rows", async () => {
    const db = accountDb(A.account) as unknown as Record<
      string,
      { findMany: () => Promise<{ accountId?: string; id: string }[]>; count: () => Promise<number> }
    >;
    for (const model of SCOPED_MODELS) {
      const rows = await db[delegateKey(model)]!.findMany();
      for (const r of rows) expect(model === "Account" ? r.id : r.accountId, model).toBe(A.account);
      expect(await db[delegateKey(model)]!.count(), model).toBe(rows.length);
    }
    const sysCount = await systemDb().product.count();
    expect(sysCount).toBeGreaterThanOrEqual(2);
  });

  it("aggregate and groupBy stay inside the account", async () => {
    const db = accountDb(A.account);
    expect((await db.order.aggregate({ _sum: { total: true } }))._sum.total?.toString()).toBe("10");
    const groups = await db.product.groupBy({ by: ["accountId"], _count: true });
    expect(groups.map((g) => g.accountId)).toEqual([A.account]);
  });

  it("account A cannot update, delete or upsert account B rows", async () => {
    const db = accountDb(A.account);
    expect(await db.product.findUnique({ where: { id: B.product } })).toBeNull();
    await expect(db.product.update({ where: { id: B.product }, data: { name: "hacked" } })).rejects.toThrow();
    expect((await db.product.deleteMany({ where: { id: B.product } })).count).toBe(0);
    await db.product.upsert({
      where: { id: B.product },
      create: { accountId: A.account, sku: "upserted", name: "u" },
      update: { name: "hacked" },
    });
    const b = await systemDb().product.findUniqueOrThrow({ where: { id: B.product } });
    expect(b.name).toBe("Account BBB product");
  });

  it("account A cannot point its rows at account B parents (composite foreign keys)", async () => {
    const db = accountDb(A.account);
    await expect(
      db.productEan.create({ data: { accountId: A.account, productId: B.product, ean: "1" } }),
    ).rejects.toThrow();
    await expect(
      db.storeVariantLink.create({
        data: {
          accountId: A.account,
          storeId: B.store,
          shopifyVariantGid: "v",
          shopifyProductGid: "p",
          title: "t",
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.fulfillment.create({
        data: {
          accountId: A.account,
          orderId: A.order,
          connectionId: B.connection,
          externalId: "x-1",
          status: "QUEUED",
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.outboundRequest.create({
        data: {
          accountId: A.account,
          connectionId: B.connection,
          operation: "x",
          idempotencyKey: "steal",
          payload: {},
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.store.create({
        data: {
          accountId: A.account,
          domain: "evil.example",
          code: "EVL",
          name: "e",
          currency: "EUR",
          credentialId: B.credential,
        },
      }),
    ).rejects.toThrow();
    await expect(db.order.update({ where: { id: A.order }, data: { storeId: B.store } })).rejects.toThrow();
    await expect(
      db.order.update({ where: { id: A.order }, data: { store: { connect: { id: B.store } } } }),
    ).rejects.toThrow();
    await expect(
      db.orderLine.update({ where: { id: A.line }, data: { orderId: B.order } }),
    ).rejects.toThrow();
    // B's unique slots are untouched
    expect(await systemDb().outboundRequest.count({ where: { idempotencyKey: "steal" } })).toBe(0);
  });

  it("users and other account-less tables are not reachable through an account scope", async () => {
    const db = accountDb(A.account) as unknown as { user: { findMany: () => Promise<unknown> } };
    await expect(db.user.findMany()).rejects.toBeInstanceOf(TenantScopeError);
  });

  it("$transaction and raw SQL are disabled on scoped clients", () => {
    const db = accountDb(A.account) as unknown as Record<string, () => unknown>;
    for (const m of ["$transaction", "$queryRaw", "$executeRaw", "$queryRawUnsafe", "$executeRawUnsafe"]) {
      expect(() => db[m]!(), m).toThrow(TenantScopeError);
    }
    expect(() => (systemDb() as unknown as Record<string, () => unknown>).$executeRawUnsafe!()).toThrow(
      TenantScopeError,
    );
  });

  it("withAccountTransaction is atomic, injects accountId and is protected by RLS", async () => {
    await expect(
      withAccountTransaction(A.account, async (tx) => {
        await tx.product.create({
          data: { sku: "rollback-me", name: "x" } as Prisma.ProductUncheckedCreateInput,
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await systemDb().product.count({ where: { sku: "rollback-me" } })).toBe(0);

    await withAccountTransaction(A.account, async (tx) => {
      const all = await tx.product.findMany();
      expect(all.length).toBeGreaterThan(0);
      expect(all.every((p) => p.accountId === A.account)).toBe(true);
      expect(await tx.product.findUnique({ where: { id: B.product } })).toBeNull();
      await expect(
        tx.product.create({ data: { accountId: B.account, sku: "x", name: "x" } }),
      ).rejects.toBeInstanceOf(TenantScopeError);
    });
  });

  it("without a scope the database returns nothing (default deny)", async () => {
    const rows = await basePrisma().$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Product"`;
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it("the audit log is append-only, even for the system scope", async () => {
    const sys = systemDb();
    const row = await sys.auditLog.create({ data: { accountId: A.account, action: "test" } });
    await expect(
      sys.auditLog.update({ where: { id: row.id }, data: { action: "changed" } }),
    ).rejects.toThrow();
    // No UPDATE/DELETE policy: the rows are invisible to DELETE; the trigger catches anything that gets through.
    await sys.auditLog.deleteMany({ where: { id: row.id } }).catch(() => undefined);
    expect(await sys.auditLog.findUnique({ where: { id: row.id } })).not.toBeNull();
    const asOwner = await basePrisma()
      .$transaction(async (tx) => {
        await tx.$executeRaw`ALTER TABLE "AuditLog" NO FORCE ROW LEVEL SECURITY`; // owner without RLS…
        return tx.$executeRaw`DELETE FROM "AuditLog" WHERE id = ${row.id}`;
      })
      .catch((e: Error) => e);
    expect(String(asOwner)).toMatch(/append-only/); // …is still stopped by the trigger (and rolled back)
    await expect(sys.account.delete({ where: { id: A.account } })).rejects.toThrow();
  });

  it("every table with accountId has forced RLS, and the app role cannot bypass it", async () => {
    const rows = await basePrisma().$queryRaw<{ table: string; rls: boolean; forced: boolean }[]>`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
      FROM information_schema.columns col
      JOIN pg_class c ON c.relname = col.table_name
      WHERE col.table_schema = 'public' AND col.column_name = 'accountId'`;
    expect(rows.length).toBe(SCOPED_MODELS.length - 1); // all scoped models except Account (scoped by id)
    for (const r of rows) expect({ ...r }).toEqual({ table: r.table, rls: true, forced: true });
    await expect(assertSafeDatabaseRole()).resolves.toBeUndefined();
  });
});
