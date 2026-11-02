import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// Synthetic e2e data only (tools/e2e.ts): store DM, "FHB Демо", "euShipments Демо", Shopify order #1001 (BG).
test("routing rules: create, reorder, explain an order, delete — every change audited", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  await page.goto("/routing");
  await page.waitForLoadState("networkidle"); // forms work only after hydration
  await expect(page.getByRole("heading", { name: "Правила за маршрут", level: 1 })).toBeVisible();

  const add = page.getByRole("form", { name: "Добави правило" });
  const create = async (name: string, connection: RegExp, countries: string) => {
    await add.getByLabel("Име").fill(name);
    const select = add.getByLabel("Склад (връзка)");
    const value = await select.locator("option", { hasText: connection }).first().getAttribute("value");
    await select.selectOption(value!);
    await add.getByLabel("Държави").fill(countries);
    await add.getByRole("button", { name: "Създай правило" }).click();
    await expect(page.getByRole("cell", { name, exact: true })).toBeVisible({ timeout: 30_000 });
  };
  await create("BG към FHB", /FHB Демо/, "bg");
  await create("Всичко друго", /euShipments Демо/, "");

  const table = page.getByRole("table", { name: "Правила" });
  await expect(table.getByRole("row").nth(1)).toContainText("BG към FHB");
  await expect(table.getByRole("row").nth(1)).toContainText("BG");
  await expect(table.getByRole("row").nth(2)).toContainText("всички поръчки");

  // Try an order before and after moving the catch-all rule to the top.
  await page.getByLabel("Номер на поръчка").fill("1001");
  await page.getByRole("button", { name: "Покажи" }).click();
  await expect(page.getByTestId("routing-explanation")).toContainText("Правило 1: BG → FHB Демо");

  await page.getByRole("button", { name: "Премести „Всичко друго“ нагоре" }).click();
  await expect(table.getByRole("row").nth(1)).toContainText("Всичко друго");
  await page.goto("/routing?order=1001");
  await expect(page.getByTestId("routing-explanation")).toContainText(
    "Правило 1: всички поръчки → euShipments Демо",
  );

  // Delete needs a second click.
  await page.waitForLoadState("networkidle");
  const firstRow = page.getByRole("table", { name: "Правила" }).getByRole("row").nth(1);
  await firstRow.getByRole("button", { name: "Изтрий" }).click();
  await page.getByRole("button", { name: "Да, изтрий" }).click();
  await expect(page.getByRole("cell", { name: "Всичко друго", exact: true })).toHaveCount(0, {
    timeout: 30_000,
  });

  await page.goto("/settings/audit");
  await expect(page.getByRole("cell", { name: "routing.rule_created" }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "routing.rule_moved" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "routing.rule_deleted" })).toBeVisible();
});
