import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for browser smoke tests.
 *
 * Two modes:
 *   * Local — when `BASE_URL` is NOT set, we spawn `pnpm dev` and
 *     point Playwright at http://localhost:3000. The dev server needs
 *     a reachable Postgres (the project's `docker-compose.yml` covers
 *     this); the smoke specs themselves do NOT depend on any seeded
 *     user, so a fresh DB is fine.
 *   * Staging — set `BASE_URL=https://staging.example.com` (and seed a
 *     test BOSS account separately) to point the same specs at a
 *     remote instance from CI / a deploy pipeline.
 *
 * NOT wired into the default CI job — running the dev server in the
 * GitHub Actions container takes minutes and would need its own
 * Postgres + seed step. Add a dedicated workflow when there's a
 * staging deploy to point it at.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  // globalSetup používá Prisma napřímo k upsertu `e2e-admin` účtu se
  // známým heslem — specs ho pak používají v login flow bez závislosti
  // na seed scriptu.
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
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
        command: "pnpm dev",
        url: "http://localhost:3000/login",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
