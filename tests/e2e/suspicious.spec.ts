import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// Synthetic data only (tests/e2e/seed-suspicious.ts): group "Тест група Връзки", line "Парфюми", one FHB warehouse
// and one store. SKU 5900000000007 links the store variant "Gamma Rose EDP 15ml" to the master / warehouse
// product "Decant Beta Noir EDP 15ml" (invented names) — flagged; SKU 5900000000001 is the same perfume in other
// wording — not flagged. No vendor or Shopify call.
const SUS_OWNER = {
  email: process.env.E2E_SUS_EMAIL ?? "",
  password: process.env.E2E_SUS_PASSWORD ?? "",
  totp: process.env.E2E_SUS_TOTP ?? "",
};
const STORE = process.env.E2E_SUS_STORE ?? "";

test("suspicious links: a SKU reused for another perfume is flagged, kept out of the Shopify push, then confirmed", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await login(page, SUS_OWNER);

  // Продукти и наличности: the card lists the flagged pair side by side; the coverage card counts it.
  await page.goto("/products");
  await page.waitForLoadState("networkidle");
  const card = page.getByTestId("suspicious-links");
  await expect(card.getByRole("heading", { name: /Съмнителни връзки \(1\)/ })).toBeVisible();
  const row = card.getByTestId("suspicious-5900000000007");
  await expect(row).toContainText("Decant Beta Noir EDP 15ml");
  await expect(row).toContainText("Gamma Rose EDP 15ml");
  await expect(row).toContainText("различни имена");
  await expect(card.getByTestId("suspicious-5900000000001")).toHaveCount(0);
  await expect(page.locator('[data-testid^="coverage-suspicious-"]')).toHaveText("Съмнителни връзки: 1");

  // Shopify push preview: the flagged variant is skipped with the reason and a hint, the other one is planned.
  await page.goto(`/stores/${STORE}/inventory`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("list", { name: "Пропуснати" })).toContainText("съмнителна връзка");
  await expect(page.getByRole("list", { name: "Пропуснати" })).toContainText("Съмнителни връзки");

  // Основни продукти по линии shows the same card; confirm it there ("same product").
  await page.goto("/products/lines");
  await page.waitForLoadState("networkidle");
  const lineCard = page.getByTestId("suspicious-links");
  await expect(lineCard.getByRole("heading", { name: /Съмнителни връзки \(1\)/ })).toBeVisible();
  await page.screenshot({ path: "docs/screens/suspicious-links.png", fullPage: true });
  await lineCard.getByRole("button", { name: /Потвърди връзката 5900000000007/ }).click();
  // The row leaves the list as soon as the page re-renders; a reload shows the confirmation stays.
  await expect(lineCard.getByRole("heading", { name: /Съмнителни връзки \(0\)/ })).toBeVisible();
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("suspicious-links")).toContainText("Няма съмнителни връзки.");
  await page.goto("/products");
  await page.waitForLoadState("networkidle");
  await expect(page.locator('[data-testid^="coverage-suspicious-"]')).toHaveText("Съмнителни връзки: 0");

  // Confirmed: the push includes it again.
  await page.goto(`/stores/${STORE}/inventory`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("list", { name: "Пропуснати" })).not.toContainText("съмнителна връзка");
});
