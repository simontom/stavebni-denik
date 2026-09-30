import { execSync } from "node:child_process";
import path from "node:path";

/**
 * Playwright globalSetup — běží JEDNOU před celou test sadou.
 *
 * Upsertne `e2e-admin` účet s deterministickým heslem. Protože
 * Playwright runuje v CommonJS modu a Prisma 7 ESM client používá
 * `import.meta.url`, nelze ho importovat napřímo — místo toho
 * spustíme tsx skript jako child proces, který ESM rozumí.
 */

export const ADMIN_NICKNAME = "e2e-admin";
export const ADMIN_PASSWORD = "Password123!";
export const WORKER_NICKNAME = "e2e-worker";
export const INVESTOR_NICKNAME = "e2e-investor";
export const INVESTOR_PASSWORD = "Password123!";

export default async function globalSetup(): Promise<void> {
  // Playwright globalSetup runs in plain Node (no Next.js env loader),
  // so we load .env ourselves. Node 20.6+ has process.loadEnvFile.
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
