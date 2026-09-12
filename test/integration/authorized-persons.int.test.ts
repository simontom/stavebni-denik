import { execSync } from "node:child_process";

import { PrismaPg } from "@prisma/adapter-pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import type { AuditContext } from "@/server/audit";

let container: StartedPostgreSqlContainer;
let db: PrismaClient;
let svc: typeof import("@/server/services/authorized-persons");

const ctx: AuditContext = {
  actor: { id: "boss1" },
  ip: "127.0.0.1",
  userAgent: "vitest-integration",
};

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;

  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });

  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  svc = await import("@/server/services/authorized-persons");

  // Seed project
  const boss = await db.user.create({
    data: {
      id: "boss1",
      nickname: "boss",
      displayName: "Boss",
      passwordHash: "x",
      role: "BOSS",
      isAdmin: true,
      mustChangePwd: false,
    },
  });

  await db.project.create({
    data: {
      id: "proj1",
      name: "Project 1",
      address: "Address",
      cadastralArea: "Area",
      parcelNumbers: "123",
      builder: "Builder",
      contractor: "Contractor",
      siteManagerId: boss.id,
    }
  });

}, 180_000);

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
});

describe("Authorized Persons", () => {
  it("adds an external person", async () => {
    const person = await svc.addExternalPerson(
      {
        projectId: "proj1",
        name: "John Doe",
        company: "ACME",
        authorization: "Auth123",
      },
      ctx,
    );
    expect(person.name).toBe("John Doe");
    expect(person.company).toBe("ACME");
    expect(person.authorization).toBe("Auth123");
    expect(person.linkedUserId).toBeNull();
    expect(person.revokedAt).toBeNull();
  });

  it("updates a person", async () => {
    const person = await svc.addExternalPerson(
      {
        projectId: "proj1",
        name: "Jane Doe",
      },
      ctx,
    );
    const updated = await svc.updatePerson(
      person.id,
      {
        name: "Jane Smith",
        company: "New Co",
      },
      ctx,
    );
    expect(updated.name).toBe("Jane Smith");
    expect(updated.company).toBe("New Co");
    expect(updated.authorization).toBeNull();
  });

  it("revokes a person without deleting", async () => {
    const person = await svc.addExternalPerson(
      {
        projectId: "proj1",
        name: "To Revoke",
      },
      ctx,
    );
    const revoked = await svc.revokePerson(person.id, ctx);
    expect(revoked.revokedAt).not.toBeNull();

    // Check DB that it wasn't hard deleted
    const inDb = await db.authorizedPerson.findUnique({
      where: { id: person.id },
    });
    expect(inDb).not.toBeNull();
    expect(inDb?.revokedAt).not.toBeNull();
  });

  it("syncSystemMember - add and remove", async () => {
    // Add user
    const user = await db.user.create({
      data: {
        id: "sysuser1",
        nickname: "sys1",
        displayName: "System User 1",
        passwordHash: "x",
        mustChangePwd: false,
      },
    });

    await db.$transaction(async (tx) => {
      await svc.syncSystemMember(tx, "proj1", user.id, "add");
    });

    let persons = await db.authorizedPerson.findMany({
      where: { projectId: "proj1", linkedUserId: user.id },
    });
    expect(persons).toHaveLength(1);
    expect(persons[0].name).toBe("System User 1");
    expect(persons[0].revokedAt).toBeNull();

    await db.$transaction(async (tx) => {
      await svc.syncSystemMember(tx, "proj1", user.id, "remove");
    });

    persons = await db.authorizedPerson.findMany({
      where: { projectId: "proj1", linkedUserId: user.id },
    });
    expect(persons).toHaveLength(1);
    expect(persons[0].revokedAt).not.toBeNull();
  });
});
