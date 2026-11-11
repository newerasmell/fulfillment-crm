import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// Synthetic e2e data only (tools/e2e-fulfill.ts): CANARY euShipments connection "euShipments Изпълнение",
// approved orders #93001 / #93002, not approved #93003. No worker runs: nothing leaves the outbox.
test("bulk Fulfill: selection, sticky bar, per-order result, CANARY confirmation with payload and cap", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await login(page);
  await page.goto("/orders?tab=all&q=9300");
  await page.waitForLoadState("networkidle");
  for (const n of ["#93001", "#93002", "#93003"])
    await page.getByRole("checkbox", { name: `Избери поръчка ${n}` }).check();
  const bar = page.getByRole("region", { name: "Действия с избраните" });
  await expect(bar).toContainText("Избрани: 3");
  await bar.getByRole("button", { name: "Изпълни (3)" }).click();

  await expect(page).toHaveURL(/\/orders\/fulfill\//, { timeout: 60_000 });
  await expect(page.getByTestId("fulfill-progress")).toContainText("3 от 3 обработени", { timeout: 60_000 });
  const rowA = page.getByTestId("fulfill-row-#93001");
  await expect(rowA).toContainText("В опашката");
  await expect(rowA).toContainText("Канарче");
  await expect(page.getByTestId("fulfill-row-#93002")).toContainText("В опашката");
  await expect(page.getByTestId("fulfill-row-#93003")).toContainText("Пропусната");
  await expect(page.getByTestId("fulfill-row-#93003")).toContainText("не е одобрена");

  // CANARY: the dialog shows the exact payload and the remaining daily cap; one click confirms one request.
  await rowA.getByRole("button", { name: "Прегледай и потвърди" }).click();
  const dialog = page.getByRole("dialog", { name: "Потвърждение (канарче)" });
  await expect(dialog.getByTestId("canary-cap")).toContainText("Остават 10 от 10");
  // Warehouse id = the Shopify order number as it is (the demo store has no warehouse prefix).
  await expect(dialog.getByLabel("Данни за изпращане")).toContainText('"93001"');
  await expect(dialog.getByLabel("Данни за изпращане")).not.toContainText("DM-93001");
  await dialog.getByRole("button", { name: "Потвърди изпращането" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(rowA.getByRole("button", { name: "Прегледай и потвърди" })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(
    page.getByTestId("fulfill-row-#93002").getByRole("button", { name: "Прегледай и потвърди" }),
  ).toBeVisible();

  // A second Fulfill of the same order from its page creates nothing new (DB guard, not the UI).
  await page.goto("/orders?tab=all&q=93001");
  await page.getByRole("link", { name: "#93001" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Изпълни", exact: true }).click();
  await expect(page.getByTestId("fulfill-row-#93001")).toContainText("Пропусната", { timeout: 60_000 });
  await expect(page.getByTestId("fulfill-row-#93001")).toContainText("без дубликат");
});

test("Shopify write-back: a DRY_RUN record shows the exact fulfillmentCreate data on the order", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await login(page);
  await page.goto("/orders?tab=all&q=93004");
  await page.getByRole("link", { name: "#93004" }).click();
  await page.getByTestId("fold-writeback").locator(":scope > summary").click();
  const wb = page.locator('[data-testid="writeback"][data-kind="FULFIL"]');
  await expect(wb).toContainText("E2E-TRK-93004", { timeout: 60_000 });
  await expect(wb).toContainText("Изпълнение");
  await expect(wb).toContainText("записано (пробно — би се изпратило)");
  await wb.getByText("Точни данни (fulfillmentCreate)").click();
  await expect(wb.locator("pre")).toContainText('"notifyCustomer": true');
  // The lifecycle: the status event that follows the fulfillment, with its exact data.
  const ev = page.locator('[data-testid="writeback"][data-kind="EVENT"]');
  await expect(ev).toContainText("Статус");
  await expect(ev).toContainText("в транзит");
  await ev.getByText("Точни данни (fulfillmentEventCreate)").click();
  await expect(ev.locator("pre")).toContainText('"status": "IN_TRANSIT"');
});

test("unknown courier: the order asks for Shopify's carrier; the pick releases the write-back", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await login(page);
  await page.goto("/orders?tab=all&q=93005");
  await page.getByRole("link", { name: "#93005" }).click();
  const pick = page.getByTestId("carrier-pick");
  await expect(pick).toContainText("Изберете куриер за Shopify");
  await expect(pick).toContainText("E2E Local Courier");
  await expect(pick).toContainText("E2E-TRK-93005");
  await pick.locator("select").selectOption("ACS Courier");
  await page.screenshot({ path: "test-results/carrier-pick.png", fullPage: false });
  await pick.getByRole("button", { name: "Запази и изпрати" }).click();
  await expect(pick).toHaveCount(0, { timeout: 30_000 });
  await page.getByTestId("fold-writeback").locator(":scope > summary").click();
  const wb = page.locator('[data-testid="writeback"][data-kind="FULFIL"]');
  await expect(wb).toContainText("чака");
  await expect(wb).not.toContainText("чака потвърждение");
});

test("interrupted send: the order offers 'Провери в склада' (OWNER) and hands the lookup to the worker", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await login(page);
  await page.goto("/orders?tab=all&q=94007");
  await page.getByRole("link", { name: "#94007" }).click();
  await page.getByTestId("fold-shipments").locator(":scope > summary").click();
  const box = page.getByTestId("warehouse-recheck");
  await expect(box).toContainText("Неясно дали поръчката е стигнала до склада");
  await page.screenshot({ path: "test-results/warehouse-recheck.png", fullPage: false });
  page.once("dialog", (d) => d.accept());
  await box.getByRole("button", { name: "Провери в склада" }).click();
  await expect(box).toContainText("Проверява се");
});

test("Speedy office (BG): recognised from the address; a person can pick another office or 'До адрес'", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await login(page);
  await page.goto("/orders?tab=all&q=94008");
  await page.getByRole("link", { name: "#94008" }).click();
  const box = page.getByTestId("delivery-office");
  await expect(box.getByTestId("delivery-office-selected")).toContainText("ПЛЕВЕН - САН СТЕФАНО (УЛ.)");
  await expect(box).toContainText("разпознат от адреса");
  await box.screenshot({ path: "test-results/delivery-office.png" });
  await box.getByRole("textbox").fill("ХАДЖИ");
  await box.getByRole("button", { name: /ПЛЕВЕН - ХАДЖИ ДИМИТЪР/ }).click();
  await expect(box.getByTestId("delivery-office-selected")).toContainText("ХАДЖИ ДИМИТЪР", {
    timeout: 30_000,
  });
  await expect(box).toContainText("избран ръчно");
  await box.getByRole("button", { name: "До адрес" }).click();
  await expect(box.getByTestId("delivery-office-selected")).toHaveCount(0, { timeout: 30_000 });
});

test("tracking links: a courier's link template with a live test link; saved for new tracking", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await login(page);
  await page.getByRole("link", { name: "Линкове за проследяване" }).click();
  await expect(page.getByRole("heading", { name: "Линкове за проследяване" })).toBeVisible();
  const row = page.getByTestId("tracking-link-E2E Local Courier");
  await expect(row).toBeVisible();
  const input = row.getByRole("textbox");
  await input.fill("https://courier.example/no-number");
  await expect(row).toContainText("трябва да съдържа {tracking}");
  await input.fill("https://courier.example/track?parcel={tracking}");
  await expect(row.getByRole("link")).toHaveAttribute(
    "href",
    "https://courier.example/track?parcel=E2E-TRK-93005",
  );
  await row.getByRole("button", { name: "Запази" }).click();
  await expect(row).toContainText("Запазено");
  // Couriers remembered for shipments without one: listed below, with "Забрави" for the owner.
  await expect(page.getByRole("heading", { name: "Запомнени куриери за пратки без куриер" })).toBeVisible();
  const rule = page.getByTestId("nocarrier-rule");
  await expect(rule).toContainText("GR");
  await expect(rule).toContainText("ACS Courier");
  await page.screenshot({ path: "test-results/tracking-links.png", fullPage: true });
  page.once("dialog", (d) => d.accept());
  await rule.getByRole("button", { name: "Забрави" }).click();
  await expect(rule).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Още няма запомнени.")).toBeVisible();
});

test("anti-sabotage: a held order under Подозрителни is cancelled; the stock sync page lists the groups", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await login(page);
  await page.goto("/orders?tab=qtyHold");
  await page.getByRole("link", { name: "#93006" }).click();
  const hold = page.getByTestId("qty-hold");
  await expect(hold).toContainText("20 бр. общо");
  await page.screenshot({ path: "test-results/qty-hold.png", fullPage: false });
  page.once("dialog", (d) => d.accept());
  // Cancelled (approving is covered by the unit tests): an approved order would change the review counts the
  // Shopify spec checks later in the same run.
  await hold.getByRole("button", { name: "Откажи поръчката" }).click();
  await expect(hold).toHaveCount(0, { timeout: 30_000 });
  await page.getByRole("link", { name: "Синхронизация на наличности" }).click();
  await expect(page.getByRole("heading", { name: "Синхронизация на наличности" })).toBeVisible();
  await expect(page.getByRole("table", { name: /Групи с обща наличност/ }).first()).toBeVisible();
  await page.screenshot({ path: "test-results/stock-sync.png", fullPage: true });
});

test("alerts and tasks: count on Начало, one list, take it, resolve with a note", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  const card = page.getByRole("link", { name: /Сигнали и задачи\s*\d+/ });
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByRole("heading", { name: "Сигнали и задачи", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: /Промени в Shopify след одобрение/ }).click();
  const row = page.getByRole("row", { name: /E2E: поръчка отказана в Shopify след одобрение/ });
  await expect(row).toContainText("#93002");
  await expect(row).toContainText("Критичен");
  await page.waitForLoadState("networkidle");
  await row.getByRole("button", { name: "Поеми" }).click();
  await expect(row).toContainText("E2E Owner", { timeout: 30_000 });
  await row.getByRole("button", { name: "Приключи" }).click();
  const form = page.getByRole("form", { name: /Приключване: E2E: поръчка отказана/ });
  await form.getByRole("button", { name: "Приключи със бележка" }).click();
  await expect(row.getByRole("alert")).toContainText("Напишете бележка");
  await form.getByLabel("Бележка").fill("Проверено: пратката е спряна в склада");
  await form.getByRole("button", { name: "Приключи със бележка" }).click();
  await expect(page.getByRole("row", { name: /E2E: поръчка отказана/ })).toHaveCount(0, { timeout: 30_000 });
  await page.goto("/settings/audit");
  await expect(page.getByRole("cell", { name: "alert.resolve" }).first()).toBeVisible();
});

test("missing items: tabs, expected item, confirm a ready order (tags go to Shopify via the outbox)", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await login(page);
  await page.getByRole("link", { name: "Липсващи артикули" }).click();
  await expect(page.getByRole("heading", { name: "Липсващи артикули", level: 1 })).toBeVisible();
  const out = page.getByTestId("missing-stock-row").filter({ hasText: "#93101" });
  await expect(out).toContainText("липсва");
  await expect(out).toContainText("очакват се 5 бр.");
  await expect(out.getByTestId("missing-stock-action")).toHaveText("Чака зареждане");
  await page.screenshot({ path: "test-results/missing-stock-out.png", fullPage: true });
  await page.getByRole("link", { name: /За потвърждение/ }).click();
  const ready = page.getByTestId("missing-stock-row").filter({ hasText: "#93102" });
  await expect(ready).toContainText("зареден отново");
  await ready.getByTestId("missing-stock-action").click();
  await expect(page.getByRole("status")).toContainText("Изпратено към Shopify: 1");
  await expect(ready.getByTestId("missing-stock-write")).toContainText("Сменя се на Confirmed");
  await page.screenshot({ path: "test-results/missing-stock-ready.png", fullPage: true });
});
