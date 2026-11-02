import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

// Synthetic data only (tests/e2e/seed-lines.ts): group "Тест група Линии" with companies Козметика А / Б and
// Текстил Т, their warehouse catalogues (mirror rows), a store and order #L-8001. No worker runs during e2e:
// tools/e2e-lines-worker.ts processes the queued master catalogue run in its place.
const LINES_OWNER = {
  email: process.env.E2E_LINES_EMAIL ?? "",
  password: process.env.E2E_LINES_PASSWORD ?? "",
  totp: process.env.E2E_LINES_TOTP ?? "",
};

function runWorker() {
  execFileSync("pnpm", ["exec", "tsx", "tools/e2e-lines-worker.ts"], {
    env: { ...process.env, DATABASE_URL: process.env.E2E_DATABASE_URL ?? "" },
    stdio: "pipe",
  });
}

async function setCompanyLine(page: Page, company: string, line: string) {
  const form = page.getByRole("form", { name: `Линия на ${company}` });
  await form.getByLabel(`Линия на фирма ${company}`).selectOption({ label: line });
  await form.getByRole("button", { name: "Запази" }).click();
  await expect(form.getByRole("status")).toHaveText("Запазено");
}

test("product lines: settings, sidebar filter, master catalogue run, suggestions, mapping import, order chips", async ({
  page,
}) => {
  test.setTimeout(420_000);
  await login(page, LINES_OWNER);

  // Настройки → Линии и фирми: create two lines and put every company into one.
  await page.goto("/settings/lines");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "Линии и фирми", level: 1 })).toBeVisible();
  const newLine = page.getByRole("form", { name: "Нова линия" });
  await newLine.getByLabel("Име на линията").fill("Козметика");
  await newLine.getByLabel("Цвят").selectOption("rose");
  await newLine.getByRole("button", { name: "Добави линия" }).click();
  await expect(page.getByTestId("line-row-Козметика")).toBeVisible();
  await newLine.getByLabel("Име на линията").fill("Текстил");
  await newLine.getByLabel("Цвят").selectOption("slate");
  await newLine.getByRole("button", { name: "Добави линия" }).click();
  await expect(page.getByTestId("line-row-Текстил")).toBeVisible();
  await setCompanyLine(page, "Козметика А", "Козметика");
  await setCompanyLine(page, "Козметика Б", "Козметика");
  await setCompanyLine(page, "Текстил Т", "Текстил");
  await expect(page.getByTestId("line-row-Козметика")).toContainText("Козметика А, Козметика Б");

  // Sidebar: the line filter sits above the company filter; picking a line narrows the companies and colours the band.
  const nav = page.getByRole("navigation", { name: "Основна навигация" });
  const lineSelect = nav.getByLabel("Линия", { exact: true });
  await expect(lineSelect.locator("option")).toHaveText(["Всички линии", "Козметика", "Текстил"]);
  await lineSelect.selectOption({ label: "Козметика" });
  await expect(page.getByTestId("line-band")).toContainText("Козметика");
  await expect(nav.getByLabel("Фирма", { exact: true }).locator("option")).toHaveText([
    "Всички фирми",
    "Козметика А",
    "Козметика Б",
  ]);

  // Продукти → Основни продукти по линии: create masters from Козметика А's FHB catalogue (background job).
  await page.goto("/products");
  await page.getByRole("link", { name: "Основни продукти по линии" }).click();
  await expect(page.getByRole("heading", { name: "Основни продукти по линии", level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const start = page.getByRole("form", { name: "Създай основни продукти от каталога на склад" });
  await start.getByLabel("Склад").selectOption({ label: "FHB Козметика А (4 продукта)" });
  await start.getByRole("button", { name: "Създай основни продукти" }).click();
  await expect(start.getByRole("status")).toContainText("Пуснато");
  await expect(page.getByTestId("catalogue-run").first()).toContainText("Чака");
  runWorker();
  const run = page.getByTestId("catalogue-run").first();
  await expect(run).toContainText("Готово", { timeout: 30_000 }); // the page refreshes itself while a run is open
  await expect(run).toContainText("4/4");
  await expect(run).toContainText("създадени 4");
  await expect(run).toContainText("автоматично 4");
  // Coverage: 6 of 7 warehouse products and 2 of 2 variants → below the 99% target.
  const exportHref = await page.getByRole("link", { name: "Изтегли Excel" }).getAttribute("href");
  const lineId = /\/api\/lines\/([^/]+)\//.exec(exportHref ?? "")![1]!;
  const coverage = page.getByTestId(`coverage-${lineId}`);
  await expect(coverage).toContainText("складове 6/7");
  await expect(coverage).toContainText("магазини 2/2");
  await expect(coverage).toContainText("под 99%");

  // Suggestions stay in the line: euShipments EB-9001 has no SKU match, only a name hint → confirm it.
  const sug = page.getByTestId("suggestion-EB-9001");
  await expect(sug).toContainText("SYN-SO-90");
  await expect(sug).toContainText("сходно име");
  await expect(page.getByTestId("suggestion-TT-SYN-CR-50")).toHaveCount(0); // textiles never shows up here
  await sug.getByRole("button", { name: "Потвърди EB-9001 → SYN-SO-90" }).click();
  await expect(page.getByTestId("suggestion-EB-9001")).toHaveCount(0);
  await expect(coverage).toContainText("100%");
  await expect(coverage).toContainText("готово за „На живо“");

  // Excel export works; a CSV built from its header creates a new master after a preview.
  const xlsx = await page.request.get(exportHref!);
  expect(xlsx.status()).toBe(200);
  expect(xlsx.headers()["content-type"]).toContain("spreadsheetml");
  const csv = await (await page.request.get(`/api/lines/${lineId}/mapping?format=csv`)).text();
  const header = csv.replace(String.fromCharCode(0xfeff), "").split(/\r?\n/)[0]!;
  expect(header).toContain("Склад · FHB Козметика А [");
  expect(header).toContain("Магазин · Козметика магазин [");
  const cols = header.split(";");
  const fhbCol = cols.findIndex((c) => c.startsWith("Склад · FHB Козметика А ["));
  const existing = cols.map((_, i) => (i === 0 ? "SYN-CR-50" : i === fhbCol ? "KA-SYN-CR-50" : ""));
  const upload = `${header}\r\nSYN-NEW-1;Синтетичен нов продукт\r\n${existing.join(";")}\r\n`;
  await page.getByLabel("Файл (.xlsx или .csv)").setInputFiles({
    name: "mapping.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(upload, "utf8"),
  });
  await page.getByRole("button", { name: "Провери" }).click();
  await expect(page.getByRole("heading", { name: "Преглед на качената таблица" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("import-status")).toContainText("Проверено без грешки");
  await expect(page.getByTestId("import-summary")).toContainText("нови основни продукта: 1");
  await expect(page.getByTestId("import-summary")).toContainText("без промяна: 1");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Приложи промените" }).click();
  await expect(page.getByTestId("import-status")).toHaveText("Приложено.");
  await page.goto("/products");
  await expect(page.getByRole("cell", { name: "SYN-NEW-1" })).toBeVisible();

  // Orders: line chip + company chip, and the marker for another company's warehouse of the line.
  await page.goto("/orders?tab=all");
  const row = page.getByRole("row").filter({ hasText: "#L-8001" });
  await expect(row).toContainText("Козметика А");
  await expect(row).toContainText("euShipments Козметика Б");
  await expect(row.getByTestId("other-company-warehouse")).toHaveText("↔ склад на друга фирма");

  // Another line hides this line's orders.
  await page.waitForLoadState("networkidle");
  await page
    .getByRole("navigation", { name: "Основна навигация" })
    .getByLabel("Линия", { exact: true })
    .selectOption({ label: "Текстил" });
  await expect(page.getByTestId("line-band")).toContainText("Текстил");
  await expect(page.getByRole("row").filter({ hasText: "#L-8001" })).toHaveCount(0);
});
