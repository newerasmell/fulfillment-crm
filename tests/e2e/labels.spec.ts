import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

// Synthetic data only (tests/e2e/seed-labels.ts): group "Тест група Етикети". No vendor is called — the web app
// only writes outbox rows and read jobs, and no worker runs during e2e.
const WHO = {
  email: process.env.E2E_LABELS_EMAIL ?? "",
  password: process.env.E2E_LABELS_PASSWORD ?? "",
  totp: process.env.E2E_LABELS_TOTP ?? "",
};
const SEEDED = process.env.E2E_LABELS_SEEDED ?? "M1001";

async function openNew(page: Page) {
  await page.goto("/manual-shipments/new");
  await expect(page.getByRole("heading", { name: "Нова ръчна пратка", level: 1 })).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForLoadState("networkidle");
}

async function fillRecipient(
  page: Page,
  r: {
    name: string;
    phone: string;
    email?: string;
    street: string;
    city: string;
    zip: string;
    country: string;
  },
) {
  const form = page.getByRole("form", { name: "Нова ръчна пратка" });
  await form.getByLabel("Име", { exact: true }).fill(r.name);
  await form.getByLabel("Телефон", { exact: true }).fill(r.phone);
  if (r.email) await form.getByLabel("Имейл", { exact: true }).fill(r.email);
  await form.getByLabel("Държава (ISO)", { exact: true }).fill(r.country);
  await form.getByLabel("Улица", { exact: true }).fill(r.street);
  await form.getByLabel("Град", { exact: true }).fill(r.city);
  await form.getByLabel("Пощенски код", { exact: true }).fill(r.zip);
  return form;
}

test("manual shipments: Joy label in CANARY, AWB, from stock, hard block, label download, bulk PDF", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await login(page, WHO);

  // List: the seeded label with its stored PDF.
  await page.goto("/manual-shipments");
  await expect(page.getByRole("heading", { name: "Ръчни пратки и етикети", level: 1 })).toBeVisible({
    timeout: 60_000,
  });
  const seededRow = page.getByRole("row").filter({ hasText: SEEDED });
  await expect(seededRow).toContainText("Етикет FHB Joy");
  await expect(seededRow).toContainText("E2E-TRACK-0001");
  const href = await seededRow.getByRole("link", { name: "Свали етикета (PDF)" }).getAttribute("href");
  const pdf = await page.request.get(href!);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  // The Joy connection card: billable warning and the mode.
  await expect(page.getByRole("article", { name: "Joy Етикети" })).toContainText("Канарче");

  // Bulk PDF: queued for the worker (none runs in e2e, so it waits).
  await page.waitForLoadState("networkidle");
  await seededRow.getByRole("checkbox").check();
  const bar = page.getByRole("region", { name: "Групов печат на етикети" });
  await bar.getByRole("button", { name: "Един PDF с етикетите" }).click();
  await expect(bar.getByText("Чака склада…")).toBeVisible({ timeout: 30_000 });

  // Hard block: Joy without an email cannot be created.
  await openNew(page);
  let form = await fillRecipient(page, {
    name: "Test Recipient",
    phone: "+420601000222",
    street: "Testovacia 12",
    city: "Testov",
    zip: "75501",
    country: "CZ",
  });
  await form.getByLabel("Валута", { exact: true }).fill("CZK");
  await form.getByLabel("Куриерска услуга (Joy)").selectOption("pplcz");
  await form.getByRole("button", { name: "Провери" }).click();
  const checks = page.getByRole("complementary", { name: "Проверки преди изпращане" });
  await expect(checks).toContainText("Имейлът е задължителен за Joy.", { timeout: 30_000 });
  await expect(form.getByRole("button", { name: "Създай етикета" })).toBeDisabled();

  // Fix it, check again, create: the label waits for a CANARY confirmation showing the exact payload.
  await form.getByLabel("Имейл", { exact: true }).fill("recipient@example.com");
  await form.getByRole("button", { name: "Провери" }).click();
  await expect(checks).toContainText("Всички проверки минаха.", { timeout: 30_000 });
  await expect(checks).toContainText("Ръчно избрана връзка");
  await form.getByRole("button", { name: "Създай етикета" }).click();
  await expect(page.getByRole("heading", { name: /^Ръчна пратка M\d+$/, level: 1 })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("Канарче: потвърдете точно тази заявка")).toBeVisible();
  await expect(page.locator("pre").first()).toContainText('"parcelService": "pplcz"');
  await expect(page.locator("pre").first()).toContainText('"country": "cz"');
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Потвърждавам и изпращам" }).click();
  await expect(page.getByText(/Потвърдено/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("table")).toContainText("joy.shipment.create");

  // euShipments AWB (LIVE): queued in the outbox; the worker would send it.
  await openNew(page);
  form = page.getByRole("form", { name: "Нова ръчна пратка" });
  await form.getByText("Товарителница euShipments", { exact: true }).click();
  await fillRecipient(page, {
    name: "Test User",
    phone: "0888123456",
    email: "test@example.com",
    street: "Test street 10",
    city: "Testograd",
    zip: "1000",
    country: "BG",
  });
  await form
    .getByRole("combobox", { name: "Куриер", exact: true })
    .selectOption({ label: "Тест куриер · BG" });
  await form.getByLabel("Съдържание").fill("Мостра");
  await form.getByRole("button", { name: "Провери" }).click();
  await expect(checks).toContainText("Всички проверки минаха.", { timeout: 30_000 });
  await page.getByText("Точно какво ще се изпрати").click();
  await expect(page.locator("pre").first()).toContainText('"referenceNumber": "M-PREVIEW"');
  await form.getByRole("button", { name: "Създай етикета" }).click();
  await expect(page.getByRole("heading", { name: /^Ръчна пратка M\d+$/, level: 1 })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole("table")).toContainText("eushipments.awb.create");
  await expect(page.getByRole("table")).toContainText("Чака изпращане");

  // From stock: the same validators; the order goes to the normal review → Fulfill flow.
  await openNew(page);
  form = page.getByRole("form", { name: "Нова ръчна пратка" });
  await form.getByText("От склад", { exact: true }).click();
  await fillRecipient(page, {
    name: "Stock Buyer",
    phone: "0888123457",
    email: "buyer@example.com",
    street: "Stock street 5",
    city: "Sofia",
    zip: "1000",
    country: "BG",
  });
  await form
    .getByRole("combobox", { name: "Продукт", exact: true })
    .selectOption({ label: "SYN-LBL-EDP-50 · Синтетичен парфюм етикети 50 мл" });
  await form.getByLabel("Ед. цена").fill("25");
  await form.getByRole("button", { name: "Провери" }).click();
  await expect(checks).toContainText("Маршрут и какво ще се изпрати", { timeout: 30_000 });
  await expect(checks).toContainText("Наличност: достатъчна");
  await form.getByRole("button", { name: "Създай поръчката" }).click();
  await expect(page).toHaveURL(/\/orders\/[a-z0-9]+$/, { timeout: 60_000 });
  await expect(page.getByRole("heading", { name: /^Поръчка M\d+$/, level: 1 })).toBeVisible({
    timeout: 60_000,
  });

  // The list shows all four.
  await page.goto("/manual-shipments?tab=all");
  await expect(page.getByRole("row")).toHaveCount(5, { timeout: 30_000 });
  await page.goto("/manual-shipments?tab=warehouse");
  await expect(page.getByRole("row").filter({ hasText: "От склад" })).toHaveCount(1);
});
