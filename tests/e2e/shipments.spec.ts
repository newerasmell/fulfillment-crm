import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

// Synthetic data only (tests/e2e/seed-shipments.ts): group "Тест група Товарителници" with FHB, FHB Joy and
// euShipments connections, 57 shipments and one FHB ticket notification. No vendor is called.
const SHIPMENTS_OWNER = {
  email: process.env.E2E_SHIPMENTS_EMAIL ?? "",
  password: process.env.E2E_SHIPMENTS_PASSWORD ?? "",
  totp: process.env.E2E_SHIPMENTS_TOTP ?? "",
};

const tab = (page: Page, key: string) => page.getByTestId(`shipments-tab-${key}`);

test("shipments list: chips, delayed, filters, search, paging, detail, CSV, settings; header search; tickets", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await login(page, SHIPMENTS_OWNER);

  // ── Товарителници ──
  await page.goto("/shipments");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "Товарителници", level: 1 })).toBeVisible();
  await expect(tab(page, "all")).toContainText("57");
  await expect(tab(page, "preparing")).toContainText("1");
  await expect(tab(page, "shipped")).toContainText("3");
  await expect(tab(page, "delivered")).toContainText("50");
  await expect(tab(page, "returning")).toContainText("1");
  await expect(tab(page, "problem")).toContainText("1");
  await expect(tab(page, "cancelled")).toContainText("1");
  await expect(tab(page, "delayed")).toContainText("1");

  const fresh = page.getByTestId("shipment-SH-E2E-1");
  await expect(fresh).toContainText("#SH-1001");
  await expect(fresh).toContainText("Мария Синтетична");
  await expect(fresh).toContainText("GLS Romania");
  await expect(fresh).toContainText("Изпратена");
  await expect(fresh).toContainText("sent");
  await expect(fresh).toContainText("Козметика");
  await expect(fresh).toContainText("Фирма Пратки А");
  await expect(fresh).toContainText("Тикет: отворен");
  await expect(fresh.getByRole("link", { name: "GLSRO000111 ↗" })).toHaveAttribute(
    "href",
    "https://tracking.example.test/GLSRO000111",
  );
  await expect(fresh).toContainText(/99,50\s?RON/);
  await expect(page.getByTestId("shipment-SH-E2E-7")).toContainText("Етикет FHB Joy");
  await page.screenshot({ path: "docs/screens/p10-shipments.png" });

  // Delayed: shipped 12 days ago, not delivered (default threshold 7 days).
  await tab(page, "delayed").click();
  const late = page.getByTestId("shipment-SH-E2E-2");
  await expect(late).toContainText("Забавена");
  await expect(late).toContainText("Speedy");
  await expect(late).toContainText("Information received");
  await expect(page.locator("tbody tr")).toHaveCount(1);

  // Paging: 57 rows, 50 per page.
  await tab(page, "all").click();
  await expect(page.getByText("Страница 1 от 2 · 57 пратки")).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(50);
  await page.getByRole("link", { name: "Следваща →" }).click();
  await expect(page.getByText("Страница 2 от 2 · 57 пратки")).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(7);

  // Filters: warehouse, search by tracking / phone.
  await page.goto("/shipments");
  await page.locator(`select[name="connection"]`).selectOption({ label: "Joy Пратки · FHB Joy" });
  await page.getByRole("button", { name: "Приложи" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByTestId("shipment-SH-E2E-7")).toBeVisible();
  await page.goto("/shipments?q=SPD000222");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.goto("/shipments?q=%2B40700000111");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByTestId("shipment-SH-E2E-1")).toBeVisible();

  // Detail drawer with the link to the order timeline and to ZOE.
  await page.getByRole("link", { name: "Детайли за пратка SH-E2E-1" }).click();
  const drawer = page.getByTestId("shipment-detail");
  await expect(drawer).toContainText("Пратка SH-E2E-1");
  await expect(drawer).toContainText("Тикет от склада");
  await expect(drawer.getByRole("link", { name: "Още за пратката в ZOE ↗" })).toHaveAttribute(
    "href",
    "https://zoe2.fhb.sk",
  );
  await expect(drawer.getByRole("link", { name: "#SH-1001" })).toHaveAttribute("href", /\/orders\//);
  await drawer.getByRole("link", { name: "Затвори" }).click();
  await expect(page.getByTestId("shipment-detail")).toHaveCount(0);

  // CSV export with the same filter.
  const csv = await page.request.get("/api/shipments/export?tab=shipped");
  expect(csv.status()).toBe(200);
  const text = await csv.text();
  expect(text).toContain("order;shipment;company;warehouse;carrier;tracking");
  expect(text).toContain("GLSRO000111");
  expect(text.trim().split("\r\n")).toHaveLength(4);

  // Settings: a longer threshold → nothing delayed.
  await page.goto("/shipments");
  const settings = page.getByRole("form", { name: "Настройки на товарителниците" });
  await settings.getByLabel("„Забавена“ след (дни без доставка)").fill("20");
  await settings.getByRole("button", { name: "Запази" }).click();
  await expect(settings.getByRole("status")).toContainText("Записано.");
  await page.reload();
  await expect(tab(page, "delayed")).toContainText("0");

  // ── header search (Ctrl K) finds a shipment by tracking number ──
  await page.keyboard.press("Control+k");
  await page.getByTestId("global-search-input").fill("SPD000222");
  const results = page.getByTestId("global-search-results");
  await expect(results).toContainText("SPD000222");
  await expect(results).toContainText("#SH-1002");
  await results.getByRole("link", { name: /SPD000222/ }).click();
  await expect(page.getByTestId("shipment-detail")).toContainText("Пратка SH-E2E-2");

  // ── Тикети от склада ──
  await page.goto("/");
  await expect(page.locator(`a[href="/tickets?tab=unreviewed"]`)).toContainText("1");
  await page.goto("/tickets");
  await expect(page.getByRole("heading", { name: "Тикети от склада", level: 1 })).toBeVisible();
  await expect(page.getByTestId("tickets-tab-open")).toContainText("1");
  await expect(page.getByTestId("tickets-tab-unreviewed")).toContainText("1");
  await expect(page.getByTestId("tickets-eu-note")).toContainText("euShipments няма API за тикети");
  const ticket = page.getByTestId("ticket-SH-E2E-1");
  await expect(ticket).toContainText("Отворен");
  await expect(ticket).toContainText("ticket_created");
  await expect(ticket).toContainText("#SH-1001");
  await expect(ticket).toContainText("Фирма Пратки А");
  await expect(ticket.getByRole("link", { name: "Отвори в ZOE ↗" })).toHaveAttribute(
    "href",
    "https://zoe2.fhb.sk",
  );
  await page.screenshot({ path: "docs/screens/p10-tickets.png", fullPage: true });

  await ticket.getByRole("button", { name: "Маркирай като прегледан" }).click();
  const form = page.getByRole("form", { name: "Преглед на тикет #SH-1001" });
  await form.getByRole("button", { name: "Прегледан" }).click();
  await expect(form.getByRole("alert")).toContainText("Напишете бележка");
  await form.getByLabel("Бележка").fill("Отговорено в ZOE: адресът е потвърден");
  await form.getByRole("button", { name: "Прегледан" }).click();
  await expect(ticket.getByTestId("ticket-reviewed")).toContainText("Прегледан от E2E Shipments");
  await expect(ticket).toContainText("Бележка: Отговорено в ZOE");
  await expect(page.getByTestId("tickets-tab-unreviewed")).toContainText("0");

  // The ticket's alert was resolved with the review.
  await page.goto("/alerts");
  await expect(page.getByText("FHB opened a ticket for #SH-1001")).toHaveCount(0);
});
