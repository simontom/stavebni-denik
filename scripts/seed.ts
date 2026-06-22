/**
 * One-shot seeder.
 *
 * Run via `pnpm tsx scripts/seed.ts` (or in production, `node` after
 * a build). Creates a single BOSS account using values from environment
 * variables — production seeds should never hard-code credentials.
 *
 * Required env:
 *   SEED_BOSS_NICKNAME      e.g. "admin"
 *   SEED_BOSS_DISPLAY_NAME  e.g. "Stavbyvedoucí"
 * Optional:
 *   SEED_BOSS_PASSWORD      explicit password; if missing one is generated.
 *   SEED_BOSS_CKAIT         ČKAIT autorization number.
 */
import { createHash } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";

import { Prisma, PrismaClient } from "../src/generated/prisma/client";
import { hashPassword } from "../src/lib/crypto";
import { generatePassword } from "../src/lib/password-gen";

const GENESIS_HASH = "0".repeat(64);

/** Mirrors `canonicalJSON` from `src/server/audit.ts`. */
function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}
function sha256Hex(input: string) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set.");
  }
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  const nickname = (process.env.SEED_BOSS_NICKNAME ?? "admin").toLowerCase();
  const displayName = process.env.SEED_BOSS_DISPLAY_NAME ?? "Stavbyvedoucí";
  const ckaitNumber = process.env.SEED_BOSS_CKAIT ?? null;

  const existing = await prisma.user.findUnique({ where: { nickname } });
  if (existing) {
    console.log(`[seed] BOSS user "${nickname}" already exists; nothing to do.`);
    await prisma.$disconnect();
    return;
  }

  const generatedPassword =
    process.env.SEED_BOSS_PASSWORD && process.env.SEED_BOSS_PASSWORD.length >= 12
      ? process.env.SEED_BOSS_PASSWORD
      : generatePassword();
  const passwordHash = await hashPassword(generatedPassword);

  // Create user + audit row atomically. Mirrors `withAudit()`'s logic
  // — bootstrap actions performed by the seeder still belong on the
  // hash chain so any future verifier sees a clean genesis.
  await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        nickname,
        displayName,
        role: "BOSS",
        passwordHash,
        ckaitNumber,
        // První seedovaný uživatel je VŽDY app-admin — jinak by
        // /admin nikdo neotevřel a aplikace by nešla rozjet.
        isAdmin: true,
        isActive: true,
        mustChangePwd: true,
      },
    });

    const tail = await tx.$queryRaw<Array<{ row_hash: string }>>`
      SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1 FOR UPDATE
    `;
    const prevHash = tail[0]?.row_hash ?? GENESIS_HASH;

    // The hashed `ts` MUST be the value we persist (see `withAudit`):
    // the verifier recomputes the hash from the stored `ts`, so relying
    // on the column's `DEFAULT CURRENT_TIMESTAMP` would break the chain
    // at the genesis row.
    const ts = new Date();
    const payload = {
      action: "user.create",
      entityType: "user",
      entityId: created.id,
      actorId: null, // bootstrap — no human actor.
      before: null,
      after: {
        id: created.id,
        nickname: created.nickname,
        displayName: created.displayName,
        role: created.role,
        ckaitNumber: created.ckaitNumber,
        isAdmin: created.isAdmin,
        isActive: created.isActive,
        mustChangePwd: created.mustChangePwd,
        createdAt: created.createdAt.toISOString(),
        createdById: created.createdById,
        deletedAt: created.deletedAt ? created.deletedAt.toISOString() : null,
      },
      ip: null,
      userAgent: "seed",
      prevHash,
      ts: ts.toISOString(),
    };
    const rowHash = sha256Hex(JSON.stringify(canonicalize(payload)));

    await tx.auditLog.create({
      data: {
        ts,
        actorId: null,
        action: payload.action,
        entityType: payload.entityType,
        entityId: payload.entityId,
        before: Prisma.JsonNull,
        after: payload.after as Prisma.InputJsonValue,
        ip: null,
        userAgent: "seed",
        prevHash,
        rowHash,
      },
    });
  });

  console.log("\n=== Seed complete ===");
  console.log(`Nickname: ${nickname}`);
  console.log(`Password: ${generatedPassword}`);
  console.log(
    "STORE THE PASSWORD SAFELY — it will be required on the first login.",
  );
  console.log("======================\n");

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
