import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// Data comes from the synthetic FHB mirror seeded by tests/e2e/seed-fhb.ts (no FHB calls anywhere).

test("FHB mirror: connection card, stock board, orders, RMA, COD, returns, carriers, DRY_RUN payload", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await login(page);
  await page.goto("/warehouses");
  await expect(page.getByRole("heading", { name: "FHB връзки" })).toBeVisible();
  await expect(page.getByRole("link", { name: "FHB Демо", exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("e2e-fhb-secret-not-real");
  await page.getByRole("link", { name: "FHB Демо", exact: true }).click();
  await expect(page.getByRole("heading", { name: "FHB Демо" })).toBeVisible();

  // Products and stock (default tab): our SKU + FHB codes; the EAN FHB corrected is marked as real.
  const tabs = page.getByRole("navigation", { name: "Раздели на склада" });
  await expect(tabs.getByRole("link", { name: /Продукти и наличности/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(tabs.getByText("Stock receipts")).toBeVisible(); // vendor's original name under ours
  await expect(page.getByRole("link", { name: "Синтетичен парфюм EDP 50 мл" })).toBeVisible();
  await expect(page.getByText("RTM0001")).toBeVisible();
  await expect(page.getByText("реален, от FHB")).toBeVisible();

  // Unlinked product → link it to the master by SKU from the side panel.
  await page.getByRole("link", { name: /Несвързани\s*1/ }).click();
  await page.getByRole("link", { name: "Synthetic unlinked tester" }).click();
  await expect(page.getByRole("complementary", { name: "Детайли за продукта" })).toContainText("RTM0002");
  await page.getByRole("textbox", { name: "SKU на основен продукт" }).fill("SYN-EDP-50");
  await page.getByRole("button", { name: "Свържи" }).click();
  // Linked: the panel now shows our SKU and no longer offers the link form.
  const panel = page.getByRole("complementary", { name: "Детайли за продукта" });
  await expect(panel.getByRole("button", { name: "Свържи" })).toHaveCount(0);
  await expect(panel).toContainText("SYN-EDP-50");

  // Orders with the raw FHB status next to ours, and a read-only detail.
  await tabs.getByRole("link", { name: /^Поръчки/ }).click();
  await expect(page.getByRole("link", { name: "DM-1002" })).toBeVisible();
  await page.getByRole("link", { name: "DM-1001" }).click();
  await expect(page.getByRole("region", { name: "Поръчка" })).toContainText("Example street 1");
  await expect(page.getByRole("button", { name: "Прочети отново от FHB" })).toBeVisible();

  // RMA: only the order that came back.
  await tabs.getByRole("link", { name: /Върнати от куриер/ }).click();
  await expect(page.getByRole("link", { name: "DM-1002" })).toBeVisible();
  await expect(page.getByRole("link", { name: "DM-1001" })).toHaveCount(0);

  // COD by status, amounts in local currency.
  await tabs.getByRole("link", { name: /Наложен платеж/ }).click();
  await expect(page.getByRole("list", { name: "Наложен платеж по статус" })).toContainText("Чака от куриера");
  await expect(page.getByRole("cell", { name: "25,50" })).toBeVisible();

  // Local returns at the depot.
  await tabs.getByRole("link", { name: /Връщания в склада/ }).click();
  await expect(page.getByRole("cell", { name: "SYN00001" })).toBeVisible();

  // Carriers and a loaded pick-up point list.
  await tabs.getByRole("link", { name: /Куриери и PUDO/ }).click();
  await expect(page.getByRole("cell", { name: "dpd_eu_pudo" })).toBeVisible();
  await page.getByRole("link", { name: "SK (1)" }).click();
  await expect(page.getByRole("cell", { name: "Synthetic Point" })).toBeVisible();

  // DRY_RUN payload preview: exactly what would be sent, nothing sent.
  await tabs.getByRole("link", { name: /Заявки към склада/ }).click();
  await expect(page.getByText("нищо не е изпратено към FHB")).toBeVisible();
  await expect(page.getByText("Проба — записана").first()).toBeVisible();
  await expect(page.locator("pre")).toContainText('"name": "Synthetic new product"');
  await expect(page.locator("pre")).not.toContainText("productId"); // CRM-only meta is never shown as payload

  // Settings: mode stepper; lowering the mode works.
  await tabs.getByRole("link", { name: /Настройки/ }).click();
  await expect(page.getByRole("list", { name: "Стъпки на режима" })).toContainText("Проба");
  await page.getByRole("combobox", { name: "Нов режим" }).selectOption("READ_ONLY");
  await page.getByRole("button", { name: "Смени режима" }).click();
  await expect(page.getByRole("heading", { name: "FHB Демо" })).toBeVisible();
  await expect(page.locator('[aria-current="step"]')).toContainText("Само четене");
});

test("FHB: new connection starts in read only, credentials never come back; stock board under Продукти", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await login(page);
  await page.goto("/warehouses");
  await page.waitForLoadState("networkidle");
  const form = page.getByRole("form", { name: "Добави FHB връзка" });
  await form.getByRole("textbox", { name: "Име" }).fill("FHB Втора");
  await form.getByRole("textbox", { name: "App ID" }).fill("e2e-second-app");
  await form.getByLabel("Secret").fill("e2e-second-secret-not-real");
  await form.getByRole("textbox", { name: "Префикс на SKU в склада" }).fill("R");
  await form.getByRole("button", { name: "Добави FHB връзка" }).click();
  await expect(page.getByRole("heading", { name: "FHB Втора" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Само четене").first()).toBeVisible();
  await page.goto(`${page.url().split("?")[0]}?tab=settings`);
  await expect(page.getByText(/Записани \(криптирани\)/)).toBeVisible();
  await expect(page.locator("body")).not.toContainText("e2e-second-secret-not-real");

  await page.goto("/products");
  await page.getByRole("link", { name: "Наличности в склада" }).click();
  await expect(page.getByRole("heading", { name: "Наличности в склада" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Синтетичен парфюм EDP 50 мл" }).first()).toBeVisible();
  await page
    .getByRole("link", { name: /Движения/ })
    .first()
    .click();
  await expect(page.getByRole("cell", { name: "-2" })).toBeVisible();
});
