import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// Synthetic data only (tests/e2e/seed-reports.ts): group "Тест група Справки" with an FHB and an euShipments
// warehouse, orders in EUR and HUF over the last 10 days, shipments, COD mirror rows, checks, a review and stock.
const REPORTS_OWNER = {
  email: process.env.E2E_REPORTS_EMAIL ?? "",
  password: process.env.E2E_REPORTS_PASSWORD ?? "",
  totp: process.env.E2E_REPORTS_TOTP ?? "",
};

test("reports: landing, six reports with period, scope and CSV export", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await login(page, REPORTS_OWNER);

  // Landing page with six cards (sidebar link).
  await page.getByRole("link", { name: "Справки" }).first().click();
  await expect(page.getByRole("heading", { name: "Справки", level: 1 })).toBeVisible();
  for (const k of ["orders", "shipments", "timing", "cod", "review", "stock"])
    await expect(page.getByTestId(`report-card-${k}`)).toBeVisible();
  await page.screenshot({ path: "docs/screens/p10-reports.png", fullPage: true });

  // 1. Orders: counts, currencies never mixed, COD share, store / company.
  await page.getByTestId("report-card-orders").click();
  await expect(page.getByRole("heading", { name: "Поръчки по ден, магазин и фирма" })).toBeVisible();
  await expect(page.getByTestId("preset-30d")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("kpi-orders")).toContainText("8");
  await expect(page.getByTestId("kpi-cod")).toContainText("4 · 50");
  await expect(page.getByTestId("kpi-cancelled")).toContainText("1");
  await expect(page.getByTestId("orders-total-EUR")).toContainText("175");
  await expect(page.getByTestId("orders-total-HUF")).toContainText("9000");
  await expect(page.getByTestId("day-bars")).toBeVisible();
  await expect(page.getByTestId("orders-store-Магазин Справки-EUR")).toBeVisible();
  await expect(page.getByTestId("orders-company-Фирма Справки Б-HUF")).toBeVisible();
  await expect(page.getByTestId("report-note")).toContainText("Различни валути не се събират");
  await page.screenshot({ path: "docs/screens/p10-reports-orders.png", fullPage: true });
  const csv = await page.request.get(`${baseURL}/api/reports/orders/export?preset=30d`);
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  const body = await csv.text();
  expect(body).toContain("total;;EUR;7;4;57.1;;175.00");
  expect(body).toContain("total;;HUF;1;0;0.0;;9000.00");

  // Period: 7 days keeps the last week only; a manual range works too.
  await page.getByTestId("preset-7d").click();
  await expect(page.getByTestId("preset-7d")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("kpi-orders")).toContainText("4");

  // 2. Shipments by warehouse and carrier.
  await page.goto("/reports/shipments");
  await expect(page.getByTestId("kpi-sent")).toContainText("5");
  await expect(page.getByTestId("kpi-delivery-rate")).toContainText("60");
  await expect(page.getByTestId("ship-FHB Справки")).toContainText("50");
  await expect(page.getByTestId("ship-FHB Справки-gls")).toContainText("GLS");
  await expect(page.getByTestId("ship-euShipments Справки-none")).toContainText("не е записан");
  await expect(page.getByTestId("report-note")).toContainText("Анулираните преди изпращане");
  await page.screenshot({ path: "docs/screens/p10-reports-shipments.png", fullPage: true });

  // Header warehouse scope: euShipments only.
  await context.addCookies([{ name: "crm_scope", value: "eu", url: baseURL! }]);
  await page.reload();
  await expect(page.getByTestId("kpi-sent")).toContainText("1");
  await expect(page.getByTestId("ship-FHB Справки")).toHaveCount(0);
  await context.addCookies([{ name: "crm_scope", value: "all", url: baseURL! }]);

  // 3. Processing time.
  await page.goto("/reports/timing");
  await expect(page.getByTestId("timing-approve")).toContainText("ч");
  await expect(page.getByTestId("timing-row-all")).toBeVisible();
  await expect(page.getByTestId("timing-row-FHB Справки")).toBeVisible();
  await page.screenshot({ path: "docs/screens/p10-reports-timing.png", fullPage: true });

  // 4. COD: expected / paid / outstanding and ageing per currency and warehouse.
  await page.goto("/reports/cod");
  await expect(page.getByTestId("codr-total-EUR")).toContainText("100");
  await expect(page.getByTestId("codr-total-EUR")).toContainText("20");
  await expect(page.getByTestId("codr-total-EUR")).toContainText("30");
  await expect(page.getByTestId("codr-wh-FHB Справки-EUR")).toBeVisible();
  await expect(page.getByTestId("codr-age-EUR")).toContainText("30");

  // 5. Review and automation.
  await page.goto("/reports/review");
  await expect(page.getByTestId("finding-phone_invalid")).toContainText("2");
  await expect(page.getByTestId("decision-HOLD")).toContainText("1");
  await expect(page.getByTestId("kpi-ON_HOLD")).toContainText("1");
  await expect(page.getByTestId("kpi-BLOCKED")).toContainText("1");
  await expect(page.getByTestId("ai-none")).toBeVisible();

  // 6. Stock (snapshot).
  await page.goto("/reports/stock");
  await expect(page.getByTestId("runout-SP-SERUM")).toBeVisible();
  await expect(page.getByTestId("zeroopen-SP-CREAM")).toContainText("2");
  await page.screenshot({ path: "docs/screens/p10-reports-stock.png", fullPage: true });
  const stockCsv = await (await page.request.get(`${baseURL}/api/reports/stock/export`)).text();
  expect(stockCsv).toContain("zero_with_open_orders;SP-CREAM;Крем Справки;0;0");

  // Company filter (sidebar): only company B.
  await page.goto("/reports/orders?preset=30d");
  await page.getByRole("combobox", { name: "Фирма" }).selectOption({ label: "Фирма Справки Б" });
  await expect(page.getByTestId("kpi-orders")).toContainText("2");
  await expect(page.getByTestId("orders-total-EUR")).toContainText("12");
});
