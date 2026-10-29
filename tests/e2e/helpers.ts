import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { generate } from "otplib";

export const OWNER = {
  email: process.env.E2E_OWNER_EMAIL ?? "",
  password: process.env.E2E_OWNER_PASSWORD ?? "",
  totp: process.env.E2E_OWNER_TOTP ?? "",
};

// The last used TOTP step is kept on disk: Playwright restarts its worker after a failure, and a code
// can only be used once per 30-second step (replay protection), so a fresh login may have to wait.
const STEP_FILE = "test-results/.e2e-last-totp-step";
const readStep = () => {
  try {
    return Number(readFileSync(STEP_FILE, "utf8")) || 0;
  } catch {
    return 0;
  }
};

export async function freshCode(secret: string) {
  for (;;) {
    const step = Math.floor(Date.now() / 30_000);
    if (step > readStep()) {
      mkdirSync("test-results", { recursive: true });
      writeFileSync(STEP_FILE, String(step));
      return generate({ secret });
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function login(page: Page, who = OWNER) {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(who.email);
  await page.locator('input[name="password"]').fill(who.password);
  await page.locator('input[name="code"]').fill(await freshCode(who.totp));
  await page.getByRole("button", { name: /Вход|Sign in/ }).click();
  await expect(page).toHaveURL("/");
}
