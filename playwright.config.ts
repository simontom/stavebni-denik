import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

/**
 * Playwright config for browser E2E tests.
 *
 * Runs against Vite React frontend on port 5173 with proxy to Ktor backend on port 8080.
 */
export default defineConfig({
  testDir: path.resolve(__dirname, "e2e"),
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  globalSetup: path.resolve(__dirname, "e2e/global-setup.ts"),
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:5173",
    trace: "on-first-retry",
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
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
