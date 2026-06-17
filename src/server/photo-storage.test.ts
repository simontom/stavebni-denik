import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deletePhotoVariants,
  resolvePhotoAbsolutePath,
  writePhotoVariants,
} from "./photo-storage";

/**
 * Storage layer for daily-report photos. We exercise the FS layout
 * helpers in a per-test temp directory so the production /data volume
 * is never touched.
 */

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "stavebni-denik-photos-"));
  process.env.DATA_DIR = tmp;
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await rm(tmp, { recursive: true, force: true });
});

describe("writePhotoVariants", () => {
  it("writes both variants under photos/{project}/{report} and returns relative paths", async () => {
    const projectId = "proj1";
    const reportId = "rep1";
    const main = Buffer.from("main-content");
    const thumb = Buffer.from("thumb");

    const stored = await writePhotoVariants({
      projectId,
      reportId,
      main,
      thumb,
    });

    expect(stored.pathOriginal.startsWith(`photos/${projectId}/${reportId}/`)).toBe(true);
    expect(stored.pathThumb.startsWith(`photos/${projectId}/${reportId}/`)).toBe(true);
    expect(stored.bytes).toBe(main.length);

    // Files are actually on disk.
    const absMain = path.join(tmp, stored.pathOriginal);
    const absThumb = path.join(tmp, stored.pathThumb);
    expect((await fs.readFile(absMain)).toString()).toBe("main-content");
    expect((await fs.readFile(absThumb)).toString()).toBe("thumb");
  });

  it("creates a fresh uuid per call so concurrent uploads do not collide", async () => {
    const a = await writePhotoVariants({
      projectId: "p",
      reportId: "r",
      main: Buffer.from("a"),
      thumb: Buffer.from("a"),
    });
    const b = await writePhotoVariants({
      projectId: "p",
      reportId: "r",
      main: Buffer.from("b"),
      thumb: Buffer.from("b"),
    });
    expect(a.pathOriginal).not.toBe(b.pathOriginal);
    expect(a.pathThumb).not.toBe(b.pathThumb);
  });
});

describe("resolvePhotoAbsolutePath", () => {
  it("returns the absolute path for a valid relative path", () => {
    const abs = resolvePhotoAbsolutePath("photos/p/r/x.jpg");
    expect(abs).toBe(path.resolve(tmp, "photos/p/r/x.jpg"));
  });

  it("refuses path-traversal escapes outside DATA_DIR", () => {
    expect(resolvePhotoAbsolutePath("../escape.jpg")).toBeNull();
    expect(resolvePhotoAbsolutePath("photos/../../escape.jpg")).toBeNull();
    expect(resolvePhotoAbsolutePath("/etc/passwd")).toBeNull();
  });
});

describe("deletePhotoVariants", () => {
  it("removes both files and tolerates missing ones", async () => {
    const stored = await writePhotoVariants({
      projectId: "p",
      reportId: "r",
      main: Buffer.from("m"),
      thumb: Buffer.from("t"),
    });
    expect(
      await deletePhotoVariants({
        pathOriginal: stored.pathOriginal,
        pathThumb: stored.pathThumb,
      }),
    ).toBe(2);

    // Calling again silently succeeds (idempotent best-effort).
    expect(
      await deletePhotoVariants({
        pathOriginal: stored.pathOriginal,
        pathThumb: stored.pathThumb,
      }),
    ).toBe(0);
  });
});
