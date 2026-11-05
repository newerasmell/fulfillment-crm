import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// Synthetic data only (tests/e2e/seed-rules-weights.ts): a Cyprus order blocked by "no phone rule for CY" and
// "product without weight". Both are fixed at the source from the order screen; nothing calls Shopify or a vendor
// (the store's "Тегло към Shopify" is DRY_RUN, so the exact Shopify payload is only recorded).
const RW_OWNER = {
  email: process.env.E2E_RW_EMAIL ?? "",
  password: process.env.E2E_RW_PASSWORD ?? "",
  totp: process.env.E2E_RW_TOTP ?? "",
};

test("CY order: add the country's phone rule and the product weight at the source", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page, RW_OWNER);
  await page.goto("/orders");
  await page.getByRole("link", { name: "#RW1001" }).first().click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("#RW1001");

  const findings = page.getByTestId("findings");
  await expect(findings).toContainText("Няма правило за телефони за тази държава.");
  await expect(findings).toContainText("Липсва тегло на продукт „Примерен парфюм 50 мл“.");

  // 1. Phone rule for CY, pre-filled from the order's phone, with a live preview and the warning.
  await page.getByText("Добави правило за CY").click();
  const ruleForm = page.getByRole("form", { name: "Правило за телефони за CY" });
  await expect(ruleForm.getByRole("note")).toContainText("Указанията на euShipments не описват формат за CY");
  await expect(ruleForm.getByRole("textbox", { name: "Код на държавата" })).toHaveValue("357");
  await expect(ruleForm.getByRole("textbox", { name: "Брой цифри след кода" })).toHaveValue("8");
  await expect(ruleForm.getByTestId("rule-preview")).toContainText("+35799123456");
  await expect(ruleForm.getByRole("textbox", { name: "Местна валута" })).toHaveValue("EUR");
  await page.screenshot({ path: "docs/screens/fix-cy-phone-rule.png", fullPage: true });
  await ruleForm.getByRole("button", { name: "Запази правилото" }).click();
  // The save re-checks the order; the screen refreshes and the phone finding is gone (the form goes with it).
  await expect(findings).not.toContainText("Няма правило за телефони", { timeout: 30_000 });

  // 2. Product weight: the warehouse suggestion with one click, also to Shopify (DRY_RUN store).
  const weightForm = page.getByRole("form", { name: /Въведи тегло: RW-PERF-50/ });
  await expect(weightForm).toContainText("450 g");
  await expect(weightForm).toContainText("от euShipments");
  await weightForm.getByRole("button", { name: "Използвай" }).click();
  await expect(weightForm.getByRole("spinbutton", { name: "Тегло (грамове)" })).toHaveValue("450");
  await expect(weightForm.getByLabel("Обнови теглото и в Shopify")).toBeChecked();
  await weightForm.getByRole("button", { name: "Запази теглото" }).click();
  await expect(page.getByText("Липсва тегло на продукт")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(/^Проверена .* · 0 блокиращи/)).toBeVisible();

  // 3. The product shows the weight for every order and the exact (dry-run) Shopify request.
  await page.goto("/products");
  await page.getByRole("link", { name: "Примерен парфюм 50 мл" }).click();
  await expect(page.getByTestId("product-weight")).toContainText("450 г");
  const write = page.getByTestId("weight-write").first();
  await expect(write).toContainText("Магазин Тегла");
  await expect(write).toContainText("пробно — записана заявка");
  await expect(page.getByTestId("weight-write-request")).toContainText('"unit": "GRAMS"');
  await expect(page.getByTestId("weight-write-request")).toContainText('"value": 450');
  await expect(page.getByTestId("weight-write-request")).toContainText(
    "gid://shopify/ProductVariant/8800001",
  );
  await page.screenshot({ path: "docs/screens/fix-product-weight.png", fullPage: true });

  // 4. Настройки → Държави: CY with our rule; the guideline countries read-only.
  await page.goto("/settings/countries");
  await expect(page.getByTestId("country-CY")).toContainText("+357");
  await expect(page.getByTestId("country-CY")).toContainText("Наше правило");
  await expect(page.getByTestId("country-BG")).toContainText("От указанията на euShipments");
  // Every country's currency is editable; GR shows its default (EUR) until a setting is saved.
  const gr = page.getByTestId("country-GR");
  await expect(gr.getByLabel("Местна валута за GR")).toHaveValue("EUR");
  await expect(gr).toContainText("по подразбиране за държавата");
  await gr.getByRole("button", { name: "Запази" }).click();
  await expect(gr).toContainText("Запазено", { timeout: 30_000 });
  await page.reload();
  await expect(page.getByTestId("country-GR")).not.toContainText("по подразбиране за държавата");
});
