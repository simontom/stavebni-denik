import "server-only";

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { env } from "@/lib/env";

/**
 * Filesystem layout for daily-report photos:
 *
 *   {DATA_DIR}/photos/{projectId}/{reportId}/{uuid}.jpg          (main)
 *   {DATA_DIR}/photos/{projectId}/{reportId}/{uuid}.thumb.jpg    (thumbnail)
 *
 * Paths stored in the DB are RELATIVE to DATA_DIR. The serving route
 * resolves them through `resolvePhotoAbsolutePath`, which refuses
 * anything that escapes the root (defence-in-depth path-traversal
 * guard — even though IDs come from cuid + the FS layout, we never
 * trust DB strings blindly).
 */

const PHOTOS_SUBDIR = "photos";

export interface PhotoStoragePaths {
  pathOriginal: string;
  pathThumb: string;
}

export interface StoredPhoto extends PhotoStoragePaths {
  bytes: number;
}

/**
 * Write the main + thumb buffers to disk and return the relative paths
 * we want to persist in the `photos` table. Uses a fresh UUID per
 * upload so even simultaneous uploads of the same file don't collide.
 */
export async function writePhotoVariants(opts: {
  projectId: string;
  reportId: string;
  main: Buffer;
  thumb: Buffer;
}): Promise<StoredPhoto> {
  const { projectId, reportId, main, thumb } = opts;
  const id = randomUUID();
  const relDir = path.join(PHOTOS_SUBDIR, projectId, reportId);
  const absDir = path.join(env.dataDir, relDir);
  await fs.mkdir(absDir, { recursive: true });

  const fileMain = `${id}.jpg`;
  const fileThumb = `${id}.thumb.jpg`;
  await Promise.all([
    fs.writeFile(path.join(absDir, fileMain), main),
    fs.writeFile(path.join(absDir, fileThumb), thumb),
  ]);

  return {
    pathOriginal: path.join(relDir, fileMain),
    pathThumb: path.join(relDir, fileThumb),
    bytes: main.length,
  };
}

/**
 * Resolve a DB-stored relative path into an absolute path on disk,
 * refusing anything that escapes DATA_DIR. Returns `null` for a path
 * that resolves outside the root — the caller should treat that as a
 * 404.
 */
export function resolvePhotoAbsolutePath(relativePath: string): string | null {
  const root = path.resolve(env.dataDir);
  const abs = path.resolve(root, relativePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return null;
  }
  return abs;
}

/**
 * Best-effort removal of the on-disk files. Returns the number of files
 * actually deleted; missing files are tolerated (we may have crashed
 * mid-upload). Never throws — the DB row is the source of truth.
 */
export async function deletePhotoVariants(
  paths: PhotoStoragePaths,
): Promise<number> {
  let removed = 0;
  for (const rel of [paths.pathOriginal, paths.pathThumb]) {
    const abs = resolvePhotoAbsolutePath(rel);
    if (!abs) continue;
    try {
      await fs.unlink(abs);
      removed += 1;
    } catch {
      // ignore: file already gone or permissions changed
    }
  }
  return removed;
}
