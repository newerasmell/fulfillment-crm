import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

// Synthetic data only (tests/e2e/seed-cancel.ts): group "Тест група Отказ в склада", one euShipments connection in
// DRY_RUN. No worker runs during e2e: tools/e2e-cancel-worker.ts plays the sender ("send": DRY_RUN only records) and
// then the vendor's confirmed delete ("confirm": the real euShipments orderDeleted effect, nothing is sent).
const OWNER = {
  email: process.env.E2E_CANCEL_EMAIL ?? "",
  password: process.env.E2E_CANCEL_PASSWORD ?? "",
  totp: process.env.E2E_CANCEL_TOTP ?? "",
};

function runWorker(step: "send" | "confirm") {
  execFileSync("pnpm", ["exec", "tsx", "tools/e2e-cancel-worker.ts", step], {
    env: { ...process.env, DATABASE_URL: process.env.E2E_DATABASE_URL ?? "" },
    stdio: "pipe",
  });
}

async function openOrder(page: Page, number: string) {
  await page.goto("/orders?tab=all");
  await page.getByRole("link", { name: number, exact: true }).click();
  await expect(page.getByRole("heading", { name: `Поръчка ${number}`, level: 1 })).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForLoadState("networkidle");
}

test("Откажи в склада: DRY_RUN records it; the confirmed cancel blocks the order; Изпрати отново", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await login(page, OWNER);

  // Already packed: not offered, a short reason instead.
  await openOrder(page, "#K-9103");
  await expect(page.getByTestId("warehouse-cancel-row-KCK-9103")).toContainText(
    "вече не може да се откаже оттук — само в кабинета на склада",
  );
  await expect(page.getByTestId("warehouse-cancel-KCK-9103")).toHaveCount(0);

  await openOrder(page, "#K-9101");
  await page.getByTestId("fold-shipments").locator(":scope > summary").click();
  const row = page.getByTestId("warehouse-cancel-row-KCK-9101");
  await row.getByTestId("warehouse-cancel-KCK-9101").click();
  const dialog = page.getByRole("dialog", { name: "Отказ на пратката в склада" });
  await expect(dialog).toContainText("Пробен режим");
  const submit = dialog.getByRole("button", { name: "Откажи в склада" });
  await expect(submit).toBeDisabled(); // reason and acknowledgement are required
  await dialog.getByLabel("Причина").selectOption({ label: "Изпратена по грешка" });
  await dialog.getByLabel("Бележка (задължителна за „Друго“)").fill("грешен склад");
  await dialog
    .getByLabel("Разбирам: пратката в euShipments Склад ще бъде отказана и това не може да се върне.")
    .check();
  await submit.click();
  await expect(row).toContainText("Заявка за отказ: в опашката", { timeout: 60_000 });
  await expect(page.getByTestId("timeline")).toContainText("Поискан отказ в склада");
  await expect(page.getByTestId("shipments")).toContainText("Приета от склада");

  // DRY_RUN: the sender only records what would be sent; nothing changes.
  runWorker("send");
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(row).toContainText("Пробно: отказът е само записан — нищо не е изпратено към склада");
  await expect(page.getByTestId("shipments")).toContainText("Приета от склада");

  // The warehouse confirms the cancel (simulated vendor answer): shipment cancelled, order blocked.
  runWorker("confirm");
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("shipments")).toContainText("Отказана");
  await expect(page.getByTestId("warehouse-cancel-row-KCK-9101")).toHaveCount(0);
  await expect(page.getByTestId("timeline")).toContainText("Отказана в склада");
  await expect(page.getByTestId("timeline")).toContainText(
    "отказана в склада от E2E Отказ: sent_by_mistake: грешен склад",
  );
  const bar = page.getByRole("region", { name: "Решение за поръчката" });
  await expect(bar.getByRole("button", { name: "Откажи поръчката" })).toBeVisible();
  await bar.getByRole("button", { name: "Изпрати отново" }).click();
  await expect(page.getByRole("button", { name: "Изпрати отново" })).toHaveCount(0, { timeout: 60_000 });
  await page.screenshot({ path: "docs/screens/cancel-at-warehouse.png", fullPage: true });
});

test("Откажи поръчката: a blocked order without an active shipment is cancelled with a reason", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await login(page, OWNER);
  await openOrder(page, "#K-9102");
  const bar = page.getByRole("region", { name: "Решение за поръчката" });
  await bar.getByRole("button", { name: "Откажи поръчката" }).click();
  await expect(bar).toContainText("Поръчката се отказва в CRM (необратимо)");
  await bar.getByLabel("Причина").selectOption({ label: "Клиентът се отказа" });
  await bar.getByLabel("Разбирам, че това не може да се отмени.").check();
  await bar.getByRole("button", { name: "Потвърди: Откажи поръчката" }).click();
  await expect(page.getByText("Решението е записано.")).toBeVisible({ timeout: 60_000 });
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("is still open in Shopify")).toBeVisible();
  await expect(bar.getByRole("button", { name: "Откажи поръчката" })).toHaveCount(0);
});
