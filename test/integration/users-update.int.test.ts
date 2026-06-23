import { execSync } from "node:child_process";

import { PrismaPg } from "@prisma/adapter-pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";

/**
 * Integration test for `updateUser` against a real Postgres + audit
 * chain. Verifies:
 *   - happy path: displayName/role/ckaitNumber/isAdmin změny landují
 *     v DB + audit row `user.update` se přidá,
 *   - no-op: pokud se nic nemění, audit row se nezakládá,
 *   - last-admin guard: posledního aktivního admina nelze demote-nout,
 *   - user-not-found pro neexistující nebo soft-deletovaný účet.
 */

let container: StartedPostgreSqlContainer;
let db: PrismaClient;
let updateUser: typeof import("@/server/services/users").updateUser;
let CannotRemoveLastAdminError: typeof import("@/server/services/users").CannotRemoveLastAdminError;
let UserNotFoundError: typeof import("@/server/services/users").UserNotFoundError;

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
    updateUser,
    CannotRemoveLastAdminError,
    UserNotFoundError,
  } = await import("@/server/services/users"));
});

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
});

async function createUserRow(opts: {
  nickname: string;
  role?: "BOSS" | "WORKER" | "GUEST";
  isAdmin?: boolean;
  ckaitNumber?: string | null;
}) {
  return db.user.create({
    data: {
      nickname: opts.nickname,
      displayName: opts.nickname,
      passwordHash: "x",
      role: opts.role ?? "WORKER",
      isAdmin: opts.isAdmin ?? false,
      ckaitNumber: opts.ckaitNumber ?? null,
    },
  });
}

beforeEach(async () => {
  // audit_log má append-only trigger, nemažeme. Ostatní tabulky jen.
  await db.session.deleteMany({});
  await db.projectMember.deleteMany({});
  await db.project.deleteMany({});
  await db.user.deleteMany({});
});

describe("updateUser", () => {
  const ctx = { actor: { id: "tester" }, ip: null, userAgent: "vitest" };

  it("updates fields + writes user.update audit row", async () => {
    const u = await createUserRow({ nickname: "u-edit-1" });

    await updateUser(
      u.id,
      {
        displayName: "Nové jméno",
        role: "BOSS",
        ckaitNumber: "1234567",
        isAdmin: true,
      },
      ctx,
    );

    const after = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(after.displayName).toBe("Nové jméno");
    expect(after.role).toBe("BOSS");
    expect(after.ckaitNumber).toBe("1234567");
    expect(after.isAdmin).toBe(true);

    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: "user.update", entityId: u.id },
    });
    expect(audit.actorId).toBe("tester");
  });

  it("is no-op when nothing changes — no audit row added", async () => {
    const u = await createUserRow({ nickname: "u-noop", role: "WORKER" });

    const auditBefore = await db.auditLog.count({
      where: { action: "user.update", entityId: u.id },
    });

    await updateUser(
      u.id,
      {
        displayName: u.displayName,
        role: u.role,
        ckaitNumber: u.ckaitNumber,
        isAdmin: u.isAdmin,
      },
      ctx,
    );

    const auditAfter = await db.auditLog.count({
      where: { action: "user.update", entityId: u.id },
    });
    expect(auditAfter).toBe(auditBefore);
  });

  it("CannotRemoveLastAdminError — refuses to demote the last active admin", async () => {
    const onlyAdmin = await createUserRow({
      nickname: "the-admin",
      isAdmin: true,
    });
    // Plus jeden další user, ale NE admin → onlyAdmin je poslední.
    await createUserRow({ nickname: "not-admin" });

    await expect(
      updateUser(
        onlyAdmin.id,
        {
          displayName: onlyAdmin.displayName,
          role: onlyAdmin.role,
          ckaitNumber: null,
          isAdmin: false, // pokus o demotion
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(CannotRemoveLastAdminError);

    const stillAdmin = await db.user.findUniqueOrThrow({
      where: { id: onlyAdmin.id },
    });
    expect(stillAdmin.isAdmin).toBe(true);
  });

  it("allows demoting an admin when another active admin exists", async () => {
    const a1 = await createUserRow({ nickname: "admin-1", isAdmin: true });
    await createUserRow({ nickname: "admin-2", isAdmin: true });

    await updateUser(
      a1.id,
      {
        displayName: a1.displayName,
        role: a1.role,
        ckaitNumber: null,
        isAdmin: false,
      },
      ctx,
    );

    const after = await db.user.findUniqueOrThrow({ where: { id: a1.id } });
    expect(after.isAdmin).toBe(false);
  });

  it("UserNotFoundError for missing or soft-deleted user", async () => {
    await expect(
      updateUser(
        "nonexistent-id",
        {
          displayName: "x",
          role: "WORKER",
          ckaitNumber: null,
          isAdmin: false,
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(UserNotFoundError);

    const deleted = await createUserRow({ nickname: "u-deleted" });
    await db.user.update({
      where: { id: deleted.id },
      data: { deletedAt: new Date() },
    });
    await expect(
      updateUser(
        deleted.id,
        {
          displayName: "x",
          role: "WORKER",
          ckaitNumber: null,
          isAdmin: false,
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(UserNotFoundError);
  });
});
