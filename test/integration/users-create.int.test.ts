import { execSync } from "node:child_process";

import { PrismaPg } from "@prisma/adapter-pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { verifyPassword } from "@/lib/crypto";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/server/rbac", async () => {
  const permissions =
    await vi.importActual<typeof import("@/server/permissions")>("@/server/permissions");
  return {
    ...permissions,
    requireUser: vi.fn().mockResolvedValue({
      id: "tester",
      nickname: "admin",
      displayName: "Admin Tester",
      role: "BOSS",
      isAdmin: true,
      mustChangePwd: false,
      sessionId: "sess-test",
    }),
    requireAdmin: vi.fn().mockResolvedValue({
      id: "tester",
      nickname: "admin",
      displayName: "Admin Tester",
      role: "BOSS",
      isAdmin: true,
      mustChangePwd: false,
      sessionId: "sess-test",
    }),
    requireBoss: vi.fn().mockResolvedValue({
      id: "tester",
      nickname: "admin",
      displayName: "Admin Tester",
      role: "BOSS",
      isAdmin: true,
      mustChangePwd: false,
      sessionId: "sess-test",
    }),
    requireRole: vi.fn(),
  };
});

vi.mock("@/server/audit-context", () => ({
  getAuditContext: vi.fn().mockResolvedValue({
    actor: { id: "tester" },
    ip: null,
    userAgent: "vitest",
  }),
}));

let container: StartedPostgreSqlContainer;
let db: PrismaClient;
let createUser: typeof import("@/server/services/users").createUser;
let NicknameInUseError: typeof import("@/server/services/users").NicknameInUseError;
let createUserAction: typeof import("@/app/(app)/admin/users/actions").createUserAction;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;

  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });

  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  ({ createUser, NicknameInUseError } = await import("@/server/services/users"));
  ({ createUserAction } = await import("@/app/(app)/admin/users/actions"));
});

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
});

beforeEach(async () => {
  await db.session.deleteMany({});
  await db.projectMember.deleteMany({});
  await db.dailyReport.deleteMany({});
  await db.project.deleteMany({});
  await db.user.deleteMany({});
});

describe("createUser service", () => {
  it("creates user and writes audit log", async () => {
    const res = await createUser(
      {
        nickname: "svc-user",
        displayName: "Svc User",
        role: "WORKER",
        isAdmin: false,
      },
      { actor: { id: "tester" }, ip: null, userAgent: "vitest" },
      "tester",
    );

    expect(res.nickname).toBe("svc-user");
    expect(res.generatedPassword).toBeDefined();

    const user = await db.user.findUniqueOrThrow({ where: { nickname: "svc-user" } });
    expect(user.displayName).toBe("Svc User");
    expect(await verifyPassword(res.generatedPassword, user.passwordHash)).toBe(true);
  });

  it("throws NicknameInUseError if nickname is already taken", async () => {
    await createUser(
      {
        nickname: "dup-user",
        displayName: "Dup User",
        role: "WORKER",
        isAdmin: false,
      },
      { actor: { id: "tester" }, ip: null, userAgent: "vitest" },
      "tester",
    );

    await expect(
      createUser(
        {
          nickname: "dup-user",
          displayName: "Dup User 2",
          role: "WORKER",
          isAdmin: false,
        },
        { actor: { id: "tester" }, ip: null, userAgent: "vitest" },
        "tester",
      ),
    ).rejects.toBeInstanceOf(NicknameInUseError);
  });
});

describe("createUserAction safe action", () => {
  it("creates user via safe action object input", async () => {
    const result = await createUserAction({
      nickname: "action-user",
      displayName: "Action User",
      role: "WORKER",
    });

    expect(result?.data?.generatedPassword).toBeDefined();
    expect(result?.data?.nickname).toBe("action-user");
    expect(result?.data?.displayName).toBe("Action User");
    expect(result?.data?.role).toBe("WORKER");

    const created = await db.user.findUniqueOrThrow({ where: { nickname: "action-user" } });
    expect(created.isActive).toBe(true);
    expect(result?.data).toBeDefined();
    expect(await verifyPassword(result!.data!.generatedPassword, created.passwordHash)).toBe(true);

    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: "user.create", entityId: created.id },
    });
    expect(audit.actorId).toBe("tester");
  });

  it("creates BOSS user with ckaitNumber and isAdmin", async () => {
    const result = await createUserAction({
      nickname: "boss-user",
      displayName: "Boss User",
      role: "BOSS",
      ckaitNumber: "1234567",
      isAdmin: true,
    });

    expect(result?.data?.generatedPassword).toBeDefined();

    const created = await db.user.findUniqueOrThrow({ where: { nickname: "boss-user" } });
    expect(created.role).toBe("BOSS");
    expect(created.ckaitNumber).toBe("1234567");
    expect(created.isAdmin).toBe(true);
  });

  it("returns validation error on invalid input", async () => {
    const result = await createUserAction({
      nickname: "AB", // min 3 chars
      displayName: "",
      // @ts-expect-error - testing invalid input schema
      role: "INVALID",
    });

    expect(result?.validationErrors).toBeDefined();
    expect(result?.data).toBeUndefined();
  });

  it("maps unique constraint violation (duplicate nickname) to serverError", async () => {
    // First user creation succeeds
    const first = await createUserAction({
      nickname: "unique-check",
      displayName: "First User",
      role: "WORKER",
    });
    expect(first?.data?.id).toBeDefined();

    // Second user with same nickname fails with serverError
    const duplicate = await createUserAction({
      nickname: "unique-check",
      displayName: "Second User",
      role: "WORKER",
    });

    expect(duplicate?.serverError).toBeDefined();
    expect(duplicate?.data).toBeUndefined();
  });
});
