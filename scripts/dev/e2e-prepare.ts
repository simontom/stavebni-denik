/**
 * E2E preparer — seeds test users with valid UUIDs into PostgreSQL
 * and cleans up previous test workers. Called via execSync from Playwright
 * globalSetup.
 *
 * The schema is owned by the Kotlin backend (Flyway migrations), so the
 * backend must have started once against the database before this runs.
 *
 * Run:
 *   pnpm exec tsx scripts/dev/e2e-prepare.ts
 */
import { hash } from "@node-rs/argon2";
import { Client } from "pg";

import { assertLocalDatabase } from "./local-db-guard";

/** Same Argon2id parameters as the backend (PasswordService.kt: t=2, m=64 MiB, p=1). */
async function hashPassword(plain: string): Promise<string> {
  return hash(plain, {
    algorithm: 2, // Algorithm.Argon2id (ambient const enum, see @node-rs/argon2)
    timeCost: 2,
    memoryCost: 65_536,
    parallelism: 1,
  });
}

export const ADMIN_NICKNAME = "e2e-admin";
export const ADMIN_PASSWORD = "Password123!";
export const WORKER_NICKNAME = "e2e-worker";
export const INVESTOR_NICKNAME = "e2e-investor";
export const INVESTOR_PASSWORD = "Password123!";

export const ADMIN_UUID = "11111111-1111-1111-1111-111111111111";
export const INVESTOR_UUID = "22222222-2222-2222-2222-222222222222";

async function getPgClient(): Promise<Client> {
  const envUrl = process.env.DATABASE_URL;
  const urlsToTry: string[] = [];

  if (envUrl) {
    // This script resets known admin accounts and deletes users: never run it
    // against anything but a database on this machine.
    assertLocalDatabase(envUrl);
    urlsToTry.push(envUrl);
  }
  urlsToTry.push("postgresql://denik:denik_dev@localhost:5432/stavebni_denik");
  urlsToTry.push("postgresql://postgres:devpassword@localhost:5432/stavebni_denik");

  let lastError: unknown = null;
  for (const url of urlsToTry) {
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      return client;
    } catch (err) {
      lastError = err;
      try {
        await client.end();
      } catch {
        // ignore
      }
    }
  }
  throw lastError || new Error("Failed to connect to PostgreSQL");
}

async function main(): Promise<void> {
  const client = await getPgClient();

  try {
    const adminHash = await hashPassword(ADMIN_PASSWORD);
    const investorHash = await hashPassword(INVESTOR_PASSWORD);

    const usersToSeed = [
      {
        id: ADMIN_UUID,
        nickname: ADMIN_NICKNAME,
        displayName: "E2E Admin",
        passwordHash: adminHash,
        role: "BOSS",
        ckaitNumber: "0000000",
        isAdmin: true,
      },
      {
        id: INVESTOR_UUID,
        nickname: INVESTOR_NICKNAME,
        displayName: "E2E Investor",
        passwordHash: investorHash,
        role: "INVESTOR",
        ckaitNumber: null,
        isAdmin: false,
      },
      {
        id: "33333333-3333-3333-3333-333333333333",
        nickname: "admin@stavebni-denik.cz",
        displayName: "Admin Stavební Deník",
        passwordHash: adminHash,
        role: "BOSS",
        ckaitNumber: "1111111",
        isAdmin: true,
      },
      {
        id: "44444444-4444-4444-4444-444444444444",
        nickname: "manager@stavebni-denik.cz",
        displayName: "Manager Stavební Deník",
        passwordHash: adminHash,
        role: "BOSS",
        ckaitNumber: "2222222",
        isAdmin: false,
      },
      {
        id: "55555555-5555-5555-5555-555555555555",
        nickname: "worker@stavebni-denik.cz",
        displayName: "Worker Stavební Deník",
        passwordHash: adminHash,
        role: "WORKER",
        ckaitNumber: null,
        isAdmin: false,
      },
    ];

    for (const u of usersToSeed) {
      await client.query(
        `INSERT INTO users (
          "id", "nickname", "displayName", "passwordHash", "role",
          "ckaitNumber", "isAdmin", "isActive", "mustChangePwd",
          "createdAt", "updatedAt"
        ) VALUES (
          $1::uuid, $2, $3, $4, $5::"Role",
          $6, $7, true, false,
          NOW(), NOW()
        ) ON CONFLICT ("nickname") DO UPDATE SET
          "displayName" = EXCLUDED."displayName",
          "passwordHash" = EXCLUDED."passwordHash",
          "role" = EXCLUDED."role",
          "ckaitNumber" = EXCLUDED."ckaitNumber",
          "isAdmin" = EXCLUDED."isAdmin",
          "isActive" = true,
          "mustChangePwd" = false,
          "deletedAt" = NULL,
          "updatedAt" = NOW()`,
        [u.id, u.nickname, u.displayName, u.passwordHash, u.role, u.ckaitNumber, u.isAdmin],
      );
    }

    // Clean up temporary test worker accounts
    await client.query(`DELETE FROM users WHERE "nickname" LIKE 'e2e-worker%' OR "nickname" = $1`, [WORKER_NICKNAME]);

    console.log("[e2e-prepare] OK — seeded users with valid UUIDs into PostgreSQL");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[e2e-prepare] failed:", err);
  process.exit(1);
});
