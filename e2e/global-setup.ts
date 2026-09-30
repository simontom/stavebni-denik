import { execSync } from "node:child_process";
import path from "node:path";

/**
 * Playwright globalSetup — běží JEDNOU před celou test sadou.
 *
 * Upsertne E2E účty (`e2e-admin`, `e2e-investor`, …) s deterministickým
 * heslem přímo do PostgreSQL 18 (schéma vytváří Flyway v Kotlin backendu,
 * backend proto musí běžet). Seed běží jako tsx child proces s timeoutem.
 */

export const ADMIN_NICKNAME = "e2e-admin";
export const ADMIN_PASSWORD = "Password123!";
export const WORKER_NICKNAME = "e2e-worker";
export const INVESTOR_NICKNAME = "e2e-investor";
export const INVESTOR_PASSWORD = "Password123!";

export default async function globalSetup(): Promise<void> {
  // Playwright globalSetup runs in plain Node, so we load .env ourselves.
  // Node 20.6+ has process.loadEnvFile.
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile(path.resolve(__dirname, "..", ".env"));
    } catch {
      // .env optional — fall through to the fallback below
    }
  }

  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = "postgresql://denik:denik_dev@localhost:5432/stavebni_denik";
  }
  const root = path.resolve(__dirname, "..");
  execSync("pnpm exec tsx scripts/dev/e2e-prepare.ts", {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    timeout: 60_000,
  });
}
