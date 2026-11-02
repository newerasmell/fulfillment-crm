import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

/**
 * Production has data and no staging: the NEWEST migration must apply on a database that already holds rows
 * in the tables it touches, not only on an empty one. This applies every migration but the newest, inserts
 * a realistic set of rows (as the superuser, so RLS does not get in the way), then applies the newest one.
 * When a future migration changes a seeded table, adjust SEED to the schema BEFORE that migration.
 */
const SEED = `
INSERT INTO "Account"(id,name,"updatedAt") VALUES ('accA','Група А',now()),('accB','Група Б',now());
INSERT INTO "User"(id,email,name,"passwordHash","updatedAt") VALUES ('u1','o@example.com','O','x',now());
INSERT INTO "Membership"(id,"accountId","userId",role) VALUES ('m1','accA','u1','OWNER');
INSERT INTO "Invitation"(id,"accountId",email,role,"tokenHash","expiresAt")
  VALUES ('i1','accA','x@example.com','VIEWER','h1',now()+interval '1 day');
INSERT INTO "Store"(id,"accountId",domain,code,name,currency,"updatedAt")
  VALUES ('s1','accA','a.example','AAA','A','EUR',now()),('s2','accB','b.example','BBB','B','EUR',now());
INSERT INTO "FulfillmentConnection"(id,"accountId",type,name,"updatedAt") VALUES ('c1','accA','FHB_V3','FHB',now());
INSERT INTO "Product"(id,"accountId",sku,name,"updatedAt") VALUES ('p1','accA','SKU-1','P',now());
INSERT INTO "Order"(id,"accountId",source,number,currency,subtotal,total,"paymentMethod","placedAt","updatedAt")
  VALUES ('o1','accA','MANUAL','1','EUR',1,1,'COD',now(),now());
INSERT INTO "AuditLog"(id,"accountId",action) VALUES ('a1','accA','seed');
`;

function withDatabase(url: string, db: string) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

describe("newest migration on a populated database", () => {
  it("applies cleanly on top of existing rows", async () => {
    const adminUrl = process.env.TEST_DATABASE_ADMIN_URL!;
    const appUrl = process.env.TEST_DATABASE_URL!;
    const name = `crm_test_mig_${Date.now()}`;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}" OWNER "${decodeURIComponent(new URL(appUrl).username)}"`);
    await admin.end();
    try {
      const all = readdirSync("prisma/migrations", { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
      const older = mkdtempSync(path.join(tmpdir(), "mig-"));
      for (const m of all.slice(0, -1))
        cpSync(path.join("prisma/migrations", m), path.join(older, m), { recursive: true });
      cpSync("prisma/migrations/migration_lock.toml", path.join(older, "migration_lock.toml"));
      const deploy = (dir: string) =>
        execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
          env: { ...process.env, DATABASE_URL: withDatabase(appUrl, name), PRISMA_MIGRATIONS_DIR: dir },
          stdio: "pipe",
        }).toString();
      deploy(older);
      const seed = new pg.Client({ connectionString: withDatabase(adminUrl, name) });
      await seed.connect();
      await seed.query(SEED);
      await seed.end();
      expect(deploy(path.resolve("prisma/migrations"))).toMatch(/successfully applied|No pending/);
      const check = new pg.Client({ connectionString: withDatabase(adminUrl, name) });
      await check.connect();
      const missing = await check.query(
        `SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NULL`,
      );
      await check.end();
      expect(missing.rows[0].n).toBe(0);
    } finally {
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await c.end();
    }
  }, 120_000);
});
