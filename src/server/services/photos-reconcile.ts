import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";

/**
 * Disk ↔ DB reconcile for photo storage.
 *
 * NOTE: záměrně BEZ `import "server-only"` — tahle utilita běží
 * mimo Next.js runtime jako standalone `pnpm reconcile:photos`
 * skript (přes tsx). Žádné secrets, žádný DB klient — jen FS +
 * path manipulace, takže import z client kódu nemá smysl, ale ani
 * by neunikla žádná citlivá data.
 *
 * Why: OOM kill, hard crash or partial deploy can leave the disk and
 * the `photos` table out of sync. Two pathological states:
 *
 *   1. **Orphan files** — present on disk but no DB row. Typically
 *      `writePhotoVariants` succeeded and then `withAudit` aborted
 *      (constraint, OOM mid-transaction, container restart). Those
 *      files just leak `/data` quota forever.
 *
 *   2. **Missing files** — DB row points at `photos/.../uuid.jpg`
 *      but the file isn't there. This usually means somebody removed
 *      `/data` manually (or the volume was restored without the
 *      `data/` payload). Symptom: 404 on the photo serve route.
 *
 * The reconcile pass produces a structured report; the caller
 * decides whether to log, delete orphans, raise an alarm.
 * GRACE WINDOW: a file written in the last `graceMs` milliseconds is
 * NOT classified as orphan — an upload may be racing the reconcile
 * (we write to disk BEFORE we insert the row). 5 min is plenty even
 * for slow uploads on bad LTE.
 *
 * Soft-deleted photos count as expected on disk: keeping their
 * files is intentional (legal evidence under Vyhláška 499/2006 —
 * the addendum to a daily report can reference the original).
 * Caller must pass `Photo` rows INCLUDING `deletedAt IS NOT NULL`.
 */

export const PHOTOS_SUBDIR = "photos";
export const DEFAULT_GRACE_MS = 5 * 60 * 1000;

export interface ReconcileReport {
  /** Relative paths the DB expects (`pathOriginal` + `pathThumb`). */
  expectedFiles: number;
  /** Relative paths actually walked on disk under `{dataDir}/photos`. */
  foundFiles: number;
  /** On disk, NOT in DB. Excludes recent files (< graceMs old). */
  orphanFiles: string[];
  /** In DB, NOT on disk. */
  missingFiles: string[];
  /** Files we saw but skipped because they are still in the grace window. */
  skippedRecentCount: number;
  /** Wall-clock time at the start of the scan. */
  scannedAt: Date;
}

export interface ReconcileOptions {
  /** Absolute path of `DATA_DIR` (i.e. `env.dataDir`). */
  dataDir: string;
  /**
   * Set of relative paths the DB knows about (e.g.
   * `"photos/proj/rep/abc.jpg"`). Pre-fetched by the caller so this
   * helper stays pure / unit-testable without Prisma.
   */
  expectedPaths: ReadonlySet<string>;
  /** Default 5 min — set to 0 in tests for deterministic output. */
  graceMs?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

/**
 * Walk `{dataDir}/photos/**` and reconcile against the supplied set
 * of expected relative paths. Returns a structured report; no
 * deletions, no DB writes.
 */
export async function reconcilePhotos(
  opts: ReconcileOptions,
): Promise<ReconcileReport> {
  const { dataDir, expectedPaths } = opts;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const now = opts.now ?? (() => new Date());
  const scannedAt = now();
  const recentThresholdMs = scannedAt.getTime() - graceMs;

  const root = path.resolve(dataDir, PHOTOS_SUBDIR);
  const absFound = await walkJpegs(root);

  const foundRelative = new Set<string>(
    absFound.map((abs) => path.relative(dataDir, abs).replace(/\\/g, "/")),
  );

  // Orphans: on disk, missing in DB. Skip recent files so an
  // upload that has just written its files but not yet committed
  // the row is not mistakenly classified.
  const orphans: string[] = [];
  let skippedRecent = 0;
  for (const rel of foundRelative) {
    if (expectedPaths.has(rel)) continue;
    const abs = path.join(dataDir, rel);
    let mtimeMs: number;
    try {
      const stat = await fs.stat(abs);
      mtimeMs = stat.mtimeMs;
    } catch {
      // Disappeared between readdir and stat — race condition;
      // safest to ignore (don't claim orphanness for a ghost).
      continue;
    }
    if (mtimeMs > recentThresholdMs) {
      skippedRecent += 1;
      continue;
    }
    orphans.push(rel);
  }

  // Missing: in DB, no file on disk.
  const missing: string[] = [];
  for (const rel of expectedPaths) {
    if (!foundRelative.has(rel)) missing.push(rel);
  }

  return {
    expectedFiles: expectedPaths.size,
    foundFiles: foundRelative.size,
    orphanFiles: orphans.sort(),
    missingFiles: missing.sort(),
    skippedRecentCount: skippedRecent,
    scannedAt,
  };
}

/**
 * Delete the supplied orphan files (best-effort). Never throws on a
 * missing file — by the time we get here the disk state may have
 * shifted again. Returns the number of files actually removed.
 *
 * Caller is responsible for path resolution being safe; this helper
 * REFUSES anything that resolves outside `dataDir` as a
 * defence-in-depth guard against malformed reports.
 */
export async function deleteOrphanFiles(opts: {
  dataDir: string;
  orphanFiles: ReadonlyArray<string>;
}): Promise<number> {
  const { dataDir, orphanFiles } = opts;
  const root = path.resolve(dataDir);
  let removed = 0;
  for (const rel of orphanFiles) {
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;
    try {
      await fs.unlink(abs);
      removed += 1;
    } catch {
      // gone / permission — ignore, the reconcile is best-effort
    }
  }
  return removed;
}

async function walkJpegs(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  const out: string[] = [];
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await walkJpegs(full)));
    } else if (ent.isFile() && isJpeg(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

function isJpeg(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".jpg") || lower.endsWith(".jpeg");
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
