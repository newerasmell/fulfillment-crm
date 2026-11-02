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
  const { basePrisma, systemDb } = await import("@/server/db/client");
  const owner = await bootstrapOwner({
    email: "e2e-owner@example.com",
    name: "E2E Owner",
    accountName: "Тест фирма А",
    password: "e2e-password-not-secret",
  });
  // Synthetic Shopify data (fixtures, no network): one store with orders and an unmatched variant.
  const { createStore } = await import("@/server/stores");
  const { importShopifyOrder } = await import("@/server/shopify/orders");
  const { SYNTHETIC_ORDERS } = await import("@/integrations/shopify/__fixtures__/orders");
  const company = await systemDb().company.findFirstOrThrow({ where: { accountId: owner.account.id } });
  const store = await createStore(
    { userId: owner.user.id, accountId: owner.account.id, role: "OWNER", companyScope: null },
    {
      companyId: company.id,
      name: "Демо магазин",
      domain: "e2e-demo.myshopify.com",
      code: "DM",
      currency: "EUR",
      countries: ["BG", "RO"],
      clientId: "e2e-client-id",
      clientSecret: "e2e-client-secret-not-real",
    },
  );
  const seeded = await systemDb().store.update({ where: { id: store.id }, data: { skuPrefix: "DM-" } });
  for (const o of SYNTHETIC_ORDERS) await importShopifyOrder(owner.account.id, seeded, o);
  // Synthetic FHB mirror (wave 1, FHB track).
  const { seedFhb } = await import("../tests/e2e/seed-fhb");
  await seedFhb({ userId: owner.user.id, accountId: owner.account.id }, company.id);
  // Synthetic euShipments mirror (vendor mocked): tests/e2e/eushipments.spec.ts.
  const { seedEuShipments } = await import("./e2e-eushipments");
  await seedEuShipments(
    { userId: owner.user.id, accountId: owner.account.id, role: "OWNER", companyScope: null },
    company.id,
  );
  // Review queue (wave 2, review track): its own group and OWNER, so other specs' counts stay unchanged.
  const { seedReview } = await import("../tests/e2e/seed-review");
  const reviewer = await seedReview();
  // Synthetic Fulfill / write-back / alerts data (wave 2, fulfill track): tests/e2e/fulfill.spec.ts.
  const { seedFulfill } = await import("./e2e-fulfill");
  await seedFulfill({ userId: owner.user.id, accountId: owner.account.id }, company.id);
  // Product lines + master catalogue (wave 3, core track): its own group and OWNER (tests/e2e/lines.spec.ts).
  const { seedLines } = await import("../tests/e2e/seed-lines");
  const linesOwner = await seedLines();
  // Manual warehouse choice + reroute (wave 3, override track): its own group and OWNER (tests/e2e/override.spec.ts).
  const { seedOverride } = await import("../tests/e2e/seed-override");
  const overrideOwner = await seedOverride();
  // The web app only enqueues; the queue schema is created here because no worker runs during e2e.
  const { createBoss, ensureQueues } = await import("@/server/jobs/boss");
  const boss = createBoss({ worker: true });
  boss.on("error", () => undefined);
  await boss.start();
  await ensureQueues(boss);
  await boss.stop({ graceful: false });
  await basePrisma().$disconnect();
  const run = spawnSync("pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: {
      ...process.env,
      E2E_DATABASE_URL: db.url,
      E2E_OWNER_EMAIL: owner.user.email,
      E2E_OWNER_PASSWORD: "e2e-password-not-secret",
      E2E_OWNER_TOTP: owner.totpSecret,
      E2E_REVIEW_EMAIL: reviewer.email,
      E2E_REVIEW_PASSWORD: reviewer.password,
      E2E_REVIEW_TOTP: reviewer.totp,
      E2E_LINES_EMAIL: linesOwner.email,
      E2E_LINES_PASSWORD: linesOwner.password,
      E2E_LINES_TOTP: linesOwner.totp,
      E2E_OVERRIDE_EMAIL: overrideOwner.email,
      E2E_OVERRIDE_PASSWORD: overrideOwner.password,
      E2E_OVERRIDE_TOTP: overrideOwner.totp,
    },
  });
  status = run.status ?? 1;
} finally {
  await db.drop();
}
process.exit(status);
