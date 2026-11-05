import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

// Synthetic data only (tests/e2e/seed-review.ts): a separate group "Тест група Преглед" with orders #R-7001..4.
const REVIEWER = {
  email: process.env.E2E_REVIEW_EMAIL ?? "",
  password: process.env.E2E_REVIEW_PASSWORD ?? "",
  totp: process.env.E2E_REVIEW_TOTP ?? "",
};

async function openOrder(page: Page, number: string) {
  await page.goto("/orders?tab=all");
  await page.getByRole("link", { name: number, exact: true }).click();
  await expect(page.getByRole("heading", { name: `Поръчка ${number}`, level: 1 })).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForLoadState("networkidle"); // the editor and the decision bar work only after hydration
}

test("review: fix the address with live validation, approve, hold, block; review records and reason codes", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await login(page, REVIEWER);

  // #R-7001: a hard finding blocks approval until the address is corrected.
  await openOrder(page, "#R-7001");
  const findings = page.getByTestId("findings");
  await expect(findings).toContainText("Липсва пощенски код.");
  const bar = page.getByRole("region", { name: "Решение за поръчката" });
  await expect(bar.getByRole("button", { name: "Одобри" })).toBeDisabled();
  await expect(bar).toContainText("Не може да се одобри");
  await expect(page.getByTestId("review-routing")).toContainText("FHB Преглед");
  await expect(page.getByRole("table", { name: "Артикули" })).toContainText("6 за продажба");
  await expect(page.getByText("Сурови данни (само за администратори)")).toBeVisible();
  // What will be sent (DESIGN principle 4): with a hard finding the body cannot be built yet.
  // Folded sections (owner redesign 2026-11-05): "What will be sent" and the raw payloads open on click.
  await page.getByTestId("fold-payload").locator("summary").click();
  await expect(page.getByTestId("fold-payload")).toContainText("Какво ще се изпрати");
  await expect(page.getByTestId("payload-preview-blocked")).toContainText("FHB Преглед");
  // Raw payloads load only when a section is opened.
  await page.getByTestId("fold-raw").locator("summary").click();
  await page.getByText("Оригинален адрес", { exact: true }).click();
  await expect(page.locator("pre").filter({ hasText: '"countryCode"' }).first()).toBeVisible({
    timeout: 30_000,
  });

  await page.getByRole("button", { name: "Редактирай адреса" }).click();
  const form = page.getByRole("form", { name: "Редакция на адреса" });
  await expect(page.getByTestId("address-live")).toContainText("Липсва пощенски код.", { timeout: 30_000 });
  await form.getByLabel("Пощенски код").fill("1000");
  await expect(page.getByTestId("address-live")).toContainText("Адресът и телефонът минават проверките.", {
    timeout: 30_000,
  });
  await form.getByRole("button", { name: "Запази и провери" }).click();
  await expect(page.getByText("Запазено. Поръчката е проверена отново.")).toBeVisible({ timeout: 60_000 });
  const view = page.getByTestId("address-view");
  await expect(view).toContainText("1000");
  await expect(view.locator("del")).toHaveCount(1); // the Shopify original (no zip) shown crossed out
  await expect(view).toContainText("поправено");
  await expect(page.getByText("Липсва пощенски код.")).toHaveCount(0);
  await expect(bar).toContainText("1 поправки в този преглед");

  await bar.getByRole("button", { name: "Одобри" }).click();
  await bar.getByLabel("Причина").selectOption({ label: "Поправен адрес" });
  await bar.getByRole("button", { name: "Потвърди: Одобри" }).click();
  await expect(bar.getByText("Решението е записано.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Одобрена", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("timeline")).toContainText("Решение: Поправена и одобрена");
  await expect(page.getByRole("button", { name: "Редактирай адреса" })).toHaveCount(0);
  // Approved, not sent yet: the exact FHB body is shown (with the corrected zip, no callback URLs).
  const preview = page.getByTestId("payload-preview");
  await expect(preview).toContainText('"zip": "1000"');
  await expect(preview).not.toContainText("/api/webhooks/");

  // #R-7002: hold from the keyboard (H) with a reason.
  await openOrder(page, "#R-7002");
  await page.keyboard.press("h");
  const bar2 = page.getByRole("region", { name: "Решение за поръчката" });
  await bar2.getByLabel("Причина").selectOption({ label: "Чака връзка с клиента" });
  await bar2.getByLabel("Бележка").fill("звъннете след 17:00");
  await bar2.getByRole("button", { name: "Потвърди: Задръж" }).click();
  await expect(bar2.getByText("Решението е записано.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Задържана", { exact: true }).first()).toBeVisible();
  await expect(bar2.getByRole("button", { name: "Освободи" })).toBeVisible();

  // #R-7003: block needs a reason.
  await openOrder(page, "#R-7003");
  const bar3 = page.getByRole("region", { name: "Решение за поръчката" });
  await bar3.getByRole("button", { name: "Блокирай" }).click();
  await expect(bar3.getByRole("alert")).toContainText("необратимо");
  await bar3.getByLabel("Причина").selectOption({ label: "Съмнение за измама" });
  await bar3.getByLabel("Разбирам, че това не може да се отмени.").check();
  await bar3.getByRole("button", { name: "Потвърди: Блокирай" }).click();
  await expect(bar3.getByText("Решението е записано.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Отказана", { exact: true }).first()).toBeVisible();

  // Review records: decision, reason, field-level diff, time spent; filters.
  await page.goto("/orders/reviews");
  await expect(page.getByRole("heading", { name: "Прегледи", level: 1 })).toBeVisible();
  const table = page.getByRole("table", { name: "Прегледи" });
  await expect(table.getByRole("row")).toHaveCount(4);
  const r1 = table.getByRole("row").filter({ hasText: "#R-7001" });
  await expect(r1).toContainText("Поправена и одобрена");
  await expect(r1).toContainText("Поправен адрес");
  await expect(r1).toContainText("shippingAddress.zip");
  await expect(table.getByRole("row").filter({ hasText: "#R-7002" })).toContainText("звъннете след 17:00");
  await expect(table.getByRole("row").filter({ hasText: "#R-7003" })).toContainText("Съмнение за измама");
  await page.getByLabel("Решение").selectOption({ label: "Задържана" });
  await page.getByRole("button", { name: "Филтрирай" }).click();
  await expect(page).toHaveURL(/decision=HOLD/);
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table).toContainText("#R-7002");

  // Reason codes are configurable (OWNER/ADMIN).
  await page.waitForLoadState("networkidle");
  const add = page.getByRole("form", { name: "Добави или промени причина" });
  await add.getByLabel("Код").fill("courier_area");
  await add.getByLabel("Текст (BG)").fill("Извън зоната на куриера");
  await add.getByLabel("Текст (EN)").fill("Outside the courier area");
  await add.getByLabel("Задръж").check();
  await add.getByRole("button", { name: "Запази" }).click();
  const reasons = page.getByRole("table", { name: "Причини" });
  await expect(reasons.getByRole("cell", { name: "courier_area", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await reasons.getByRole("button", { name: "Изключи courier_area" }).click();
  await expect(reasons.getByRole("row").filter({ hasText: "courier_area" })).toContainText("изключена", {
    timeout: 30_000,
  });

  await page.goto("/settings/audit");
  await expect(page.getByRole("cell", { name: "order.address_edited" }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "review.reason_created" }).first()).toBeVisible();
});

test("a mystery line gets its product picked by hand for this order only, and the order is checked again", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await login(page, REVIEWER);
  await openOrder(page, "#R-7004");
  const findings = page.getByTestId("findings");
  await expect(findings).toContainText("Mystery Decant 15 ml");
  const items = page.getByRole("table", { name: "Артикули" });
  const row = items.getByRole("row").filter({ hasText: "Mystery Decant 15 ml" });
  await row.getByRole("button", { name: "Избери продукт" }).click();
  await row.getByLabel("Търси по SKU, име или код в склада").fill("decant 15");
  await row.getByLabel("Бележка (по избор), напр. защо този").fill("подхожда на другия артикул");
  await row.getByTestId("line-product-pick-SYN-RV-DECANT-15").click();
  await expect(row).toContainText("SYN-RV-DECANT-15", { timeout: 60_000 });
  await expect(row).toContainText("избран ръчно за тази поръчка · подхожда на другия артикул");
  await expect(row).toContainText("4 за продажба");
  await expect(findings).not.toContainText("Mystery Decant 15 ml");
  // The amount to collect changes with the product: set the COD by hand, then put Shopify's back.
  await page.getByTestId("cod-edit-open").click();
  const cod = page.getByTestId("cod-editor");
  await cod.getByLabel("Наложен платеж (EUR)").fill("42.50");
  await cod.getByLabel("Причина (по избор), напр. сменен продукт").fill("сменен продукт");
  await cod.getByRole("button", { name: "Запази и провери" }).click();
  await expect(page.getByTestId("cod-manual")).toContainText("променен ръчно · сменен продукт", {
    timeout: 60_000,
  });
  await page.getByTestId("cod-restore").click();
  await expect(page.getByTestId("cod-manual")).toHaveCount(0, { timeout: 60_000 });
  // Undo puts the line back to unmatched.
  await row.getByRole("button", { name: "Махни избора" }).click();
  await expect(row).toContainText("Несвързан", { timeout: 60_000 });
});
