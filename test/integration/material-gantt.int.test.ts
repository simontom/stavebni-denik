import { execSync } from "node:child_process";

import { PrismaPg } from "@prisma/adapter-pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";

/**
 * Integration test for `listMaterialsForProject` proti reálnému
 * Postgresu. Verifies:
 *   - vrací položky napříč všemi reporty zakázky,
 *   - filtruje soft-delete (material.deletedAt + report.deletedAt),
 *   - seřazené podle neededBy (asc, nulls last) + createdAt.
 */

let container: StartedPostgreSqlContainer;
let db: PrismaClient;
let listMaterialsForProject: typeof import("@/server/services/projects").listMaterialsForProject;

let userId: string;
let projectId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;

  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });

  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  ({ listMaterialsForProject } = await import("@/server/services/projects"));

  const u = await db.user.create({
    data: {
      nickname: "mg-actor",
      displayName: "Actor",
      passwordHash: "x",
      role: "BOSS",
      ckaitNumber: "0000001",
    },
  });
  userId = u.id;

  const p = await db.project.create({
    data: {
      name: "Materiál test",
      address: "Adresa 1",
      cadastralArea: "Praha",
      parcelNumbers: "1/1",
      builder: "Builder",
      contractor: "Contractor",
      siteManagerId: userId,
      createdById: userId,
    },
  });
  projectId = p.id;
});

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
});

async function makeReport(date: Date) {
  return db.dailyReport.create({
    data: {
      projectId,
      date,
      authorId: userId,
      createdById: userId,
      workersByTrade: [],
      workDescription: "Test",
      weather: { error: "n/a", fetchedAt: new Date().toISOString() },
    },
  });
}

beforeEach(async () => {
  // Reset all materials + reports před každým testem; user/project
  // zachováme (FK constraints).
  await db.materialNeed.deleteMany({});
  await db.dailyReport.deleteMany({});
});

describe("listMaterialsForProject", () => {
  it("returns all materials across reports sorted by neededBy asc, nulls last", async () => {
    const r1 = await makeReport(new Date("2026-06-20T00:00:00Z"));
    const r2 = await makeReport(new Date("2026-06-21T00:00:00Z"));

    await db.materialNeed.createMany({
      data: [
        // Bez termínu — má skončit poslední.
        { reportId: r1.id, text: "Cement", neededBy: null },
        // Datum 23. 6. 2026 — má být uprostřed.
        {
          reportId: r1.id,
          text: "Cihly",
          neededBy: new Date("2026-06-23T00:00:00Z"),
        },
        // Datum 22. 6. 2026 — má být první.
        {
          reportId: r2.id,
          text: "Beton",
          neededBy: new Date("2026-06-22T00:00:00Z"),
        },
      ],
    });

    const result = await listMaterialsForProject(projectId);
    expect(result.map((r) => r.text)).toEqual(["Beton", "Cihly", "Cement"]);

    // reportDate je z odpovídajícího DailyReport.date
    const beton = result.find((r) => r.text === "Beton")!;
    expect(beton.reportDate.toISOString().slice(0, 10)).toBe("2026-06-21");
  });

  it("excludes soft-deleted materials", async () => {
    const r = await makeReport(new Date("2026-06-20T00:00:00Z"));
    await db.materialNeed.createMany({
      data: [
        { reportId: r.id, text: "Aktivní" },
        { reportId: r.id, text: "Smazaná", deletedAt: new Date() },
      ],
    });

    const result = await listMaterialsForProject(projectId);
    expect(result.map((r) => r.text)).toEqual(["Aktivní"]);
  });

  it("excludes materials from soft-deleted reports", async () => {
    const r = await makeReport(new Date("2026-06-20T00:00:00Z"));
    await db.materialNeed.create({
      data: { reportId: r.id, text: "Z mrtvého reportu" },
    });
    await db.dailyReport.update({
      where: { id: r.id },
      data: { deletedAt: new Date() },
    });

    const result = await listMaterialsForProject(projectId);
    expect(result).toEqual([]);
  });

  it("returns empty array for project with no materials", async () => {
    await makeReport(new Date("2026-06-20T00:00:00Z"));
    const result = await listMaterialsForProject(projectId);
    expect(result).toEqual([]);
  });
});
