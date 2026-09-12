/**
 * E2E preparer — upsertne `e2e-admin` účet s deterministickým heslem
 * a smaže předchozí `e2e-worker`. Voláno přes execSync z Playwright
 * globalSetup.
 *
 * Run:
 *   pnpm exec tsx scripts/dev/e2e-prepare.ts
 */
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client";
import { hashPassword } from "../../src/lib/crypto";

const ADMIN_NICKNAME = "e2e-admin";
const ADMIN_PASSWORD = "test1234";
const WORKER_NICKNAME = "e2e-worker";
const INVESTOR_NICKNAME = "e2e-investor";
const INVESTOR_PASSWORD = "test1234";

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
    const investorHash = await hashPassword(INVESTOR_PASSWORD);
    await prisma.user.upsert({
      where: { nickname: INVESTOR_NICKNAME },
      create: {
        nickname: INVESTOR_NICKNAME,
        displayName: "E2E Investor",
        passwordHash: investorHash,
        role: "INVESTOR",
        isAdmin: false,
        isActive: true,
        mustChangePwd: false,
      },
      update: {
        passwordHash: investorHash,
        role: "INVESTOR",
        isActive: true,
        mustChangePwd: false,
        deletedAt: null,
      },
    });
    await prisma.user.deleteMany({
      where: { nickname: { in: [WORKER_NICKNAME] } },
    });
    console.log("[e2e-prepare] OK — admin & investor upsertnuti, worker cleanup");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[e2e-prepare] failed:", err);
  process.exit(1);
});
