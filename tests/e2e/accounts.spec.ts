import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("an owner creates a second company and switches between the two", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  await page.getByLabel("Име на фирмата").fill("Тест фирма Б");
  await page.getByRole("button", { name: "Създай фирма" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Тест фирма Б" })).toBeVisible();

  const switcher = page.getByRole("combobox", { name: "Фирма" });
  await switcher.selectOption({ label: "Тест фирма Б" });
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("combobox", { name: "Фирма" }).locator("option:checked")).toHaveText(
    "Тест фирма Б",
  );
  await expect(page.getByText(/· Тест фирма Б$/)).toBeVisible();

  // Company B starts empty: its users list has only the owner, not A's members.
  await page.goto("/settings/members");
  await expect(page.getByRole("heading", { name: "Потребители в Тест фирма Б" })).toBeVisible();

  await page.getByRole("combobox", { name: "Фирма" }).selectOption({ label: "Тест фирма А" });
  await expect(page).toHaveURL("/");
  await expect(page.getByText(/· Тест фирма А$/)).toBeVisible();
});

test("adding a person shows the one-time sign-in details", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const form = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Добави", exact: true }) });
  await form.getByLabel("Име", { exact: true }).fill("Оператор Тест");
  await form.getByLabel("Имейл").fill(`op-${Date.now()}@example.com`);
  await form.getByLabel("Роля").selectOption("OPERATOR");
  await form.getByRole("button", { name: "Добави", exact: true }).click();
  const details = page.getByRole("status");
  await expect(details).toContainText("Временна парола");
  await expect(details).toContainText("otpauth://totp/");
  await page.reload();
  await expect(page.getByRole("status")).toHaveCount(0); // gone after reload: shown once
  await expect(page.getByRole("cell", { name: "Оператор Тест" })).toBeVisible();
});

test("credentials are write-only", async ({ page }) => {
  await login(page);
  await page.goto("/settings/credentials");
  const secret = "very-secret-value-1234";
  await page.getByLabel("Име").fill("Тестов ключ");
  await page.getByLabel("Ключ / парола").fill(secret);
  await page.getByRole("button", { name: "Запази ключа" }).click();
  await expect(page.getByText("Записано: ••••1234")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("cell", { name: /••••1234/ })).toBeVisible();
  expect(await page.content()).not.toContain(secret);
});
