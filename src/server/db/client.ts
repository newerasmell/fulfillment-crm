import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/generated/prisma/client";

/**
 * Database access. Two layers protect tenant data (CLAUDE.md: every query is scoped by accountId):
 *  1. `accountDb(accountId)` injects `accountId` into every query's where/data (and rejects a different
 *     accountId), so repository code cannot forget the scope.
 *  2. Postgres row-level security (prisma/migrations/*_rls): every operation runs in a transaction that
 *     sets `app.account_id`; rows of other accounts are invisible and cannot be written.
 *  3. Composite foreign keys (accountId, xId) → (accountId, id) in the schema: a row can never point at a
 *     parent of another account, even though FK checks ignore RLS.
 * `systemDb()` is the explicit, greppable escape hatch for jobs that must work across accounts
 * (login, membership lookup, worker sweeps). Use it only where an account is not known yet.
 *
 * Every operation of these clients runs in its own short transaction (that is how the RLS setting is
 * applied), so `$transaction` and raw SQL are disabled on them: use `withAccountTransaction` /
 * `withSystemTransaction` for multi-statement atomic work.
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

/**
 * Walks nested write payloads (create / connectOrCreate / upsert / createMany inside relation fields) and
 * rejects any accountId other than the scope, or an attempt to (re)connect the `account` relation.
 * Nested children get their accountId from the composite FK of the parent, so nothing is injected here.
 */
function assertNested(value: unknown, accountId: string, path: string, depth = 0): void {
  if (!value || typeof value !== "object" || depth > 12) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNested(v, accountId, `${path}[${i}]`, depth + 1));
    return;
  }
  if (value instanceof Date || Buffer.isBuffer(value)) return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "account") throw new TenantScopeError(`${path}.account: the account relation cannot be set`);
    if (k === "accountId" && typeof v !== "object") assertSameAccount(v, accountId, `${path}.accountId`);
    else assertNested(v, accountId, `${path}.${k}`, depth + 1);
  }
}

function scopeData(data: unknown, accountId: string, model: string): unknown {
  if (Array.isArray(data)) return data.map((d) => scopeData(d, accountId, model));
  if (!data || typeof data !== "object") return data;
  const d = data as Record<string, unknown>;
  assertNested(d, accountId, `${model}.data`);
  return { ...d, accountId };
}

function guardUpdateData(data: unknown, accountId: string, model: string) {
  assertNested(data, accountId, `${model}.update`);
}

/** Pure: returns args with the tenant scope applied. Exported for unit tests. */
export function scopeArgs(model: string, operation: string, rawArgs: unknown, accountId: string): Args {
  const args: Args = { ...((rawArgs as Args | undefined) ?? {}) };
  if (GLOBAL_MODELS.has(model)) {
    // Users, login attempts and spec versions belong to no account: only systemDb() may touch them.
    throw new TenantScopeError(`${model} is not account-scoped; use systemDb()`);
  }

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
    args.data = model === "Account" ? args.data : scopeData(args.data, accountId, model);
  }
  if (operation === "upsert") {
    args.create = scopeData(args.create, accountId, model);
    guardUpdateData(args.update, accountId, model);
  }
  return args;
}

function disabled(name: string): never {
  throw new TenantScopeError(
    `${name} is disabled on scoped clients; use withAccountTransaction()/withSystemTransaction()`,
  );
}

function withRls(client: PrismaClient, settings: { accountId: string | null; bypass: boolean }) {
  return client.$extends({
    name: settings.bypass ? "system-scope" : "account-scope",
    client: {
      $transaction: (..._args: unknown[]): never => disabled("$transaction"),
      $queryRaw: (..._args: unknown[]): never => disabled("$queryRaw"),
      $executeRaw: (..._args: unknown[]): never => disabled("$executeRaw"),
      $queryRawUnsafe: (..._args: unknown[]): never => disabled("$queryRawUnsafe"),
      $executeRawUnsafe: (..._args: unknown[]): never => disabled("$executeRawUnsafe"),
    },
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

const MODEL_BY_DELEGATE = new Map(
  Object.values(Prisma.ModelName).map((m) => [m.charAt(0).toLowerCase() + m.slice(1), m as string]),
);
const BLOCKED_TX_KEYS = new Set(["$queryRaw", "$executeRaw", "$queryRawUnsafe", "$executeRawUnsafe"]);

/** Wraps an interactive transaction client so every model call gets the same accountId injection. */
function scopeTransactionClient(tx: Prisma.TransactionClient, accountId: string): Prisma.TransactionClient {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && BLOCKED_TX_KEYS.has(prop))
        return () => disabled(`${prop} (account tx)`);
      const value = Reflect.get(target, prop, receiver);
      const model = typeof prop === "string" ? MODEL_BY_DELEGATE.get(prop) : undefined;
      if (!model || !value || typeof value !== "object") return value;
      return new Proxy(value as object, {
        get(delegate, op, r) {
          const fn = Reflect.get(delegate, op, r);
          if (typeof fn !== "function" || typeof op !== "string") return fn;
          return (args?: unknown) => {
            try {
              return fn.call(delegate, scopeArgs(model, op, args, accountId));
            } catch (err) {
              return Promise.reject(err);
            }
          };
        },
      });
    },
  });
}

/** Tables whose rows may be locked from an account transaction (row locks serialise racing changes). */
const LOCKABLE: Readonly<Record<"Membership" | "FulfillmentConnection", string>> = Object.freeze(
  Object.assign(Object.create(null) as object, {
    Membership: '"Membership"',
    FulfillmentConnection: '"FulfillmentConnection"',
  }),
);
export type LockableTable = "Membership" | "FulfillmentConnection";

export interface AccountTxHelpers {
  /** SELECT … FOR UPDATE on this account's rows of `table` (one row when `id` is given). */
  lockForUpdate(table: LockableTable, id?: string): Promise<void>;
}

/**
 * Interactive (real, atomic) transaction scoped to one account: accountId is injected like accountDb()
 * and RLS applies to everything inside. Raw SQL is disabled inside; use `helpers.lockForUpdate` for locks.
 */
export async function withAccountTransaction<T>(
  accountId: string,
  fn: (tx: Prisma.TransactionClient, helpers: AccountTxHelpers) => Promise<T>,
  options?: { timeout?: number; maxWait?: number },
): Promise<T> {
  if (!accountId) throw new TenantScopeError("accountId is required");
  return basePrisma().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.account_id', ${accountId}, TRUE), set_config('app.bypass_rls', 'off', TRUE)`;
    const helpers: AccountTxHelpers = {
      async lockForUpdate(table, id) {
        if (!Object.hasOwn(LOCKABLE, table))
          throw new TenantScopeError(`not a lockable table: ${String(table)}`);
        const t = LOCKABLE[table];
        // NO KEY UPDATE: serialises writers of these rows without blocking inserts that reference them.
        if (id) {
          await tx.$queryRawUnsafe(
            `SELECT 1 FROM ${t} WHERE "accountId" = $1 AND id = $2 FOR NO KEY UPDATE`,
            accountId,
            id,
          );
        } else {
          await tx.$queryRawUnsafe(
            `SELECT 1 FROM ${t} WHERE "accountId" = $1 ORDER BY id FOR NO KEY UPDATE`,
            accountId,
          );
        }
      },
    };
    return fn(scopeTransactionClient(tx, accountId), helpers);
  }, options);
}

/** True for Prisma's unique-constraint violation (P2002). */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Applied migration names; the worker refuses to start on a schema older than its code (render.yaml runs
 * migrations as the web service's pre-deploy step, the worker may start first).
 */
export async function appliedMigrations(): Promise<Set<string>> {
  const rows = await basePrisma().$queryRaw<{ migration_name: string }[]>`
    SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  return new Set(rows.map((r) => r.migration_name));
}

/**
 * Refuses to run as a role that bypasses RLS (SUPERUSER or BYPASSRLS) — the policies would silently
 * not apply. Called at web and worker startup. Escape hatch for emergencies: ALLOW_PRIVILEGED_DB_ROLE=1.
 */
export async function assertSafeDatabaseRole() {
  const rows = await basePrisma().$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
    SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
  const role = rows[0];
  if (role && (role.rolsuper || role.rolbypassrls) && process.env.ALLOW_PRIVILEGED_DB_ROLE !== "1") {
    throw new Error(
      "Database role bypasses row-level security (superuser/BYPASSRLS); connect as the app role",
    );
  }
}

/** Interactive transaction across accounts (worker sweeps, e.g. SELECT … FOR UPDATE SKIP LOCKED). */
export async function withSystemTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return basePrisma().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', TRUE)`;
    return fn(tx);
  });
}
