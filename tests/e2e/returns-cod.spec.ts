import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

// Synthetic data only (tests/e2e/seed-returns.ts): group "Тест група Връщания" with an FHB and an euShipments
// warehouse, returns from both and COD shipments in EUR/HUF. No worker runs during e2e: the sweeps ran in the
// seed, and tools/e2e-returns-worker.ts fetches queued return photos from a mocked FHB.
const RETURNS_OWNER = {
  email: process.env.E2E_RETURNS_EMAIL ?? "",
  password: process.env.E2E_RETURNS_PASSWORD ?? "",
  totp: process.env.E2E_RETURNS_TOTP ?? "",
};

function runWorker() {
  execFileSync("pnpm", ["exec", "tsx", "tools/e2e-returns-worker.ts"], {
    env: { ...process.env, DATABASE_URL: process.env.E2E_DATABASE_URL ?? "" },
    stdio: "pipe",
  });
}

const tab = (page: Page, key: string) => page.getByTestId(`returns-tab-${key}`);

test("returns board: sources, overdue, processed with note, support, photos, filters, settings; COD board", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await login(page, RETURNS_OWNER);

  // ── Връщания ──
  await page.goto("/returns");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "Връщания", level: 1 })).toBeVisible();
  await expect(tab(page, "todo")).toContainText("4");
  await expect(tab(page, "returning")).toContainText("1");
  await expect(tab(page, "overdue")).toContainText("1");
  await expect(tab(page, "all")).toContainText("5");

  const local = page.getByTestId("return-#RT-1002");
  await expect(local).toContainText("FHB · връщане в депо");
  await expect(local).toContainText("Damaged box");
  await expect(local).toContainText("Снимки (1)");
  await expect(local).toContainText("Код на връщане AB00002");
  await expect(page.getByTestId("return-#RT-1001")).toContainText("FHB · върнати от куриер");
  await expect(page.getByTestId("return-#RT-1001")).toContainText("върнато от куриера");
  await expect(page.getByTestId("return-ZOE-9001")).toContainText("няма поръчка в CRM");
  await expect(page.getByTestId("return-#RT-2002")).toContainText("Returned to Warehouse");
  await page.screenshot({ path: "docs/screens/p6-returns.png", fullPage: true });

  // Overdue: still on the way back after 14 days.
  await tab(page, "overdue").click();
  await expect(page.getByTestId("return-#RT-2001")).toContainText("Просрочено — 20 дни на път");

  // Processed with a note → leaves "За обработка", shows in "Обработени".
  await tab(page, "todo").click();
  const rma = page.getByTestId("return-#RT-1001");
  await rma.getByRole("button", { name: "Маркирай като обработено" }).click();
  const form = page.getByRole("form", { name: "Обработи връщане #RT-1001" });
  await form.getByLabel("Бележка").fill("Сумата е възстановена, стоката е заприходена");
  await form.getByRole("button", { name: "Обработено" }).click();
  await expect(page.getByTestId("return-#RT-1001")).toHaveCount(0);
  await expect(tab(page, "todo")).toContainText("3");
  await tab(page, "processed").click();
  await expect(page.getByTestId("return-#RT-1001")).toContainText("Бележка: Сумата е възстановена");
  await expect(page.getByTestId("return-#RT-1001")).toContainText("Обработено от E2E Returns");

  // Notify support (sent by the worker; no channel is configured here, so nothing leaves).
  await tab(page, "todo").click();
  const eu = page.getByTestId("return-#RT-2002");
  await eu.getByRole("button", { name: "Уведоми поддръжката" }).click();
  await expect(eu.getByRole("button", { name: "Ще бъде изпратено при следващата проверка" })).toBeDisabled();

  // Photos of the local return: queued, fetched by the (mocked) worker, served by the CRM.
  await local.getByRole("button", { name: "Зареди снимките" }).click();
  await expect(local.getByRole("button", { name: "Снимките се зареждат…" })).toBeVisible();
  runWorker();
  await page.reload();
  const photo = page.getByTestId("return-#RT-1002").getByRole("link", { name: /опаковка/ });
  await expect(photo).toBeVisible();
  const img = await page.request.get((await photo.getAttribute("href"))!);
  expect(img.status()).toBe(200);
  expect(img.headers()["content-type"]).toBe("image/png");

  // Filters: source, search, product line (sidebar), warehouse scope (header).
  await page.goto("/returns?tab=all&source=EUSHIPMENTS");
  await expect(page.locator('[data-testid^="return-"]')).toHaveCount(2);
  await page.goto("/returns?tab=all");
  await page.getByLabel("Търси поръчка, товарителница или код на връщане").fill("AB00002");
  await page.getByRole("button", { name: "Филтрирай" }).click();
  await expect(page.locator('[data-testid^="return-"]')).toHaveCount(1);
  await page.goto("/returns?tab=all");
  const nav = page.getByRole("navigation", { name: "Основна навигация" });
  await nav.getByLabel("Линия", { exact: true }).selectOption({ label: "Текстил" });
  await expect(page.getByTestId("return-#RT-1002")).toHaveCount(0);
  await expect(page.getByTestId("return-#RT-2001")).toBeVisible();
  await expect(tab(page, "all")).toContainText("2");
  await nav.getByLabel("Линия", { exact: true }).selectOption({ label: "Всички линии" });
  await expect(tab(page, "all")).toContainText("5");
  const scope = page.getByRole("group", { name: "Склад" });
  let saved = page.waitForResponse((r) => r.request().method() === "POST"); // server action sets the cookie
  await scope.getByRole("button", { name: "FHB" }).click();
  await expect(scope.getByRole("button", { name: "FHB" })).toHaveAttribute("aria-pressed", "true");
  await saved;
  await page.reload();
  await expect(tab(page, "all")).toContainText("3");
  saved = page.waitForResponse((r) => r.request().method() === "POST");
  await page.getByRole("group", { name: "Склад" }).getByRole("button", { name: "Всички складове" }).click();
  await saved;
  await page.reload();
  await expect(tab(page, "all")).toContainText("5");

  // Settings: a longer overdue threshold clears the overdue tab.
  const settings = page.getByRole("form", { name: "Настройки за връщания" });
  await settings.getByLabel(/Сигнал „връща се/).fill("30");
  await settings.getByRole("button", { name: "Запази" }).click();
  await expect(settings.getByRole("status")).toHaveText("Запазено");
  await page.reload();
  await expect(tab(page, "overdue")).toContainText("0");

  // Начало: returns waiting for a refund.
  await page.goto("/");
  await expect(page.getByRole("link", { name: /Върнати за възстановяване/ })).toContainText("3");

  // ── Наложен платеж ──
  await page.goto("/cod");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "Наложен платеж", level: 1 })).toBeVisible();
  await expect(page.getByTestId("cod-tab-outstanding")).toContainText("3");
  await expect(page.getByTestId("cod-tab-mismatch")).toContainText("2");
  await expect(page.getByTestId("cod-tab-paid")).toContainText("1");
  await expect(page.getByTestId("cod-tab-in_transit")).toContainText("1");
  await expect(page.getByTestId("cod-bucket-d0_7")).toContainText("1");
  await expect(page.getByTestId("cod-bucket-d8_14")).toContainText("1");
  await expect(page.getByTestId("cod-bucket-d30_plus")).toContainText("1");
  await expect(page.getByTestId("cod-total-EUR")).toContainText("55,50");
  await expect(page.getByTestId("cod-total-HUF")).toContainText("12");
  await expect(page.getByTestId("cod-row-#CD-1")).toContainText("чака от куриера");
  await page.screenshot({ path: "docs/screens/p6-cod.png", fullPage: true });

  await page.getByTestId("cod-bucket-d30_plus").click();
  await expect(page.locator('[data-testid^="cod-row-"]')).toHaveCount(1);
  await expect(page.getByTestId("cod-row-#CD-3")).toContainText("Липсва в склада");

  await page.getByTestId("cod-tab-mismatch").click();
  await expect(page.getByTestId("cod-row-#CD-2")).toContainText("Различна сума");
  await expect(page.getByTestId("cod-mismatch-summary")).toBeVisible();

  await page.getByTestId("cod-tab-paid").click();
  await expect(page.getByTestId("cod-row-#CD-4")).toContainText("протокол 90001");

  const csv = await page.request.get("/api/cod/export?tab=all");
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  const text = await csv.text();
  expect(text).toContain("expected_cod");
  for (const n of ["#CD-1", "#CD-2", "#CD-3", "#CD-4", "#CD-5"]) expect(text).toContain(n);
  expect(text).not.toContain("Синтетичен клиент");

  // Mismatches are operator tasks.
  await page.goto("/alerts");
  await expect(page.getByText(/COD of #CD-2 differs/)).toBeVisible();
  await expect(page.getByText(/COD of #CD-3 is missing/)).toBeVisible();
});
