import { execSync } from "node:child_process";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { pragueDayStart } from "@/lib/dates";

let container: StartedPostgreSqlContainer;
let db: PrismaClient;
let getProjectExportForUser: typeof import("@/server/services/reports").getProjectExportForUser;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;

  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });

  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  
  const mod = await import("@/server/services/reports");
  getProjectExportForUser = mod.getProjectExportForUser;
});

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
});

beforeEach(async () => {
  await db.dailyReport?.deleteMany({});
  await db.projectMember?.deleteMany({});
  await db.project?.deleteMany({});
  await db.user?.deleteMany({});
});

describe("getProjectExportForUser - Legislative fields mapping", () => {
  it("should return the new legislative fields (sequenceNumber, isControlDay, constructionObj, acknowledgedByName)", async () => {
    const boss = await db.user.create({
      data: {
        nickname: "boss", displayName: "Boss", passwordHash: "x", role: "BOSS"
      }
    });

    const investor = await db.user.create({
      data: {
        nickname: "inv", displayName: "Inv", passwordHash: "x", role: "INVESTOR"
      }
    });

    const project = await db.project.create({
      data: {
        name: "Test", address: "A", cadastralArea: "C", parcelNumbers: "1", builder: "B", contractor: "C",
        siteManagerId: boss.id,
        contractNumber: "SML-2026-01",
        contractDate: new Date("2026-01-01T00:00:00Z"),
        designDocVersion: "v1.2",
        designDocDate: new Date("2026-02-01T00:00:00Z"),
      }
    });

    await db.projectMember.createMany({
      data: [
        { projectId: project.id, userId: boss.id, role: "BOSS" },
        { projectId: project.id, userId: investor.id, role: "INVESTOR" }
      ]
    });

    await db.dailyReport.create({
      data: {
        projectId: project.id,
        date: pragueDayStart(new Date("2026-05-15T00:00:00Z")),
        sequenceNumber: 42,
        isControlDay: true,
        constructionObj: "SO 101",
        authorId: boss.id,
        createdById: boss.id,
        workDescription: "Prace",
        workersByTrade: [],
        weather: {},
        acknowledgedById: investor.id,
        acknowledgedAt: new Date(),
      }
    });

    const userMock = {
      id: boss.id,
      nickname: "boss",
      displayName: "Boss",
      role: "BOSS" as const,
      isAdmin: false,
      mustChangePwd: false,
      sessionId: "s",
    };

    const exportData = await getProjectExportForUser({
      projectId: project.id,
      user: userMock,
      from: null,
      to: null
    });

    expect(exportData).not.toBeNull();
    expect(exportData?.days).toHaveLength(1);

    const day = exportData!.days[0]!;
    expect(day.sequenceNumber).toBe(42);
    expect(day.isControlDay).toBe(true);
    expect(day.constructionObj).toBe("SO 101");
    expect(day.acknowledgedByName).toBe("Inv");
  });
});
