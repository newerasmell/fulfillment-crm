import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// Synthetic data only (tests/e2e/seed-stores-edit.ts): group "Тест група Магазини" with three never-connected
// stores. No Shopify call: archive/restore/delete only queue worker jobs (no worker runs in e2e).
const STORES_OWNER = {
  email: process.env.E2E_STORES_EMAIL ?? "",
  password: process.env.E2E_STORES_PASSWORD ?? "",
  totp: process.env.E2E_STORES_TOTP ?? "",
};

test("stores: edit details, warehouse prefix, locked domain, archive + restore, delete an empty store", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await login(page, STORES_OWNER);

  // 1. Edit name, countries and the warehouse prefix of a store with orders; only its domain is locked (the code is
  // internal and no longer part of warehouse order ids).
  await page.goto("/stores");
  // Adding a store: the Dev Dashboard "Create version" screen field by field, with the values to copy.
  const guide = page.getByTestId("shopify-setup-guide").first();
  await expect(guide).toContainText("API access → Scopes");
  await expect(guide.getByTestId("copy-value-Scopes")).toContainText("read_orders,read_customers");
  await expect(guide.getByTestId("copy-value-Webhooks API version")).toHaveText("2026-10");
  await page.screenshot({ path: "test-results/shopify-setup-guide.png", fullPage: true });
  await page.getByRole("link", { name: "Магазин с поръчки" }).click();
  await page.waitForLoadState("networkidle");
  const details = page.getByRole("form", { name: "Данни на магазина" });
  await expect(details.locator('input[name="code"]')).not.toHaveAttribute("readonly", "");
  await expect(details.locator('input[name="domain"]')).toHaveAttribute("readonly", "");
  await expect(details.getByText(/Домейнът е заключен/)).toBeVisible();
  await expect(details.getByText(/Празно = номерът от Shopify/)).toBeVisible();
  await details.locator('input[name="vendorIdPrefix"]').fill("ab");
  await expect(details.getByText(/важи само за новите поръчки/)).toBeVisible();
  await details.locator('input[name="name"]').fill("Магазин с поръчки 2");
  await details.locator('input[name="countries"]').fill("BG, GR");
  await details.getByRole("button", { name: "Запази" }).click();
  await expect(details.getByRole("status")).toHaveText("Запазено.");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Магазин с поръчки 2" })).toBeVisible();
  await expect(page.locator('form[aria-label="Данни на магазина"] input[name="countries"]')).toHaveValue(
    "BG, GR",
  );
  await expect(page.locator('form[aria-label="Данни на магазина"] input[name="vendorIdPrefix"]')).toHaveValue(
    "AB",
  );
  // Delete is not offered: it explains why and points to archive.
  await expect(page.getByRole("note")).toContainText("има поръчки");
  await expect(page.getByRole("note")).toContainText("Архивирайте го вместо това");
  await page.screenshot({ path: "docs/screens/stores-edit.png", fullPage: true });

  // 2. Archive a store with an order not yet sent: the count is shown first, then it moves to "Архивирани".
  await page.goto("/stores");
  await page.getByRole("link", { name: "Магазин за архив" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Архивирай магазина" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "1 поръчка още не е изпратена" })).toBeVisible();
  await page.getByRole("button", { name: "Разбирам — архивирай" }).click();
  await expect(page.getByText(/Архивиран на/)).toBeVisible();
  await expect(page.getByRole("form", { name: "Данни на магазина" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Синхронизирай поръчки" })).toHaveCount(0);
  await page.goto("/stores");
  await expect(page.getByRole("table").getByRole("link", { name: "Магазин за архив" })).toHaveCount(0);
  await page.getByText("Архивирани (1)").click();
  await expect(page.getByRole("link", { name: "Магазин за архив" })).toBeVisible();
  // Its orders stay searchable (history).
  await page.goto("/orders?tab=all");
  await expect(page.getByRole("link", { name: "#MA-1" })).toBeVisible();
  await expect(page.getByRole("option", { name: /Магазин за архив \(архивиран\)/ })).toHaveCount(1);

  // 3. Restore it.
  await page.goto("/stores");
  await page.getByText("Архивирани (1)").click();
  await page.getByRole("link", { name: "Магазин за архив" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Възстанови" }).click();
  await expect(page.getByRole("form", { name: "Данни на магазина" })).toBeVisible();
  await expect(page.getByText(/Архивиран на/)).toHaveCount(0);
  await page.goto("/stores");
  await expect(page.getByText(/Архивирани \(/)).toHaveCount(0);

  // 4. Delete the empty store: only after typing its code.
  await page.getByRole("link", { name: "Празен магазин" }).click();
  await page.waitForLoadState("networkidle");
  const del = page.getByRole("form", { name: "Изтрий магазина" });
  const button = del.getByRole("button", { name: "Изтрий магазина" });
  await expect(button).toBeDisabled();
  await del.getByRole("textbox").fill("XX");
  await expect(button).toBeDisabled();
  await del.getByRole("textbox").fill("pm");
  await button.click();
  await expect(page).toHaveURL(/\/stores\?deleted=1/);
  await expect(page.getByRole("status").filter({ hasText: "Магазинът е изтрит." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Празен магазин" })).toHaveCount(0);
});
