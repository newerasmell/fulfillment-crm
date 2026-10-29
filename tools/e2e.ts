// Runs the Playwright suite against a throwaway database with a seeded OWNER.
//   pnpm test:e2e            (extra args go to `playwright test`)
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { createTestDatabase } from "../tests/test-db";

const db = await createTestDatabase();
let status = 1;
try {
  process.env.DATABASE_URL = db.url;
  const { bootstrapOwner } = await import("@/server/auth/users");
  const { basePrisma } = await import("@/server/db/client");
  const owner = await bootstrapOwner({
    email: "e2e-owner@example.com",
    name: "E2E Owner",
    accountName: "Тест фирма А",
    password: "e2e-password-not-secret",
  });
  await basePrisma().$disconnect();
  const run = spawnSync("pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: {
      ...process.env,
      E2E_DATABASE_URL: db.url,
      E2E_OWNER_EMAIL: owner.user.email,
      E2E_OWNER_PASSWORD: "e2e-password-not-secret",
      E2E_OWNER_TOTP: owner.totpSecret,
    },
  });
  status = run.status ?? 1;
} finally {
  await db.drop();
}
process.exit(status);
