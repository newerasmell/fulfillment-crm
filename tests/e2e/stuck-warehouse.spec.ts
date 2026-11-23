import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// Synthetic data only (tests/e2e/seed-stuck.ts): group "Тест група Блокирани", one euShipments connection, two stuck
// shipments and one held unit. The CRM only assembles the emails; nothing is sent from here.
const OWNER = {
  email: process.env.E2E_STUCK_EMAIL ?? "",
  password: process.env.E2E_STUCK_PASSWORD ?? "",
  totp: process.env.E2E_STUCK_TOTP ?? "",
};

test("Блокирани в склад: emails to copy, sent / reply / customer recorded, SKU unlocked, order banner, settings", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page, OWNER);

  await page.goto("/orders/stuck");
  await expect(page.getByRole("heading", { name: "Блокирани в склад", level: 1 })).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForLoadState("networkidle");
  const card = page.getByTestId("case-card");
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("case-level")).toHaveText("Решение");
  await expect(card.getByTestId("case-order")).toHaveCount(2);
  await expect(card.getByTestId("case-next")).toContainText("Време е за първи мейл");

  // First email: To, subject and body as they go into Gmail.
  const email = card.getByTestId("case-email");
  await expect(email).toContainText("warehouse-support@example.com");
  await expect(email).toContainText("2 orders not processed for over 80 h");
  await expect(email).toContainText("SCS-8102 | AWB SYNAWB8101");
  await expect(email).not.toContainText("Синтетичен Клиент");
  await card.getByTestId("case-email-copy-body").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Please reply today");
  await card.getByTestId("case-email-sent").click();
  await expect(card).toContainText("последен мейл 1");
  await expect(card.getByTestId("case-next")).toContainText("изпратете напомняне");

  // The final notice carries the escalation address.
  await card.getByTestId("case-email-toggle").click();
  await card.getByTestId("case-email-level-3").click();
  await expect(card.getByTestId("case-email")).toContainText("warehouse-manager@example.com");
  await expect(card.getByTestId("case-email")).toContainText("FINAL NOTICE");

  // The customer of the oldest order: the code goes into the text.
  await card.getByTestId("customer-email-open").nth(0).click();
  const ce = card.getByTestId("customer-email");
  await ce.getByTestId("customer-email-code").fill("SORRY15");
  await expect(ce).toContainText("15% discount code for your next order: SORRY15");
  await expect(ce).toContainText("stuck-buyer-");
  await ce.getByTestId("customer-email-sent").click();
  await expect(card.getByTestId("case-order").filter({ hasText: "#S-8102" })).toContainText(
    "Писано на клиента",
  );

  // The warehouse replied it has the goods of #S-8102 (its item was held): marked, and the item unlocked.
  await card.getByTestId("case-reply-toggle").click();
  await card.getByTestId("case-reply-body").fill("We have it, it ships today.");
  await card.getByTestId("case-reply").getByText("#S-8102").click();
  await card.getByTestId("case-reply-save").click();
  await expect(card.getByTestId("case-order").filter({ hasText: "#S-8102" })).toContainText(
    "Складът потвърди наличност",
  );
  await page.goto("/orders/stuck?tab=sku");
  await expect(page.getByTestId("sku-watch-empty")).toBeVisible();

  // The order page shows its case.
  await page.goto("/orders/stuck");
  await page.getByRole("link", { name: "#S-8101", exact: true }).click();
  await expect(page.getByTestId("stuck-banner")).toContainText("Блокирана в склад euShipments Склад: 30 ч");

  // Settings: a wrong address is refused, a right one saved.
  await page.goto("/settings/warehouse-emails");
  const form = page.getByTestId("escalation-form");
  await expect(form.getByTestId("esc-warehouseTo")).toHaveValue("warehouse-support@example.com");
  await form.getByTestId("esc-warehouseTo").fill("not-an-address");
  await form.getByTestId("esc-save").click();
  await expect(form).toContainText("Невалиден мейл адрес.");
  await form.getByTestId("esc-warehouseTo").fill("warehouse-support@example.com, second@example.com");
  await form.getByTestId("esc-save").click();
  await expect(form).toContainText("Запазено.");

  // „С грешки“ says why an order is there.
  await page.goto("/orders?tab=issues");
  await expect(page.getByTestId("order-issue-reasons").first()).toContainText(
    "Стои в „Приета от склада“ твърде дълго",
  );
});
