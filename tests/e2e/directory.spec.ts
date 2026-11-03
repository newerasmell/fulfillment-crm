import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// Synthetic data only (tests/e2e/seed-directory.ts): group "Тест група Справочник" with an euShipments and an
// FHB connection whose mirrors hold offices, lockers, PUDO points, couriers, cities, companies and orders with
// invoice fields. No worker runs: "Обнови" only queues the existing read jobs.
const DIRECTORY_OWNER = {
  email: process.env.E2E_DIRECTORY_EMAIL ?? "",
  password: process.env.E2E_DIRECTORY_PASSWORD ?? "",
  totp: process.env.E2E_DIRECTORY_TOTP ?? "",
};

test("directory: offices + PUDO search, paging, detail with copy; couriers, cities, sender; invoices", async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page, DIRECTORY_OWNER);

  // ── Офиси и PUDO ──
  await page.goto("/directory");
  await expect(page.getByRole("heading", { name: "Офиси, PUDO, потребители", level: 1 })).toBeVisible();
  await expect(page.getByTestId("directory-tab-offices")).toContainText("PUDO локации");
  await expect(page.getByTestId("offices-total")).toContainText("69 резултата");
  await expect(page.getByTestId("offices-total")).toContainText("euShipments 67 · FHB 2");
  await expect(page.getByTestId("directory-sync")).toContainText("euShipments Справочник");
  await expect(page.getByTestId("directory-sync")).toContainText("FHB Справочник");
  await expect(page.getByText("Страница 1 от 2")).toBeVisible();
  await page.screenshot({ path: "docs/screens/p10-directory-offices.png", fullPage: true });

  // Server-side filters: country HU = euShipments lockers (via the courier's country) + FHB PUDO points.
  const filters = page.getByRole("form", { name: "Филтри" });
  await filters.getByLabel("Държава").selectOption("HU");
  await filters.getByRole("button", { name: "Приложи" }).click();
  await expect(page.getByTestId("offices-total")).toContainText("4 резултата");
  await expect(page.getByTestId("office-eu-80001")).toContainText("Автомат");
  await expect(page.getByTestId("office-fhb-3190001")).toContainText("PUDO точка");
  await filters.getByLabel("Вид").selectOption("pudo");
  await filters.getByRole("button", { name: "Приложи" }).click();
  await expect(page.getByTestId("offices-total")).toContainText("2 резултата");
  // FHB point: delivery_point takes `id` or `external_code` (FHB does not say) — both shown, labelled, equally.
  const fhbRow = page.getByTestId("office-fhb-3190001");
  await expect(fhbRow).toContainText("external_code");
  await fhbRow.getByRole("link", { name: "Synth PUDO Debrecen" }).click();
  const codes = page.getByTestId("office-detail-fhb-codes");
  await expect(codes).toContainText("отворен въпрос");
  await expect(page.getByTestId("office-detail-id")).toHaveText("3190001");
  await expect(page.getByTestId("office-detail-external_code")).toHaveText("X-1");
  await expect(codes.getByRole("button", { name: /Копирай кода/ })).toHaveCount(2);

  // Search by name/code/address across 65+ rows.
  await page.goto("/directory?tab=offices");
  await filters.getByLabel("Търсене").fill("бул. Тестов 42");
  await filters.getByRole("button", { name: "Приложи" }).click();
  await expect(page.getByTestId("offices-total")).toContainText("1 резултат");
  const row = page.getByTestId("office-eu-70042");
  await expect(row).toContainText("Синт офис 42");
  await expect(row).toContainText("Синт Куриер БГ");

  // Detail: every mirrored field, and the code copied for pasting into an order.
  await row.getByRole("link", { name: "Синт офис 42" }).click();
  const detail = page.getByTestId("office-detail");
  await expect(detail).toContainText("recipient.officeId");
  await expect(page.getByTestId("office-detail-code")).toHaveText("70042");
  await expect(detail).toContainText("SO42");
  await expect(detail).toContainText("09:00 – 18:00");
  await expect(detail).toContainText("42.69, 23.32");
  await detail.getByRole("button", { name: "Копирай кода 70042" }).click();
  await expect(detail.getByRole("button", { name: "Копирай кода 70042" })).toHaveText("Копирано");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("70042");
  await page.screenshot({ path: "docs/screens/p10-directory-office-detail.png", fullPage: true });

  // Paging: page 2 ends with the FHB points.
  await page.goto("/directory?tab=offices&page=2");
  await expect(page.getByText("Страница 2 от 2")).toBeVisible();
  await expect(page.getByTestId("office-fhb-3190002")).toBeVisible();

  // "Обнови" queues the existing read jobs (no worker here).
  await page.getByRole("button", { name: "Обнови" }).click();
  await expect(page.getByRole("status")).toContainText("Пусната е синхронизация (2)");

  // ── Куриери ──
  await page.getByTestId("directory-tab-couriers").click();
  await expect(page.getByTestId("courier-eu-915")).toContainText("65");
  await expect(page.getByTestId("courier-eu-922")).toContainText("HU");
  await expect(page.getByTestId("courier-fhb-syn_pudo")).toContainText("Synth PUDO");
  await page.getByTestId("courier-eu-922").getByRole("link", { name: "2" }).click();
  await expect(page.getByTestId("offices-total")).toContainText("2 резултата");

  // ── Градове ──
  await page.goto("/directory?tab=cities&q=sofia");
  await expect(page.getByTestId("city-68134")).toContainText("София");
  await expect(page.getByTestId("city-91011")).toHaveCount(0);

  // ── Потребители / подател ──
  await page.getByTestId("directory-tab-senders").click();
  await expect(page.getByText("Синт Подател ЕООД")).toBeVisible();
  await expect(page.getByText("подател на тази връзка")).toBeVisible();
  await expect(page.getByText("990001").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "в ZOE ↗" })).toHaveAttribute("href", "https://zoe2.fhb.sk");
  await page.screenshot({ path: "docs/screens/p10-directory-senders.png", fullPage: true });

  // ── Фактури ──
  await page.goto("/invoices");
  await expect(page.getByRole("heading", { name: "Фактури", level: 1 })).toBeVisible();
  await expect(page.getByTestId("invoice-cabinets")).toContainText("Отвори в ZOE ↗");
  await expect(page.getByTestId("invoice-cabinets")).toContainText("Статистика → Списък с фактури");
  await expect(page.getByTestId("invoices-tab-all")).toContainText("2");
  await expect(page.getByTestId("invoices-tab-pdf")).toContainText("1");
  const inv = page.getByTestId("invoice-DIR-1001");
  await expect(inv).toContainText("SYN-INV-1001");
  await expect(inv.getByRole("link", { name: "#DIR-1001" })).toBeVisible();
  await expect(inv.getByRole("link", { name: "Отвори PDF ↗" })).toHaveAttribute(
    "href",
    "https://example.test/invoices/syn-1001.pdf",
  );
  await expect(page.getByTestId("invoice-DIR-1002")).toContainText("няма поръчка в CRM");
  await expect(page.getByTestId("invoice-DIR-1003")).toHaveCount(0);
  await page.screenshot({ path: "docs/screens/p10-invoices.png", fullPage: true });
});
