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
export const ADMIN_PASSWORD = "E2E-Adm1n!Pass#2026";
export const WORKER_NICKNAME = "e2e-worker";

export default async function globalSetup(): Promise<void> {
  // Playwright globalSetup runs in plain Node (no Next.js env loader),
  // so we load .env ourselves. Node 20.6+ has process.loadEnvFile.
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile(path.resolve(__dirname, "..", ".env"));
    } catch {
      // .env optional — fall through to the error below
    }
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL must be set for E2E (docker compose up postgres + .env).",
    );
  }
  const root = path.resolve(__dirname, "..");
  execSync("pnpm exec tsx scripts/dev/e2e-prepare.ts", {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
}
