import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// Synthetic data only (tests/e2e/seed-stock.ts): group "Тест група Склад" with an FHB and an euShipments warehouse
// (both DRY_RUN), four master products and store "Магазин С" with push DRY_RUN. Nothing reaches a vendor or Shopify:
// the web app only writes CRM rows and queues jobs (no worker runs during e2e).
const STOCK_OWNER = {
  email: process.env.E2E_STOCK_EMAIL ?? "",
  password: process.env.E2E_STOCK_PASSWORD ?? "",
  totp: process.env.E2E_STOCK_TOTP ?? "",
};

test("stock board, inbound from picker + upload, Shopify inventory preview and dry-run push", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await login(page, STOCK_OWNER);

  // Продукти и наличности: per master, columns per warehouse and store, quick filters with counts.
  await page.goto("/products/stock");
  await expect(page.getByRole("heading", { name: "Продукти и наличности", level: 1 })).toBeVisible();
  const table = page.getByRole("table", { name: "Наличности по продукт" });
  await expect(table.getByRole("columnheader", { name: /FHB Склад С/ })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: /euShipments Склад С/ })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Shopify · SC" })).toBeVisible();
  // Testers under the original.
  const skus = await table
    .locator("tbody tr")
    .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-testid")?.replace("stock-row-", "")));
  expect(skus).toEqual(["STK-FAST", "STK-ORIG", "STK-TEST", "STK-ZERO"]);
  const orig = page.getByTestId("stock-row-STK-ORIG");
  await expect(orig).toContainText("10"); // FHB sellable = min(free 10, physical 12)
  await expect(orig).toContainText("разминаване"); // Shopify 50 vs 15 sellable
  await expect(page.getByTestId("stock-row-STK-TEST")).toContainText("TESTER");

  const filters = page.getByRole("list", { name: "Бързи филтри" });
  await filters.getByRole("link", { name: /Тестери/ }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByTestId("stock-row-STK-TEST")).toBeVisible();
  await filters.getByRole("link", { name: /Разминаване със Shopify/ }).click();
  await expect(page.getByTestId("stock-row-STK-ORIG")).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await filters.getByRole("link", { name: /Свършват до 7 дни/ }).click();
  await expect(page.getByTestId("stock-row-STK-FAST")).toBeVisible();
  await expect(page.getByTestId("stock-row-STK-FAST")).toContainText("Свършва до");
  await filters.getByRole("link", { name: /Нулева/ }).click();
  await expect(page.getByTestId("stock-row-STK-ZERO")).toBeVisible();

  // Search by a warehouse code, open the right panel.
  await page.goto("/products/stock?q=RSK-STK-ORIG");
  await page.getByRole("link", { name: "Синтетичен парфюм 50 мл", exact: true }).click();
  const panel = page.getByTestId("stock-panel");
  await expect(panel).toContainText("RSK-STK-ORIG");
  await expect(panel).toContainText("EU-STK-ORIG");
  await expect(panel).toContainText("0000000000031");
  await expect(panel).toContainText("Склад FHB");
  await expect(panel).toContainText("+12");

  // Tabs: movements and notifications (with the threshold settings).
  const views = page.getByRole("navigation", { name: "Изгледи на наличностите" });
  await views.getByRole("link", { name: /Движения/ }).click();
  await expect(page.getByRole("cell", { name: "IN-E2E-0001" })).toBeVisible();
  await views.getByRole("link", { name: /Известия/ }).click();
  const settings = page.getByRole("form", { name: "Прагове" });
  await settings.getByLabel("Допустимо разминаване със Shopify (бр.)").fill("3");
  await settings.getByRole("button", { name: "Запази" }).click();
  await expect(settings.getByRole("status")).toHaveText("Запазено");

  // Приемане на стока → FHB receipt from the picker and an uploaded CSV.
  await page.goto("/inbound");
  await expect(page.getByRole("heading", { name: "Приемане на стока", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "+ Нова доставка" }).click();
  await page.waitForLoadState("networkidle");
  const form = page.getByRole("form", { name: "Нова доставка" });
  await form
    .getByRole("combobox", { name: "Склад", exact: true })
    .selectOption({ label: "FHB Склад С · FHB · DRY_RUN" });
  await form.getByLabel("Име на доставката").fill("Доставка e2e");
  await form.getByLabel("Добави продукт").fill("STK-ORIG");
  await form.getByRole("list", { name: "Намерени продукти" }).getByRole("button", { name: "Добави" }).click();
  await form.getByLabel("Количество за STK-ORIG").fill("5");
  await form.getByLabel("Файл с редове").setInputFiles({
    name: "lines.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("SKU;Количество\nRSK-STK-ZERO;3\nNOPE-1;1\n"),
  });
  await form.getByRole("button", { name: "Зареди редовете" }).click();
  await expect(form.getByRole("status")).toContainText("Добавени редове: 1 · с проблем: 1");
  await expect(form).toContainText("няма такъв продукт в линията");
  await expect(form.getByLabel("Количество за STK-ZERO")).toHaveValue("3");
  await form.getByRole("button", { name: "Създай приемане в FHB" }).click();
  await expect(page).toHaveURL(/\/inbound\/[a-z0-9]+$/);
  await expect(page.getByTestId("inbound-status")).toContainText("Чака изпращане");
  await expect(page.getByTestId("inbound-line-STK-ORIG")).toContainText("5");
  await expect(page.getByTestId("inbound-line-STK-ZERO")).toContainText("3");
  await expect(page.getByText("fhb.stockReceipt.create")).toBeVisible();

  // euShipments booking: the warehouse is required; the same form submitted twice is one booking.
  await page.goto("/inbound/new");
  await page.waitForLoadState("networkidle");
  await form
    .getByRole("combobox", { name: "Склад", exact: true })
    .selectOption({ label: "euShipments Склад С · euShipments · DRY_RUN" });
  await form.getByLabel("Име на доставката").fill("Booking e2e");
  await form.getByRole("combobox", { name: "Склад на euShipments" }).selectOption({ label: "Склад София" });
  await form.getByLabel("Добави продукт").fill("STK-ORIG");
  await form.getByRole("list", { name: "Намерени продукти" }).getByRole("button", { name: "Добави" }).click();
  await form.getByRole("button", { name: "Създай заявка за приемане" }).click();
  await expect(page).toHaveURL(/\/inbound\/[a-z0-9]+$/);
  await expect(page.getByText("eushipments.createRequest")).toBeVisible();
  await page.goto("/inbound?tab=all");
  await expect(page.locator("tbody tr")).toHaveCount(2);

  // Магазин → Наличности към Shopify: location mapping, preview (sellable − buffer), dry-run push queued.
  await page.goto("/stores");
  await page.getByRole("link", { name: "Магазин С" }).first().click();
  await page.getByRole("link", { name: "Наличности към Shopify" }).click();
  await expect(page.getByTestId("push-mode")).toContainText("Пробно");
  const preview = page.getByRole("table", { name: "Преглед (пробно)" });
  // FHB sellable of STK-ORIG is 10, buffer 1 → 9 (Shopify has 50).
  await expect(preview.getByTestId("push-line-SC-STK-ORIG")).toContainText("9");
  await expect(preview.getByTestId("push-line-SC-STK-ORIG")).toContainText("-41");
  await page.getByRole("button", { name: /Пробно изпращане/ }).click();
  await expect(page.getByText("Изпращането е в опашката.")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("push-history-item").first()).toContainText("Чака");
});
