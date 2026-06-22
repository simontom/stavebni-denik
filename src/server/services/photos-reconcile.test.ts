import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PHOTOS_SUBDIR,
  deleteOrphanFiles,
  reconcilePhotos,
} from "./photos-reconcile";

let tmp: string;
const FIXED_NOW = new Date("2026-06-22T10:00:00.000Z");

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "stavebni-denik-reconcile-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writePhoto(
  rel: string,
  ageMs = 60 * 60 * 1000,
): Promise<void> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, Buffer.from("jpeg-bytes"));
  const past = new Date(FIXED_NOW.getTime() - ageMs);
  await fs.utimes(abs, past, past);
}

describe("reconcilePhotos", () => {
  it("returns empty report when the photos dir does not exist yet", async () => {
    const report = await reconcilePhotos({
      dataDir: tmp,
      expectedPaths: new Set(),
      now: () => FIXED_NOW,
    });
    expect(report.expectedFiles).toBe(0);
    expect(report.foundFiles).toBe(0);
    expect(report.orphanFiles).toEqual([]);
    expect(report.missingFiles).toEqual([]);
    expect(report.skippedRecentCount).toBe(0);
  });

  it("detects orphan files older than the grace window", async () => {
    await writePhoto("photos/proj1/rep1/a.jpg");
    await writePhoto("photos/proj1/rep1/a.thumb.jpg");
    await writePhoto("photos/proj1/rep1/orphan.jpg");
    await writePhoto("photos/proj1/rep1/orphan.thumb.jpg");

    const report = await reconcilePhotos({
      dataDir: tmp,
      expectedPaths: new Set([
        "photos/proj1/rep1/a.jpg",
        "photos/proj1/rep1/a.thumb.jpg",
      ]),
      now: () => FIXED_NOW,
    });
    expect(report.foundFiles).toBe(4);
    expect(report.expectedFiles).toBe(2);
    expect(report.orphanFiles).toEqual([
      "photos/proj1/rep1/orphan.jpg",
      "photos/proj1/rep1/orphan.thumb.jpg",
    ]);
    expect(report.missingFiles).toEqual([]);
    expect(report.skippedRecentCount).toBe(0);
  });

  it("detects missing files (DB row, no file on disk)", async () => {
    await writePhoto("photos/proj1/rep1/a.jpg");
    await writePhoto("photos/proj1/rep1/a.thumb.jpg");

    const report = await reconcilePhotos({
      dataDir: tmp,
      expectedPaths: new Set([
        "photos/proj1/rep1/a.jpg",
        "photos/proj1/rep1/a.thumb.jpg",
        "photos/proj1/rep1/gone.jpg",
        "photos/proj1/rep1/gone.thumb.jpg",
      ]),
      now: () => FIXED_NOW,
    });
    expect(report.orphanFiles).toEqual([]);
    expect(report.missingFiles).toEqual([
      "photos/proj1/rep1/gone.jpg",
      "photos/proj1/rep1/gone.thumb.jpg",
    ]);
  });

  it("skips files newer than the grace window (in-flight upload race)", async () => {
    // 'fresh' was just written (10 s ago), older than 5 min counts.
    await writePhoto("photos/proj1/rep1/fresh.jpg", 10 * 1000);
    await writePhoto("photos/proj1/rep1/fresh.thumb.jpg", 10 * 1000);
    await writePhoto("photos/proj1/rep1/old-orphan.jpg", 10 * 60 * 1000);

    const report = await reconcilePhotos({
      dataDir: tmp,
      expectedPaths: new Set(),
      graceMs: 5 * 60 * 1000,
      now: () => FIXED_NOW,
    });
    expect(report.orphanFiles).toEqual(["photos/proj1/rep1/old-orphan.jpg"]);
    expect(report.skippedRecentCount).toBe(2);
  });

  it("walks multiple project / report subdirectories", async () => {
    await writePhoto("photos/projA/rep1/a.jpg");
    await writePhoto("photos/projA/rep2/b.jpg");
    await writePhoto("photos/projB/rep3/c.jpg");

    const report = await reconcilePhotos({
      dataDir: tmp,
      expectedPaths: new Set([
        "photos/projA/rep1/a.jpg",
        "photos/projA/rep2/b.jpg",
      ]),
      now: () => FIXED_NOW,
    });
    expect(report.foundFiles).toBe(3);
    expect(report.orphanFiles).toEqual(["photos/projB/rep3/c.jpg"]);
  });

  it("ignores non-jpeg files in the photos dir (defence-in-depth)", async () => {
    await writePhoto("photos/proj1/rep1/a.jpg");
    // Random junk file that shouldn't be there but isn't ours to
    // delete either.
    const junk = path.join(tmp, "photos/proj1/rep1/notes.txt");
    await fs.writeFile(junk, "noise");

    const report = await reconcilePhotos({
      dataDir: tmp,
      expectedPaths: new Set(["photos/proj1/rep1/a.jpg"]),
      now: () => FIXED_NOW,
    });
    expect(report.foundFiles).toBe(1);
    expect(report.orphanFiles).toEqual([]);
  });

  it("emits a clean (empty) report when disk == DB", async () => {
    await writePhoto("photos/proj1/rep1/a.jpg");
    await writePhoto("photos/proj1/rep1/a.thumb.jpg");

    const report = await reconcilePhotos({
      dataDir: tmp,
      expectedPaths: new Set([
        "photos/proj1/rep1/a.jpg",
        "photos/proj1/rep1/a.thumb.jpg",
      ]),
      now: () => FIXED_NOW,
    });
    expect(report.orphanFiles).toEqual([]);
    expect(report.missingFiles).toEqual([]);
    expect(report.skippedRecentCount).toBe(0);
  });
});

describe("deleteOrphanFiles", () => {
  it("removes only the supplied files and tolerates already-missing ones", async () => {
    await writePhoto("photos/proj1/rep1/a.jpg");
    await writePhoto("photos/proj1/rep1/b.jpg");

    const removed = await deleteOrphanFiles({
      dataDir: tmp,
      orphanFiles: [
        "photos/proj1/rep1/a.jpg",
        "photos/proj1/rep1/missing.jpg",
      ],
    });
    expect(removed).toBe(1);

    await expect(
      fs.access(path.join(tmp, "photos/proj1/rep1/a.jpg")),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(tmp, "photos/proj1/rep1/b.jpg")),
    ).resolves.toBeUndefined();
  });

  it("refuses paths that escape DATA_DIR", async () => {
    await writePhoto("photos/proj1/rep1/a.jpg");
    const removed = await deleteOrphanFiles({
      dataDir: tmp,
      orphanFiles: ["../escape.jpg", "/etc/passwd"],
    });
    expect(removed).toBe(0);
    await expect(
      fs.access(path.join(tmp, "photos/proj1/rep1/a.jpg")),
    ).resolves.toBeUndefined();
  });
});

describe("PHOTOS_SUBDIR", () => {
  it("matches the storage layout used by photo-storage.ts", () => {
    expect(PHOTOS_SUBDIR).toBe("photos");
  });
});
