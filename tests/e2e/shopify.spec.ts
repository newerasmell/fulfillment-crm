import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// Data comes from the synthetic fixtures seeded by tools/e2e.ts (no Shopify calls).

test("orders: tabs with counts, filters and a read-only detail", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  await expect(page.getByRole("link", { name: /За преглед/ }).first()).toContainText("3");
  await page.goto("/orders");
  const tabs = page.getByRole("navigation", { name: "Изгледи" });
  await expect(tabs.getByRole("link", { name: /За преглед/ })).toContainText("3");
  await expect(page.getByRole("row")).toHaveCount(4);
  await expect(page.getByText("тест", { exact: true })).toBeVisible();

  await page.getByRole("textbox", { name: "Държава" }).fill("RO");
  await page.getByRole("button", { name: "Филтрирай" }).click();
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("cell", { name: "Test Buyer 2" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Платена" })).toBeVisible();

  await page.getByRole("link", { name: "#1002" }).click();
  await expect(page.getByRole("heading", { name: "Поръчка #1002" })).toBeVisible();
  await expect(page.getByText("2 Exemplu Street")).toBeVisible();
  await expect(page.getByRole("link", { name: "Несвързан" })).toBeVisible();
});

test("stores and the matching queue: create the master product from a variant", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  await page.goto("/stores");
  await page.getByRole("link", { name: "Демо магазин" }).click();
  await expect(page.getByText("e2e-demo.myshopify.com")).toBeVisible();
  await expect(page.getByText("Не е тествано").first()).toBeVisible();
  await expect(page.getByText("Записани (криптирани)")).toBeVisible();
  // The secret is never rendered back.
  await expect(page.locator("body")).not.toContainText("e2e-client-secret-not-real");

  await page.goto("/products");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "Несвързани варианти (1)" })).toBeVisible();
  await page.getByRole("button", { name: "Създай SAMPLE-EDP-50" }).click();
  await expect(page.getByRole("heading", { name: "Несвързани варианти (0)" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "SAMPLE-EDP-50", exact: true })).toBeVisible();

  await page.goto("/orders?tab=all");
  await page.getByRole("link", { name: "#1001" }).click();
  await expect(page.getByRole("cell", { name: "SAMPLE-EDP-50", exact: true })).toBeVisible();
});
