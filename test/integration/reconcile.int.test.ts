import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import {
  deleteOrphanFiles,
  reconcilePhotos,
} from "@/server/services/photos-reconcile";

/**
 * Reconcile sweep against a real Postgres + real DATA_DIR. Proves
 * that the script wiring — `prisma.photo.findMany` → `Set` →
 * `reconcilePhotos(disk root, set)` → categories — produces the
 * expected report when reality drifts from the DB (OOM, partial
 * deploy, manual `rm`).
 */

let container: StartedPostgreSqlContainer;
let db: PrismaClient;
let dataDir: string;
let projectId: string;
let reportId: string;
let bossId: string;

async function seedPhoto(rel: { main: string; thumb: string }): Promise<string> {
  const row = await db.photo.create({
    data: {
      reportId,
      pathOriginal: rel.main,
      pathThumb: rel.thumb,
      width: 100,
      height: 100,
      bytes: 1234,
      uploadedById: bossId,
    },
    select: { id: true },
  });
  return row.id;
}

async function writeFile(rel: string, ageMs = 60 * 60 * 1000): Promise<void> {
  const abs = path.join(dataDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, Buffer.from("jpeg-bytes"));
  const past = new Date(Date.now() - ageMs);
  await fs.utimes(abs, past, past);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;

  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });

  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  dataDir = await mkdtemp(path.join(tmpdir(), "stavebni-denik-reconcile-int-"));

  const boss = await db.user.create({
    data: {
      nickname: "boss-reconcile",
      displayName: "Boss",
      passwordHash: "x",
      role: "BOSS",
      ckaitNumber: "0000000",
    },
  });
  bossId = boss.id;

  const project = await db.project.create({
    data: {
      name: "Reconcile project",
      address: "Test 1, Praha",
      cadastralArea: "Praha-Vinohrady",
      parcelNumbers: "123/4",
      builder: "Test Builder s.r.o.",
      contractor: "Test Contractor s.r.o.",
      siteManagerId: bossId,
      createdById: bossId,
      members: { create: { userId: bossId, role: "BOSS" } },
    },
  });
  projectId = project.id;

  const report = await db.dailyReport.create({
    data: {
      projectId,
      date: new Date("2026-06-22T00:00:00Z"),
      authorId: bossId,
      createdById: bossId,
      workersByTrade: [],
      workDescription: "Test",
      weather: { error: "n/a", fetchedAt: new Date().toISOString() },
    },
  });
  reportId = report.id;
});

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

async function buildExpectedFromDb(): Promise<Set<string>> {
  const rows = await db.photo.findMany({
    select: { pathOriginal: true, pathThumb: true },
  });
  const out = new Set<string>();
  for (const r of rows) {
    out.add(r.pathOriginal);
    out.add(r.pathThumb);
  }
  return out;
}

describe("reconcilePhotos against a real DB + disk", () => {
  it("flags an OOM-orphan (file on disk, no DB row) and the inverse (DB row, no file)", async () => {
    // Clean disk + DB for a hermetic scenario.
    await db.photo.deleteMany({});
    await rm(dataDir, { recursive: true, force: true });
    await fs.mkdir(dataDir, { recursive: true });

    // Happy pair — file + row present.
    const okMain = `photos/${projectId}/${reportId}/ok.jpg`;
    const okThumb = `photos/${projectId}/${reportId}/ok.thumb.jpg`;
    await writeFile(okMain);
    await writeFile(okThumb);
    await seedPhoto({ main: okMain, thumb: okThumb });

    // Orphan files (OOM kill before withAudit commit).
    const orphanMain = `photos/${projectId}/${reportId}/orphan.jpg`;
    const orphanThumb = `photos/${projectId}/${reportId}/orphan.thumb.jpg`;
    await writeFile(orphanMain);
    await writeFile(orphanThumb);

    // Missing files (rm by mistake on /data).
    const missingMain = `photos/${projectId}/${reportId}/missing.jpg`;
    const missingThumb = `photos/${projectId}/${reportId}/missing.thumb.jpg`;
    await seedPhoto({ main: missingMain, thumb: missingThumb });

    const expected = await buildExpectedFromDb();
    const report = await reconcilePhotos({ dataDir, expectedPaths: expected });

    expect(report.foundFiles).toBe(4);
    expect(report.expectedFiles).toBe(4);
    expect(report.orphanFiles).toEqual([orphanMain, orphanThumb].sort());
    expect(report.missingFiles).toEqual([missingMain, missingThumb].sort());
    expect(report.skippedRecentCount).toBe(0);
  });

  it("keeps soft-deleted photos in the expected set (legal evidence stays on disk)", async () => {
    await db.photo.deleteMany({});
    await rm(dataDir, { recursive: true, force: true });
    await fs.mkdir(dataDir, { recursive: true });

    const aliveMain = `photos/${projectId}/${reportId}/alive.jpg`;
    const aliveThumb = `photos/${projectId}/${reportId}/alive.thumb.jpg`;
    await writeFile(aliveMain);
    await writeFile(aliveThumb);
    await seedPhoto({ main: aliveMain, thumb: aliveThumb });

    const deletedMain = `photos/${projectId}/${reportId}/dead.jpg`;
    const deletedThumb = `photos/${projectId}/${reportId}/dead.thumb.jpg`;
    await writeFile(deletedMain);
    await writeFile(deletedThumb);
    const deletedId = await seedPhoto({ main: deletedMain, thumb: deletedThumb });
    await db.photo.update({
      where: { id: deletedId },
      data: { deletedAt: new Date() },
    });

    const expected = await buildExpectedFromDb();
    const report = await reconcilePhotos({ dataDir, expectedPaths: expected });

    expect(report.orphanFiles).toEqual([]);
    expect(report.missingFiles).toEqual([]);
  });

  it("--delete-orphans removes only orphan files (and not anything in DB)", async () => {
    await db.photo.deleteMany({});
    await rm(dataDir, { recursive: true, force: true });
    await fs.mkdir(dataDir, { recursive: true });

    const keepMain = `photos/${projectId}/${reportId}/keep.jpg`;
    await writeFile(keepMain);
    await seedPhoto({
      main: keepMain,
      thumb: `photos/${projectId}/${reportId}/keep.thumb.jpg`,
    });
    // keep.thumb.jpg deliberately NOT on disk → missing, not orphan.

    const orphanMain = `photos/${projectId}/${reportId}/orphan.jpg`;
    await writeFile(orphanMain);

    const expected = await buildExpectedFromDb();
    const report = await reconcilePhotos({ dataDir, expectedPaths: expected });
    expect(report.orphanFiles).toEqual([orphanMain]);

    const removed = await deleteOrphanFiles({
      dataDir,
      orphanFiles: report.orphanFiles,
    });
    expect(removed).toBe(1);

    // Orphan gone, keep file still there, DB-listed-but-missing thumb
    // is still missing (we don't fabricate files, only delete orphans).
    await expect(
      fs.access(path.join(dataDir, orphanMain)),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(dataDir, keepMain)),
    ).resolves.toBeUndefined();
  });
});
