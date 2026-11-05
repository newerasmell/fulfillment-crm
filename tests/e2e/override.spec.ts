import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

// Synthetic data only (tests/e2e/seed-override.ts): group "Тест група Пренасочване", connections "euShipments Основен"
// (selling company), "euShipments Сестра" (sister company, same line) and "euShipments Текстил" (another line, never
// offered); orders #P-9001 (not sent) and #P-9002 (sent to Основен). No worker runs during e2e:
// tools/e2e-override-worker.ts plays the sender with a mocked vendor.
const OWNER = {
  email: process.env.E2E_OVERRIDE_EMAIL ?? "",
  password: process.env.E2E_OVERRIDE_PASSWORD ?? "",
  totp: process.env.E2E_OVERRIDE_TOTP ?? "",
};

function runWorker() {
  execFileSync("pnpm", ["exec", "tsx", "tools/e2e-override-worker.ts"], {
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

test("Изпрати от: choose another warehouse of the line with a reason, approve and Fulfill go there", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await login(page, OWNER);
  await openOrder(page, "#P-9001");

  const chooser = page.getByRole("radiogroup", { name: "Изпрати от" });
  await expect(chooser).toBeVisible();
  await expect(chooser).not.toContainText("euShipments Текстил"); // another product line
  const main = page.getByTestId("warehouse-option-euShipments Основен");
  const sister = page.getByTestId("warehouse-option-euShipments Сестра");
  await expect(main).toContainText("избран");
  await expect(main).toContainText("наличност OK");
  await expect(sister).toContainText("↔ склад на друга фирма");
  await expect(sister).toContainText("нужни 2, налични 40");

  await sister.getByRole("radio").check();
  const form = page.getByRole("form", { name: "Потвърждение на склада" });
  await form.getByLabel("Причина").selectOption({ label: "По-бърза доставка" });
  await form.getByRole("button", { name: "Изпрати от този склад" }).click();
  await expect(page.getByTestId("manual-choice")).toContainText("Ръчен избор от E2E Пренасочване", {
    timeout: 60_000,
  });
  await expect(page.getByTestId("manual-choice")).toContainText("По-бърза доставка");
  await expect(page.getByTestId("review-routing")).toContainText("Ръчен избор");
  await expect(page.getByTestId("review-routing")).toContainText("euShipments Сестра");
  await expect(page.getByTestId("timeline")).toContainText("Избран склад (ръчно)");

  const bar = page.getByRole("region", { name: "Решение за поръчката" });
  await bar.getByRole("button", { name: "Одобри" }).click();
  await bar.getByRole("button", { name: "Потвърди: Одобри" }).click();
  await expect(page.getByRole("button", { name: "Изпълни", exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Изпълни", exact: true }).click();
  await expect(page.getByTestId("fulfill-row-#P-9001")).toContainText("В опашката", { timeout: 60_000 });

  await openOrder(page, "#P-9001");
  const shipments = page.getByTestId("shipments");
  await expect(shipments).toContainText("euShipments Сестра");
  await expect(shipments).not.toContainText("euShipments Основен");
  // Once queued, the warehouse can no longer be changed here.
  await expect(page.getByRole("form", { name: "Потвърждение на склада" })).toHaveCount(0);
});

test("Пренасочи: cancel at the old warehouse first; only after the confirmed cancel the order goes to the new one", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await login(page, OWNER);
  await openOrder(page, "#P-9002");

  await page.getByTestId("fold-shipments").locator("summary").click();
  await expect(page.getByTestId("shipments")).toContainText("Information received");
  await page.getByRole("button", { name: "Пренасочи към друг склад" }).click();
  const form = page.getByRole("form", { name: "Пренасочване" });
  await expect(form).toContainText("Едва когато складът потвърди отмяната");
  await expect(form).not.toContainText("euShipments Текстил");
  await form.getByTestId("warehouse-option-euShipments Сестра").getByRole("radio").check();
  await form.getByLabel("Причина").selectOption({ label: "Няма наличност" });
  await form.getByLabel("Разбирам: пратката в euShipments Основен ще бъде отменена.").check();
  await form.getByRole("button", { name: "Отмени и пренасочи" }).click();

  const open = page.getByTestId("reroute-open");
  await expect(open).toContainText(
    "Чака потвърждение на отмяната в euShipments Основен → euShipments Сестра",
    {
      timeout: 60_000,
    },
  );
  await expect(open).toContainText("PENDING");
  // Nothing changed yet: the order is still at the old warehouse.
  await expect(page.getByTestId("shipments")).toContainText("euShipments Основен");
  await expect(page.getByRole("button", { name: "Изпълни", exact: true })).toHaveCount(0);

  // The sender cancels (mocked vendor) and the sweep confirms the cancellation by read-back.
  runWorker();
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("reroute-open")).toHaveCount(0);
  await expect(page.getByTestId("reroute-history")).toContainText("пренасочена");
  await expect(page.getByTestId("manual-choice")).toContainText("Пренасочена след потвърдена отмяна");
  await expect(page.getByTestId("review-routing")).toContainText("euShipments Сестра");
  await expect(page.getByTestId("timeline")).toContainText("Поискано пренасочване");
  await expect(page.getByTestId("timeline")).toContainText("Пренасочена — отменена в стария склад");
  await expect(page.getByTestId("shipments")).toContainText("Отказана");

  await page.getByRole("button", { name: "Изпълни", exact: true }).click();
  await expect(page.getByTestId("fulfill-row-#P-9002")).toContainText("В опашката", { timeout: 60_000 });
  await openOrder(page, "#P-9002");
  await expect(page.getByTestId("shipments")).toContainText("euShipments Сестра");
});
