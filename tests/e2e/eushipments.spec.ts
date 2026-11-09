import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// Data comes from tools/e2e-eushipments.ts: the real read side and one DRY_RUN send ran against a MOCKED
// euShipments (synthetic, reference-shaped fixtures). Nothing here calls the vendor.
const TOKEN = "e2e-eu-token-not-real-0001";

test("euShipments: connection, mode, mirror tabs and the DRY_RUN preview", async ({ page }) => {
  test.setTimeout(300_000);
  await login(page);
  await page.goto("/warehouses");
  await page.getByRole("link", { name: /euShipments: връзки и огледало/ }).click();
  await expect(page).toHaveURL(/\/warehouses\/eushipments$/);
  const row = page.getByRole("row", { name: /euShipments Демо/ });
  await expect(row).toContainText("Само четене");
  await expect(row).toContainText("Работи");
  await expect(row).toContainText("333");
  await row.getByRole("link", { name: "euShipments Демо" }).click();

  // header + freshness; the token is never rendered back
  await expect(page.getByRole("heading", { name: "euShipments Демо" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(TOKEN);
  await expect(page.getByRole("cell", { name: "Продукти", exact: true })).toBeVisible();

  // products: auto-matched by SKU (prefix stripped), the other waits for a link; tabs show original names
  const tabs = page.getByRole("navigation", { name: "Огледало на euShipments" });
  await expect(tabs.getByRole("link", { name: /Продукти\s*Фулфилмънт → Продукти/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("row", { name: /ref-test-54202/ })).toContainText("TEST-54202");
  await page.getByRole("link", { name: /Несвързани \(1\)/ }).click();
  await expect(page.getByRole("row", { name: /ref-test-54202/ })).toHaveCount(0);
  await expect(page.getByRole("row", { name: /ref-test-54201/ })).toBeVisible();
  await page.getByRole("textbox", { name: "Наш SKU за ref-test-54201" }).fill("DEMO-54201");
  await page.getByRole("button", { name: "Свържи" }).click();
  // the row leaves the "unlinked" list once linked
  await expect(page.getByRole("link", { name: /Несвързани \(0\)/ })).toBeVisible();
  await page.getByRole("link", { name: /Всички \(2\)/ }).click();
  await expect(page.getByRole("row", { name: /ref-test-54201/ })).toContainText("DEMO-54201");

  // stock per warehouse with the snapshot age
  await tabs.getByRole("link", { name: /Наличности/ }).click();
  const stock = page.getByRole("row", { name: /ref-test-54202/ });
  await expect(stock).toContainText("Warehouse Ruse");
  await expect(stock).toContainText("87");
  await expect(page.getByText("Снимка на наличностите")).toBeVisible();

  // shipments polled from orders-history (Bulgarian status next to the vendor's text)
  await tabs.getByRole("link", { name: /Товарителници/ }).click();
  const ship = page.getByRole("row", { name: /M-E2E-2001/ });
  await expect(ship).toContainText("In transit");
  await expect(ship).toContainText("E2E-AWB-0001");

  // couriers, office search, countries
  await tabs.getByRole("link", { name: /Куриери и офиси/ }).click();
  await expect(page.getByRole("cell", { name: "Hungary GLS New" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Куриер по подразбиране по държава" })).toBeVisible();
  await page
    .getByRole("searchbox")
    .or(page.getByRole("textbox", { name: "Търсене" }))
    .fill("Sample");
  await page.getByRole("button", { name: "Търси" }).click();
  await expect(page.getByRole("cell", { name: "Sample Locker Two" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Автомат", exact: true })).toBeVisible();

  await tabs.getByRole("link", { name: /Складове/ }).click();
  await expect(page.getByRole("cell", { name: "Warehouse Ruse" })).toBeVisible();

  // DRY_RUN preview: exact body, sent with testMode: true and validated by euShipments
  await tabs.getByRole("link", { name: /Пробни изпращания/ }).click();
  const dry = page.getByRole("article").filter({ hasText: "order:M-E2E-3001" });
  await expect(dry).toContainText("testMode: true");
  await expect(dry).toContainText("Проверено от euShipments");
  await dry.getByText("Тяло на заявката").click();
  await expect(dry).toContainText('"referenceNumber": "M-E2E-3001"');

  // mode stepper: the OWNER raises to Проба and lowers back; every change is audited server-side
  const stepper = page.getByRole("list", { name: "Режим" });
  await stepper.getByRole("button", { name: "Проба" }).click();
  await expect(stepper.locator('[aria-current="step"]')).toHaveText("Проба");
  await stepper.getByRole("button", { name: "Само четене" }).click();
  await expect(stepper.locator('[aria-current="step"]')).toHaveText("Само четене");

  // "Създаване в склада": from the menu, the warehouse's missing masters with what each still lacks; READ_ONLY says so.
  await page.getByRole("link", { name: "Създаване в склада" }).click();
  await expect(page.getByRole("heading", { name: "Създаване в склада" })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Складове" })
    .getByRole("link", { name: /euShipments Демо/ })
    .click();
  await expect(page.getByTestId("to-warehouse-mode")).toContainText("Само четене");
  await page.screenshot({ path: "test-results/to-warehouse.png", fullPage: true });
});

test("euShipments: create a connection — token to the vault, READ_ONLY, never shown again", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await login(page);
  await page.goto("/warehouses/eushipments");
  await page.waitForLoadState("networkidle");
  const form = page.getByRole("form", { name: "Добави връзка с euShipments" });
  await form.getByLabel("Име").fill("euShipments Втора");
  await form.getByLabel("API ключ (Bearer token)").fill("e2e-eu-token-not-real-0002");
  await form.getByLabel("Фирма в euShipments (companyId)").fill("334");
  await form.getByRole("button", { name: "Добави връзка с euShipments" }).click();
  await expect(page.getByRole("heading", { name: "euShipments Втора" })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("body")).not.toContainText("e2e-eu-token-not-real-0002");
  await expect(page.getByRole("list", { name: "Режим" }).locator('[aria-current="step"]')).toHaveText(
    "Само четене",
  );
  // the same euShipments company cannot get a second connection
  await page.goto("/warehouses/eushipments");
  await page.waitForLoadState("networkidle");
  await form.getByLabel("Име").fill("dup");
  await form.getByLabel("API ключ (Bearer token)").fill("e2e-eu-token-not-real-0003");
  await form.getByLabel("Фирма в euShipments (companyId)").fill("334");
  await form.getByRole("button", { name: "Добави връзка с euShipments" }).click();
  await expect(page.getByText("Вече има връзка за тази фирма в euShipments.")).toBeVisible();
});
