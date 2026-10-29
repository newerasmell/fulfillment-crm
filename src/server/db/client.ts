import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/generated/prisma/client";

/**
 * Database access. Two layers protect tenant data (CLAUDE.md: every query is scoped by accountId):
 *  1. `accountDb(accountId)` injects `accountId` into every query's where/data (and rejects a different
 *     accountId), so repository code cannot forget the scope.
 *  2. Postgres row-level security (prisma/migrations/*_rls): every operation runs in a transaction that
 *     sets `app.account_id`; rows of other accounts are invisible and cannot be written.
 * `systemDb()` is the explicit, greppable escape hatch for jobs that must work across accounts
 * (login, membership lookup, worker sweeps). Use it only where an account is not known yet.
 */

const GLOBAL_MODELS = new Set<string>(["User", "LoginAttempt", "ApiSpecVersion"]);

const UNIQUE_WHERE_OPS = new Set(["findUnique", "findUniqueOrThrow", "update", "delete", "upsert"]);
const WHERE_OPS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "updateManyAndReturn",
  "deleteMany",
]);
const CREATE_OPS = new Set(["create", "createMany", "createManyAndReturn"]);

export class TenantScopeError extends Error {
  constructor(message: string) {
    super(`Tenant scope violation: ${message}`);
    this.name = "TenantScopeError";
  }
}

const globalForPrisma = globalThis as unknown as { __crmPrisma?: PrismaClient };

function createBaseClient(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

/** Raw client — only for this module, migrations helpers and tests. Never import elsewhere. */
export function basePrisma(): PrismaClient {
  globalForPrisma.__crmPrisma ??= createBaseClient();
  return globalForPrisma.__crmPrisma;
}

/** For tests: drop the cached client (e.g. after DATABASE_URL changed). */
export async function resetPrismaForTests() {
  await globalForPrisma.__crmPrisma?.$disconnect();
  globalForPrisma.__crmPrisma = undefined;
}

type Args = Record<string, unknown> & { where?: Record<string, unknown>; data?: unknown };

function assertSameAccount(value: unknown, accountId: string, where: string) {
  if (value !== undefined && value !== accountId) {
    throw new TenantScopeError(`${where} has accountId ${String(value)}, scope is ${accountId}`);
  }
}

function scopeData(data: unknown, accountId: string, model: string): unknown {
  if (Array.isArray(data)) return data.map((d) => scopeData(d, accountId, model));
  if (!data || typeof data !== "object") return data;
  const d = data as Record<string, unknown>;
  if ("account" in d) {
    throw new TenantScopeError(`${model}: use the scalar accountId, not the account relation`);
  }
  assertSameAccount(d.accountId, accountId, `${model}.data`);
  return { ...d, accountId };
}

function guardUpdateData(data: unknown, accountId: string, model: string) {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if ("account" in d) throw new TenantScopeError(`${model}: account relation cannot be changed`);
    assertSameAccount(d.accountId, accountId, `${model}.update`);
  }
}

/** Pure: returns args with the tenant scope applied. Exported for unit tests. */
export function scopeArgs(model: string, operation: string, rawArgs: unknown, accountId: string): Args {
  const args: Args = { ...((rawArgs as Args | undefined) ?? {}) };
  if (GLOBAL_MODELS.has(model)) return args;

  const key = model === "Account" ? "id" : "accountId";

  if (model === "Account" && (CREATE_OPS.has(operation) || operation === "upsert")) {
    throw new TenantScopeError("accounts are created with systemDb()");
  }

  if (UNIQUE_WHERE_OPS.has(operation) || WHERE_OPS.has(operation)) {
    const where = { ...(args.where ?? {}) };
    assertSameAccount(where[key], accountId, `${model}.where`);
    where[key] = accountId;
    args.where = where;
  }
  if (operation === "update" || operation === "updateMany" || operation === "updateManyAndReturn") {
    guardUpdateData(args.data, accountId, model);
  }
  if (CREATE_OPS.has(operation)) {
    args.data = scopeData(args.data, accountId, model);
  }
  if (operation === "upsert") {
    args.create = scopeData(args.create, accountId, model);
    guardUpdateData(args.update, accountId, model);
  }
  return args;
}

function withRls(client: PrismaClient, settings: { accountId: string | null; bypass: boolean }) {
  return client.$extends({
    name: settings.bypass ? "system-scope" : "account-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const scoped = settings.accountId ? scopeArgs(model, operation, args, settings.accountId) : args;
          const [, result] = await client.$transaction([
            client.$executeRaw`SELECT set_config('app.account_id', ${settings.accountId ?? ""}, TRUE), set_config('app.bypass_rls', ${settings.bypass ? "on" : "off"}, TRUE)`,
            query(scoped as typeof args),
          ]);
          return result;
        },
      },
    },
  });
}

export type AccountDb = ReturnType<typeof accountDb>;
export type SystemDb = ReturnType<typeof systemDb>;

export function accountDb(accountId: string) {
  if (!accountId) throw new TenantScopeError("accountId is required");
  return withRls(basePrisma(), { accountId, bypass: false });
}

export function systemDb() {
  return withRls(basePrisma(), { accountId: null, bypass: true });
}

/**
 * Interactive transaction scoped to one account. RLS applies to everything inside; `accountId` is NOT
 * injected automatically here, so pass it explicitly in where/data (RLS rejects mistakes).
 */
export async function withAccountTransaction<T>(
  accountId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!accountId) throw new TenantScopeError("accountId is required");
  return basePrisma().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.account_id', ${accountId}, TRUE), set_config('app.bypass_rls', 'off', TRUE)`;
    return fn(tx);
  });
}

/** Interactive transaction across accounts (worker sweeps). */
export async function withSystemTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return basePrisma().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', TRUE)`;
    return fn(tx);
  });
}
