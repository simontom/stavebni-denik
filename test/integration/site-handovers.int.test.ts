import { PrismaPg } from "@prisma/adapter-pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";

let container: StartedPostgreSqlContainer;
let db: PrismaClient;
let createHandover: any;
let updateHandover: any;
let deleteHandover: any;
let signHandover: any;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;

  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });

  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  
  const mod = await import("@/server/services/site-handovers");
  createHandover = mod.createHandover;
  updateHandover = mod.updateHandover;
  deleteHandover = mod.deleteHandover;
  signHandover = mod.signHandover;
});

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
});

beforeEach(async () => {
  await db.siteHandover?.deleteMany({});
  await db.projectMember.deleteMany({});
  await db.project.deleteMany({});
  await db.user.deleteMany({});
});

describe("Site Handovers", () => {
  async function createScenario() {
    const boss = await db.user.create({
      data: {
        nickname: "boss",
        displayName: "Boss",
        passwordHash: "x",
        role: "BOSS",
        ckaitNumber: "0000001",
      },
    });
    const worker = await db.user.create({
      data: {
        nickname: "worker",
        displayName: "Worker",
        passwordHash: "x",
        role: "WORKER",
      },
    });
    const project = await db.project.create({
      data: {
        name: "Project",
        address: "Test",
        cadastralArea: "Test",
        parcelNumbers: "1",
        builder: "Builder",
        contractor: "Contract",
        siteManagerId: boss.id,
      },
    });
    await db.projectMember.createMany({
      data: [
        { projectId: project.id, userId: boss.id, role: "BOSS" },
        { projectId: project.id, userId: worker.id, role: "WORKER" },
      ],
    });
    return { boss, worker, project };
  }

  it("creates a handover", async () => {
    const s = await createScenario();
    const data = {
      type: "handover",
      date: new Date("2026-06-23T10:00:00Z"),
      participants: "John, Jane",
      meterStates: { gas: 100 },
      notes: "Test note",
    };
    const handover = await createHandover(s.project.id, s.boss.id, data);
    expect(handover.id).toBeTruthy();
    expect(handover.projectId).toBe(s.project.id);
    expect(handover.type).toBe("handover");
  });

  it("updates a handover", async () => {
    const s = await createScenario();
    const data = {
      type: "handover",
      date: new Date(),
      participants: "John",
    };
    const handover = await createHandover(s.project.id, s.boss.id, data);
    const updated = await updateHandover(handover.id, s.boss.id, { notes: "Updated" });
    expect(updated.notes).toBe("Updated");
  });

  it("soft-deletes a handover", async () => {
    const s = await createScenario();
    const handover = await createHandover(s.project.id, s.boss.id, {
      type: "handover",
      date: new Date(),
      participants: "John",
    });
    await deleteHandover(handover.id, s.boss.id);
    const inDb = await db.siteHandover.findUnique({ where: { id: handover.id } });
    expect(inDb?.deletedAt).not.toBeNull();
  });

  it("signs a handover by BOSS", async () => {
    const s = await createScenario();
    const handover = await createHandover(s.project.id, s.boss.id, {
      type: "handover",
      date: new Date(),
      participants: "John",
    });
    const signed = await signHandover(handover.id, s.boss.id);
    expect(signed.signedAt).not.toBeNull();
  });

  it("prevents signing a handover by WORKER", async () => {
    const s = await createScenario();
    const handover = await createHandover(s.project.id, s.worker.id, {
      type: "handover",
      date: new Date(),
      participants: "John",
    });
    await expect(signHandover(handover.id, s.worker.id)).rejects.toThrow();
  });
});
