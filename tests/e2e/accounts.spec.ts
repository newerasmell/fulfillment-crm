import { expect, test } from "@playwright/test";
import { freshCode, login } from "./helpers";

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

test("invitation: the admin gets a link, the new person chooses their own password and 2FA, then signs in", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000); // two logins + enrolment each need a fresh 30-second TOTP step
  await login(page);
  await page.goto("/settings/members");
  const email = `op-${Date.now()}@example.com`;
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Създай покана" }) });
  await form.getByLabel("Име", { exact: true }).fill("Оператор Тест");
  await form.getByLabel("Имейл").fill(email);
  await form.getByLabel("Роля").selectOption("OPERATOR");
  await form.getByRole("button", { name: "Създай покана" }).click();
  const link = (await page.getByTestId("invite-link").textContent())!.trim();
  expect(link).toMatch(/\/invite\/[A-Za-z0-9_-]{40,}$/);
  await expect(page.getByText(/Временна парола|otpauth/)).toHaveCount(0); // the admin never sees credentials
  await page.reload();
  await expect(page.getByTestId("invite-link")).toHaveCount(0); // shown once
  await expect(page.getByText(email)).toBeVisible(); // listed as pending

  const ctx = await browser.newContext();
  const invitee = await ctx.newPage();
  await invitee.goto(link);
  await expect(invitee.getByRole("heading", { level: 1 })).toHaveText("Покана за Тест фирма А");
  const secret = (await invitee.getByTestId("totp-secret").textContent())!.trim();
  const password = "invitee-own-password-123";
  await invitee.getByLabel("Име").fill("Оператор Тест");
  await invitee.getByLabel("Парола (поне 12 знака)").fill(password);
  await invitee.getByLabel("Повтори паролата").fill(password);
  await invitee.getByLabel(/Код от приложението/).fill(await freshCode(secret));
  await invitee.getByRole("button", { name: "Създай профила" }).click();
  await expect(invitee).toHaveURL(/\/login\?joined=1/);
  await login(invitee, { email, password, totp: secret });
  await expect(invitee.getByText(/· Тест фирма А$/)).toBeVisible();
  await expect(invitee.getByRole("link", { name: "Ключове за достъп" })).toHaveCount(0); // operator: no admin menu
  await invitee.goto(link);
  await expect(
    invitee.getByText("Поканата е невалидна, изтекла или вече използвана. Помоли за нова."),
  ).toBeVisible();
  await ctx.close();
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
