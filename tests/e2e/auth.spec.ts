import { expect, test } from "@playwright/test";
import { login, OWNER } from "./helpers";

test("unauthenticated users are sent to the login page", async ({ page }) => {
  await page.goto("/orders");
  await expect(page).toHaveURL(/\/login/);
});

test("a wrong 2FA code is rejected with a generic message", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Имейл").fill(OWNER.email);
  await page.getByLabel("Парола", { exact: true }).fill(OWNER.password);
  await page.getByLabel(/^Код от приложението/).fill("000000");
  await page.getByRole("button", { name: "Вход" }).click();
  await expect(page.locator('form [role="alert"]')).toHaveText("Грешен имейл, парола или код.");
  await expect(page).toHaveURL(/\/login/);
});

test("login with password + TOTP, then log out", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Начало");
  await page.getByRole("button", { name: "Профил и език" }).click();
  await page.getByRole("menuitem", { name: "Изход" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
});
