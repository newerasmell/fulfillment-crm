import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", locale: "bg-BG" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: `pnpm exec next dev --port ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { DATABASE_URL: process.env.E2E_DATABASE_URL ?? "", NODE_ENV: "development" },
  },
});
