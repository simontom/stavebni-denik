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

/** The specs that run in the phone project (and only there). */
const MOBILE_SPECS = /mobile-[^/\\]*\.spec\.ts$/;

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
  reporter: isCI ? [["list"], ["github"], ["html", { open: "never" }], ["json", { outputFile: "playwright-report/results.json" }]] : "list",
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
      // The specs named mobile-*.spec.ts are for the phone project below.
      testIgnore: MOBILE_SPECS,
    },
    {
      // A phone: 360 x 780 CSS px (a small Android), touch, mobile viewport. Only the mobile-*.spec.ts specs run here: they
      // visit the pages with realistic data and check that nothing scrolls sideways and the primary controls can be reached.
      name: "mobile",
      testMatch: MOBILE_SPECS,
      use: {
        ...devices["Pixel 5"],
        viewport: { width: 360, height: 780 },
        screen: { width: 360, height: 780 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      // The same phone held sideways: 780 x 360. It is wider than the 640 px of `sm`, so a layout that decides by width alone
      // would take it for a desktop; it still has a finger, which is what the touch rules (16 px text, 44 px controls) follow.
      name: "mobile-landscape",
      testMatch: MOBILE_SPECS,
      use: {
        ...devices["Pixel 5"],
        viewport: { width: 780, height: 360 },
        screen: { width: 780, height: 360 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
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
