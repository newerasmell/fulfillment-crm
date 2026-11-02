import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// Synthetic data only (tests/e2e/seed-ai.ts): group "Тест група AI". The model transport was mocked in the seed;
// the server under test has no ANTHROPIC_API_KEY, so the AI must show as off (GATE P8-G1) — nothing calls Anthropic.
const AI_OWNER = {
  email: process.env.E2E_AI_EMAIL ?? "",
  password: process.env.E2E_AI_PASSWORD ?? "",
  totp: process.env.E2E_AI_TOTP ?? "",
};

test("AI assistant: visibly off without a key, suggestions on the order, one-click fixes, promotion, kill switch, audit, rules, log", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await login(page, AI_OWNER);

  // Dashboard: off without ANTHROPIC_API_KEY, promotion rule shown and satisfied for order approval.
  await page.goto("/ai");
  await expect(page.getByRole("heading", { name: "AI асистент", level: 1 })).toBeVisible({ timeout: 60_000 });
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("ai-status")).toContainText("AI е изключен: не е зададен ANTHROPIC_API_KEY");
  const approval = page.getByTestId("policy-order_approval");
  await expect(approval).toContainText("L0 · Сянка");
  await expect(approval).toContainText("≥ 300 сравнени решения (сега 300)");
  await expect(approval).toContainText("Условията са изпълнени");
  await approval.getByRole("button", { name: "Повиши до L1" }).click();
  await expect(approval.locator('[aria-current="step"]')).toHaveText("L1 · Асистент", { timeout: 30_000 });
  await expect(page.getByTestId("policy-address_fix").locator('[aria-current="step"]')).toHaveText(
    "L1 · Асистент",
  );

  // Kill switch: stop and start again (OWNER, audited).
  await page.getByRole("button", { name: "Спри AI за групата" }).click();
  await page.getByLabel("Причина (по желание)").fill("e2e проверка");
  await page
    .getByRole("group", { name: /Сигурни ли сте/ })
    .getByRole("button", { name: "Да" })
    .click();
  await expect(page.getByText("Спрян от")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Пусни AI отново" }).click();
  await page
    .getByRole("group", { name: /Пусни AI отново/ })
    .getByRole("button", { name: "Да" })
    .click();
  await expect(page.getByText("AI работи нормално за групата.")).toBeVisible({ timeout: 30_000 });

  // Order with a missing zip: the AI card proposes zip 1000; at L1 one click applies it (a person's edit).
  await page.goto("/orders?tab=all");
  await page.getByRole("link", { name: "#AI-8001", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Поръчка #AI-8001", level: 1 })).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForLoadState("networkidle");
  const card = page.getByTestId("ai-card");
  await expect(card).toContainText("Коригирай и одобри");
  await expect(card).toContainText("Увереност 88");
  await expect(card).toContainText("Пощенски код");
  await expect(card).toContainText("1000");
  await expect(card).toContainText("AI е изключен (няма ANTHROPIC_API_KEY).");
  await expect(card.getByRole("button", { name: "Поискай AI преглед" })).toHaveCount(0);
  await card.getByRole("button", { name: "Приложи корекциите на AI" }).click();
  await expect(card.getByText("Корекциите са приложени и поръчката е проверена отново.")).toBeVisible({
    timeout: 60_000,
  });
  await page.reload();
  await expect(page.getByTestId("ai-card")).toContainText("Поръчката е променена след предложението", {
    timeout: 60_000,
  });
  await expect(page.getByTestId("address-view")).toContainText("1000");
  await expect(page.getByText("Липсва пощенски код.")).toHaveCount(0);

  // Clean order: an APPROVE suggestion, nothing approved by the AI at L1.
  await page.goto("/orders?tab=all");
  await page.getByRole("link", { name: "#AI-8002", exact: true }).click();
  await expect(page.getByTestId("ai-card")).toContainText("Одобри · Увереност 97", { timeout: 60_000 });
  await expect(page.getByTestId("ai-card")).toContainText("Чиста поръчка");

  // Daily audit sample of autopilot approvals: confirm it.
  await page.goto("/ai?tab=audit");
  const row = page.getByTestId("audit-row").filter({ hasText: "#AI-8003" });
  await expect(row).toContainText("Чака", { timeout: 60_000 });
  await page.waitForLoadState("networkidle");
  await row.getByRole("button", { name: "Потвърди" }).click();
  await expect(row).toContainText("Потвърдено", { timeout: 30_000 });

  // Rule mining: the HU phone prefix proposal; accepting records it for a developer.
  await page.goto("/ai?tab=rules");
  const proposal = page.getByTestId("proposal").filter({ hasText: "HU: телефони, започващи с 06 → +36" });
  await expect(proposal).toContainText("5 корекции в 5 поръчки", { timeout: 60_000 });
  await page.waitForLoadState("networkidle");
  await proposal.getByText("Задание за разработчик").click();
  await expect(proposal.locator("pre")).toContainText("Validator proposal: HU: phones starting 06 → +36");
  await proposal.getByRole("button", { name: "Приеми" }).click();
  await expect(proposal).toContainText("Прието", { timeout: 30_000 });

  // Full prompt/response log (admin): the strict tool request is there.
  await page.goto("/ai?tab=log");
  const log = page.getByTestId("ai-log-row").first();
  await expect(log).toContainText("успешно", { timeout: 60_000 });
  await page.waitForLoadState("networkidle");
  await log.getByRole("button", { name: "Покажи заявка и отговор" }).click();
  await expect(log.locator("pre").first()).toContainText('"submit_review"', { timeout: 30_000 });
  await expect(log.locator("pre").first()).toContainText('"strict": true');

  // The audit log recorded the owner's AI changes.
  await page.goto("/settings/audit");
  await expect(page.getByText("ai.kill_switch.on").first()).toBeVisible({ timeout: 60_000 });
});
