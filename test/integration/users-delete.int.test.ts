import { execSync } from "node:child_process";

import { PrismaPg } from "@prisma/adapter-pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";

/**
 * Integration test for `deleteUser` soft-delete service. Exercises
 * the three guards against a real Postgres + audit chain:
 *
 *   1. happy path — soft-delete sets deletedAt + isActive=false +
 *      revokes sessions + appends `user.delete` audit row,
 *   2. cannot delete self (operator's own id),
 *   3. cannot delete a user who is the active siteManager on any
 *      project (would orphan Project.siteManagerId).
 */

let container: StartedPostgreSqlContainer;
let db: PrismaClient;
let deleteUser: typeof import("@/server/services/users").deleteUser;
let CannotDeleteSelfError: typeof import("@/server/services/users").CannotDeleteSelfError;
let CannotDeleteSiteManagerError: typeof import("@/server/services/users").CannotDeleteSiteManagerError;

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
    deleteUser,
    CannotDeleteSelfError,
    CannotDeleteSiteManagerError,
  } = await import("@/server/services/users"));
});

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
});

async function createUserRow(nickname: string, role: "BOSS" | "WORKER" = "WORKER") {
  return db.user.create({
    data: {
      nickname,
      displayName: nickname,
      passwordHash: "x",
      role,
      isAdmin: false,
      ckaitNumber: role === "BOSS" ? "0000000" : null,
    },
  });
}

beforeEach(async () => {
  // Hermetické scénáře: tearing down rows in dependency order.
  // POZOR: audit_log se NESMÍ mazat — má DB trigger blokující DELETE
  // (append-only compliance). Audit řádky se hromadí mezi testy,
  // což nevadí — assertím konkrétní rows přes WHERE.
  await db.session.deleteMany({});
  await db.projectMember.deleteMany({});
  await db.dailyReport.deleteMany({});
  await db.project.deleteMany({});
  await db.user.deleteMany({});
});

describe("deleteUser — soft delete with guards", () => {
  it("soft-deletes the user (deletedAt + isActive=false) and revokes sessions", async () => {
    const actor = await createUserRow("actor-admin");
    const victim = await createUserRow("victim");
    const session = await db.session.create({
      data: { userId: victim.id, expiresAt: new Date(Date.now() + 60_000) },
    });

    await deleteUser(victim.id, {
      actor: { id: actor.id },
      ip: null,
      userAgent: "vitest",
    }, actor.id);

    const after = await db.user.findUniqueOrThrow({ where: { id: victim.id } });
    expect(after.deletedAt).not.toBeNull();
    expect(after.isActive).toBe(false);

    const sess = await db.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(sess.revokedAt).not.toBeNull();

    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: "user.delete", entityId: victim.id },
    });
    expect(audit.actorId).toBe(actor.id);
  });

  it("is idempotent — second call on the same id does nothing", async () => {
    const actor = await createUserRow("actor2");
    const victim = await createUserRow("victim2");
    const ctx = { actor: { id: actor.id }, ip: null, userAgent: "vitest" };

    await deleteUser(victim.id, ctx, actor.id);
    await deleteUser(victim.id, ctx, actor.id); // no-op

    const auditCount = await db.auditLog.count({
      where: { action: "user.delete", entityId: victim.id },
    });
    expect(auditCount).toBe(1);
  });

  it("throws CannotDeleteSelfError when actorId === userId", async () => {
    const actor = await createUserRow("self-deleter");

    await expect(
      deleteUser(actor.id, {
        actor: { id: actor.id },
        ip: null,
        userAgent: "vitest",
      }, actor.id),
    ).rejects.toBeInstanceOf(CannotDeleteSelfError);

    const stillThere = await db.user.findUniqueOrThrow({
      where: { id: actor.id },
    });
    expect(stillThere.deletedAt).toBeNull();
  });

  it("throws CannotDeleteSiteManagerError when user is active siteManager", async () => {
    const actor = await createUserRow("actor3");
    const sm = await createUserRow("active-boss", "BOSS");
    // Vytvořit aktivní zakázku, kde je sm stavbyvedoucím.
    await db.project.create({
      data: {
        name: "Zakázka X",
        address: "Adresa 1",
        cadastralArea: "Praha",
        parcelNumbers: "1/1",
        builder: "Builder",
        contractor: "Contractor",
        siteManagerId: sm.id,
        createdById: actor.id,
      },
    });

    await expect(
      deleteUser(sm.id, {
        actor: { id: actor.id },
        ip: null,
        userAgent: "vitest",
      }, actor.id),
    ).rejects.toBeInstanceOf(CannotDeleteSiteManagerError);

    // user stále existuje, není soft-deletovaný
    const stillThere = await db.user.findUniqueOrThrow({ where: { id: sm.id } });
    expect(stillThere.deletedAt).toBeNull();
  });

  it("allows deleting a BOSS whose only project was archived (deletedAt != null)", async () => {
    const actor = await createUserRow("actor4");
    const sm = await createUserRow("former-boss", "BOSS");
    // Archivovaná zakázka — neměla by blokovat smazání.
    await db.project.create({
      data: {
        name: "Stará zakázka",
        address: "Adresa 2",
        cadastralArea: "Praha",
        parcelNumbers: "2/2",
        builder: "Builder",
        contractor: "Contractor",
        siteManagerId: sm.id,
        createdById: actor.id,
        deletedAt: new Date(),
      },
    });

    await deleteUser(sm.id, {
      actor: { id: actor.id },
      ip: null,
      userAgent: "vitest",
    }, actor.id);

    const after = await db.user.findUniqueOrThrow({ where: { id: sm.id } });
    expect(after.deletedAt).not.toBeNull();
  });
});
