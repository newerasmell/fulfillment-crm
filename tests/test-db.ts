import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";

function withDatabase(url: string, db: string) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/**
 * Creates a throwaway database owned by the app role, installs pgvector (needs the admin role),
 * applies all migrations as the app role and returns its URL plus a drop function.
 */
export async function createTestDatabase() {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  const appTemplate = process.env.TEST_DATABASE_URL;
  if (!adminUrl || !appTemplate) {
    throw new Error("TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL must be set (see .env.example)");
  }
  const host = new URL(adminUrl).hostname;
  if (!["localhost", "127.0.0.1", "::1", "db"].includes(host) && process.env.CI !== "true") {
    throw new Error(`Refusing to create test databases on non-local host ${host} (set CI=true in CI)`);
  }
  const name = `crm_test_${Date.now()}_${randomBytes(3).toString("hex")}`;
  const appUser = decodeURIComponent(new URL(appTemplate).username);

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}" OWNER "${appUser}"`);
  await admin.end();

  async function drop() {
    if (!name.startsWith("crm_test_")) throw new Error(`Refusing to drop ${name}`);
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await c.end();
  }

  const url = withDatabase(appTemplate, name);
  try {
    const adminOnDb = new pg.Client({ connectionString: withDatabase(adminUrl, name) });
    await adminOnDb.connect();
    await adminOnDb.query("CREATE EXTENSION IF NOT EXISTS vector");
    await adminOnDb.end();
    execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: "pipe",
    });
  } catch (err) {
    await drop();
    throw err;
  }
  return { url, name, drop };
}
