import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

/**
 * Playwright config for browser E2E tests.
 *
 * Runs against Vite React frontend on port 5173 with proxy to Ktor backend on port 8080.
 * In CI the suite is tuned to fail fast and leave evidence behind (list output,
 * HTML report, traces on failure) instead of silently running into the job timeout.
 */
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: path.resolve(__dirname, "e2e"),
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  maxFailures: isCI ? 3 : undefined,
  globalTimeout: isCI ? 10 * 60_000 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: isCI
    ? [["list"], ["github"], ["html", { open: "never" }], ["json", { outputFile: "playwright-report/results.json" }]]
    : "list",
  globalSetup: path.resolve(__dirname, "e2e/global-setup.ts"),
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:5173",
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: "pnpm --prefix frontend dev",
        url: "http://localhost:5173/login",
        reuseExistingServer: !isCI,
        timeout: 120_000,
        stdout: "pipe",
        stderr: "pipe",
      },
});
