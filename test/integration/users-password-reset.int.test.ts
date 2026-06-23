import { execSync } from "node:child_process";

import { PrismaPg } from "@prisma/adapter-pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";

/**
 * Integration test for `resetUserPasswordByAdmin` proti reálnému
 * Postgresu. Verifies:
 *   - vygeneruje nové heslo (12+ znaků), uloží hash, set mustChangePwd
 *     a revokuje aktivní session,
 *   - audit row `user.password-reset` s actor=admin,
 *   - blokuje reset vlastního hesla (actor === target).
 *   - UserNotFoundError pro neexistujícího nebo soft-deletovaného.
 */

let container: StartedPostgreSqlContainer;
let db: PrismaClient;
let resetUserPasswordByAdmin: typeof import("@/server/services/users").resetUserPasswordByAdmin;
let UserNotFoundError: typeof import("@/server/services/users").UserNotFoundError;
let verifyPassword: typeof import("@/lib/crypto").verifyPassword;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;

  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });

  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  ({
    resetUserPasswordByAdmin,
    UserNotFoundError,
  } = await import("@/server/services/users"));
  ({ verifyPassword } = await import("@/lib/crypto"));
});

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
});

async function createUserRow(nickname: string) {
  return db.user.create({
    data: {
      nickname,
      displayName: nickname,
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$placeholder", // not used
      role: "WORKER",
      isAdmin: false,
    },
  });
}

beforeEach(async () => {
  await db.session.deleteMany({});
  await db.projectMember.deleteMany({});
  await db.project.deleteMany({});
  await db.user.deleteMany({});
});

describe("resetUserPasswordByAdmin", () => {
  const ctx = { actor: { id: "tester" }, ip: null, userAgent: "vitest" };

  it("generates new password, hashes it, sets mustChangePwd, revokes sessions", async () => {
    const admin = await createUserRow("admin-rp");
    const target = await createUserRow("target-rp");
    const session = await db.session.create({
      data: {
        userId: target.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const { generatedPassword } = await resetUserPasswordByAdmin(
      target.id,
      ctx,
      admin.id,
    );

    expect(generatedPassword.length).toBeGreaterThanOrEqual(12);

    const after = await db.user.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(await verifyPassword(generatedPassword, after.passwordHash)).toBe(true);
    expect(after.mustChangePwd).toBe(true);

    const sess = await db.session.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(sess.revokedAt).not.toBeNull();

    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: "user.password-reset", entityId: target.id },
    });
    expect(audit.actorId).toBe("tester");
  });

  it("refuses to reset own password (actor === target)", async () => {
    const admin = await createUserRow("self-reset");

    await expect(
      resetUserPasswordByAdmin(admin.id, ctx, admin.id),
    ).rejects.toThrow(/vlastního hesla/);
  });

  it("throws UserNotFoundError for missing or soft-deleted user", async () => {
    const admin = await createUserRow("admin-not-found");

    await expect(
      resetUserPasswordByAdmin("nonexistent-id", ctx, admin.id),
    ).rejects.toBeInstanceOf(UserNotFoundError);

    const deleted = await createUserRow("deleted-rp");
    await db.user.update({
      where: { id: deleted.id },
      data: { deletedAt: new Date() },
    });
    await expect(
      resetUserPasswordByAdmin(deleted.id, ctx, admin.id),
    ).rejects.toBeInstanceOf(UserNotFoundError);
  });
});
