import { expect, test } from "@playwright/test";
import pg from "pg";
import { login, OWNER } from "./helpers";

// Synthetic watcher data seeded straight into the throwaway e2e database (no vendor fetch, no worker):
// two FHB spec versions (baseline + a breaking change with its brief), source states and one open alert.

const BRIEF = [
  "# Upgrade brief: FHB Kika API v3",
  "",
  "**2 breaking, 1 additive, 0 informational.**",
  "",
  "## Breaking (2)",
  "",
  "- `GET /stock`: endpoint removed",
  "- `POST /order` request `body:note`: added (string, required)",
].join("\n");

async function seed() {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    // Same escape hatch as systemDb(): cross-account seeding for the test only.
    await client.query("SELECT set_config('app.bypass_rls', 'on', TRUE)");
    const { rows } = await client.query<{ accountId: string }>(
      `SELECT m."accountId" FROM "Membership" m JOIN "User" u ON u.id = m."userId" WHERE u.email = $1 LIMIT 1`,
      [OWNER.email],
    );
    const accountId = rows[0]!.accountId;
    const suffix = Date.now().toString(36);
    const counts = { breaking: 2, additive: 1, info: 0 };
    await client.query(
      `INSERT INTO "ApiSpecVersion"(id, vendor, "sourceUrl", "fetchedAt", hash, normalised, diff) VALUES
        ($1, 'FHB_V3', 'https://api.example.test/v3/openapi', now() - interval '1 day', $3, '{}', NULL),
        ($2, 'FHB_V3', 'https://api.example.test/v3/openapi', now(), $4, '{}', $5)`,
      [
        `e2e-v1-${suffix}`,
        `e2e-v2-${suffix}`,
        "aaaaaaaaaaaa".padEnd(64, "0"),
        "bbbbbbbbbbbb".padEnd(64, "0"),
        JSON.stringify({ counts, changes: [], previousId: `e2e-v1-${suffix}`, brief: BRIEF }),
      ],
    );
    await client.query(
      `INSERT INTO "ApiWatchSource"(id, "lastCheckedAt", "lastOkAt", "lastError", failures, "updatedAt") VALUES
        ('FHB_V3', now(), now(), NULL, 0, now()),
        ('EUSHIPMENTS', now(), now() - interval '2 days', 'HTTP 502', 2, now())
       ON CONFLICT (id) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO "Alert"(id, "accountId", kind, severity, status, title, body, "entityType", "entityId")
       VALUES ($1, $2, 'api.spec_change', 'CRITICAL', 'OPEN', $3, $4, 'ApiSpecVersion', $5)`,
      [
        `e2e-alert-${suffix}`,
        accountId,
        "FHB Kika API v3 API changed: 2 breaking, 1 additive, 0 informational",
        BRIEF,
        `e2e-v2-${suffix}`,
      ],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

test("settings: API changes shows spec versions, source state, the brief, and alerts can be resolved", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await seed();
  await login(page);
  await page.goto("/settings/jobs");
  await page.getByRole("link", { name: /API промени/ }).click();
  await expect(page).toHaveURL(/\/settings\/api-changes$/);
  await expect(page.getByRole("heading", { name: "API промени", level: 1 })).toBeVisible();

  // Open alert with its brief.
  const alerts = page.getByRole("list", { name: "Отворени сигнали" });
  await expect(alerts.getByText("FHB Kika API v3 API changed: 2 breaking, 1 additive")).toBeVisible();
  await expect(alerts.getByText("Критично")).toBeVisible();
  await expect(alerts.getByText(/Промяна в спецификацията/)).toBeVisible(); // kind label (dot-free key)

  // Sources: FHB fine, euShipments failing, the rest not checked yet.
  const fhbRow = page.getByRole("row", { name: /FHB Kika API v3/ }).first();
  await expect(fhbRow.getByText("Наред")).toBeVisible();
  await expect(page.getByRole("row", { name: /euShipments/ }).getByText("Грешка (2 пъти)")).toBeVisible();
  await expect(
    page.getByRole("row", { name: /Shopify Admin API/ }).getByText("Още не е проверявано"),
  ).toBeVisible();

  // History: baseline + the change with counts and an expandable brief.
  await expect(page.getByText("Начална версия")).toBeVisible();
  await expect(page.getByText("2 несъвместими · 1 нови · 0 информативни")).toBeVisible();
  const versionRow = page.getByRole("row", { name: /2 несъвместими/ });
  await versionRow.locator("summary", { hasText: "Upgrade brief" }).click();
  await expect(versionRow.locator("pre")).toContainText("`GET /stock`: endpoint removed");

  await alerts.getByRole("button", { name: "Затвори" }).click();
  await expect(page.getByText("Няма отворени сигнали.")).toBeVisible();
});
