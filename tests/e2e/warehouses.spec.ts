import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("emergency stop needs a second click, pauses the queue and can be resumed", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  await page.goto("/warehouses");
  await page.waitForLoadState("networkidle"); // buttons work only after hydration
  await page.getByRole("button", { name: "Спри всичко" }).click();
  await page.getByRole("button", { name: "Отказ" }).click(); // first click only asks
  await expect(page.getByRole("button", { name: "Спри всичко" })).toBeVisible();
  await page.getByRole("button", { name: "Спри всичко" }).click();
  await page.getByRole("button", { name: "Да, потвърждавам" }).click();
  await expect(page.getByRole("status")).toHaveText("Изходящата опашка е спряна. Нищо не се изпраща.");
  await page.getByRole("button", { name: "Продължи опашката" }).click();
  await page.getByRole("button", { name: "Да, потвърждавам" }).click();
  await expect(page.getByRole("button", { name: "Спри всичко" })).toBeVisible();
  await page.goto("/settings/audit");
  await expect(page.getByRole("cell", { name: "outbox.kill_switch" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "outbox.resume" })).toBeVisible();
});
