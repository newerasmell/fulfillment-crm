import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const DEV = process.env.E2E_DEV === "1";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000, // a cold dev server compiles each route on first use
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", locale: "bg-BG" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
  // Default: a production build (`next build` + `next start`), like Render. The dev server compiles routes on
  // first use and, under load, full-reloads the login page in a loop. E2E_DEV=1 uses `next dev` for quick runs.
  webServer: {
    command: DEV ? `pnpm exec next dev --port ${PORT}` : `pnpm exec next build && pnpm exec next start --port ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: DEV ? 180_000 : 600_000,
    env: {
      DATABASE_URL: process.env.E2E_DATABASE_URL ?? "",
      NODE_ENV: DEV ? "development" : "production",
      AUTH_URL: `http://localhost:${PORT}`,
    },
  },
});
