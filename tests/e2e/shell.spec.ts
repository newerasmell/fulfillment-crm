import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const PAGES: [string, string][] = [
  ["/", "Начало"],
  ["/orders", "Поръчки"],
  ["/shipments", "Товарителници"],
  ["/returns", "Връщания"],
  ["/tickets", "Тикети от склада"],
  ["/products", "Продукти и наличности"],
  ["/inbound", "Приемане на стока"],
  ["/manual-shipments", "Ръчни пратки и етикети"],
  ["/cod", "Наложен платеж"],
  ["/invoices", "Фактури"],
  ["/reports", "Справки"],
  ["/warehouses", "Складове и връзки"],
  ["/stores", "Магазини"],
  ["/routing", "Правила за маршрут"],
  ["/ai", "AI асистент"],
  ["/directory", "Офиси, PUDO, потребители"],
  ["/settings/members", "Фирми и потребители"],
  ["/settings/credentials", "Ключове за достъп"],
  ["/settings/audit", "Одит лог"],
  ["/settings/jobs", "Системни задачи"],
];

test("every menu entry opens its page; key screens are captured", async ({ page }) => {
  await login(page);
  const nav = page.getByRole("navigation", { name: "Основна навигация" });
  for (const [href, title] of PAGES) {
    await page.goto(href);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(nav.getByRole("link", { name: title, exact: true })).toHaveAttribute("aria-current", "page");
  }
  for (const [href, name] of [
    ["/", "home"],
    ["/orders", "orders-empty"],
    ["/settings/members", "members"],
    ["/settings/audit", "audit"],
  ] as const) {
    await page.goto(href);
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: `docs/screens/p0-${name}.png`, fullPage: true });
  }
});

test("header: warehouse scope, create menu, Ctrl K search, language switch", async ({ page }) => {
  await login(page);
  const scope = page.getByRole("group", { name: "Склад" });
  const saved = page.waitForResponse((r) => r.request().method() === "POST"); // server action sets the cookie
  await scope.getByRole("button", { name: "FHB" }).click();
  await expect(scope.getByRole("button", { name: "FHB" })).toHaveAttribute("aria-pressed", "true");
  await saved;
  await page.reload();
  await expect(
    page.getByRole("group", { name: "Склад" }).getByRole("button", { name: "FHB" }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Създай" }).click();
  await expect(page.getByRole("menuitem", { name: /Ръчна пратка/ })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Търсене" })).toBeVisible();
  await page.getByRole("button", { name: "Затвори" }).click();

  await page.getByRole("button", { name: "Профил и език" }).click();
  await page.getByRole("menuitemradio", { name: "English" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Home");
  await page.getByRole("button", { name: "Profile and language" }).click();
  await page.getByRole("menuitemradio", { name: "Български" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Начало");
});
