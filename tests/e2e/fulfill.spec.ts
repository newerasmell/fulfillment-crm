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
  await page.getByTestId("fold-writeback").locator("summary").click();
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
