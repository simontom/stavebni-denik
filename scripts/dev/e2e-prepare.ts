/**
 * E2E preparer — upsertne `e2e-admin` účet s deterministickým heslem
 * a smaže předchozí `e2e-worker`. Voláno přes execSync z Playwright
 * globalSetup.
 *
 * Run:
 *   pnpm exec tsx --env-file=.env scripts/dev/e2e-prepare.ts
 */
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client";
import { hashPassword } from "../../src/lib/crypto";

const ADMIN_NICKNAME = "e2e-admin";
const ADMIN_PASSWORD = "E2E-Adm1n!Pass#2026";
const WORKER_NICKNAME = "e2e-worker";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  try {
    const passwordHash = await hashPassword(ADMIN_PASSWORD);
    await prisma.user.upsert({
      where: { nickname: ADMIN_NICKNAME },
      create: {
        nickname: ADMIN_NICKNAME,
        displayName: "E2E Admin",
        passwordHash,
        role: "BOSS",
        ckaitNumber: "0000000",
        isAdmin: true,
        isActive: true,
        mustChangePwd: false,
      },
      update: {
        passwordHash,
        isAdmin: true,
        isActive: true,
        mustChangePwd: false,
        deletedAt: null,
      },
    });
    await prisma.user.deleteMany({
      where: { nickname: { in: [WORKER_NICKNAME] } },
    });
    console.log("[e2e-prepare] OK — admin upsertnut, worker cleanup");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[e2e-prepare] failed:", err);
  process.exit(1);
});
