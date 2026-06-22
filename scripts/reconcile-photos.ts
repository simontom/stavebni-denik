/**
 * `pnpm reconcile:photos` — disk ↔ DB sweep for photo storage.
 *
 * Why: OOM kill, container restart or partial deploy can leave
 * `{DATA_DIR}/photos/...` and the `photos` table out of sync. This
 * script walks the disk and the table, prints a structured report
 * and (optionally) deletes orphan files.
 *
 * Usage:
 *   pnpm reconcile:photos                 # read-only human-readable report
 *   pnpm reconcile:photos --json          # machine-parseable single-line JSON
 *   pnpm reconcile:photos --delete-orphans  # also removes orphan files
 *
 * Exit codes:
 *   0  disk and DB agree (no orphans, no missing)
 *   1  drift detected (orphans or missing files)
 *   2  unexpected error (DB unreachable, etc.)
 *
 * Runs standalone (no Next.js boot) — safe to run from a Fly Machine
 * cron schedule or from `/admin` via a child_process call.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";
import {
  deleteOrphanFiles,
  reconcilePhotos,
  type ReconcileReport,
} from "../src/server/services/photos-reconcile";

interface CliFlags {
  json: boolean;
  deleteOrphans: boolean;
}

function parseFlags(argv: ReadonlyArray<string>): CliFlags {
  const flags: CliFlags = { json: false, deleteOrphans: false };
  for (const arg of argv) {
    if (arg === "--json") flags.json = true;
    else if (arg === "--delete-orphans") flags.deleteOrphans = true;
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }
  return flags;
}

function printUsage(): void {
  console.log(`Usage: pnpm reconcile:photos [--json] [--delete-orphans]

  --json             Single-line JSON output (for cron / log scraping).
  --delete-orphans   Remove orphan files older than the grace window.
                     Default is read-only (no mutation).

Exit codes:
  0  clean (no drift)
  1  drift detected
  2  unexpected error`);
}

function summariseHuman(report: ReconcileReport): string {
  const lines = [
    `[reconcile-photos] scanned at ${report.scannedAt.toISOString()}`,
    `  expected from DB : ${report.expectedFiles}`,
    `  found on disk    : ${report.foundFiles}`,
    `  orphan files     : ${report.orphanFiles.length}` +
      (report.orphanFiles.length === 0 ? " ✅" : " ⚠"),
    `  missing files    : ${report.missingFiles.length}` +
      (report.missingFiles.length === 0 ? " ✅" : " ⚠"),
    `  skipped (recent) : ${report.skippedRecentCount}`,
  ];
  if (report.orphanFiles.length > 0) {
    lines.push("  orphan list:");
    for (const f of report.orphanFiles) lines.push(`    - ${f}`);
  }
  if (report.missingFiles.length > 0) {
    lines.push("  missing list:");
    for (const f of report.missingFiles) lines.push(`    - ${f}`);
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL must be set.");
    return 2;
  }
  const dataDir = path.resolve(process.env.DATA_DIR ?? "./.dev-data");

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    // Pull EVERY photo row including soft-deleted ones — we keep
    // their files intentionally (legal evidence) and don't want the
    // reconcile to flag them as orphans.
    const photos = await prisma.photo.findMany({
      select: { pathOriginal: true, pathThumb: true },
    });
    const expected = new Set<string>();
    for (const p of photos) {
      expected.add(p.pathOriginal);
      expected.add(p.pathThumb);
    }

    const report = await reconcilePhotos({
      dataDir,
      expectedPaths: expected,
    });

    let deletedCount = 0;
    if (flags.deleteOrphans && report.orphanFiles.length > 0) {
      deletedCount = await deleteOrphanFiles({
        dataDir,
        orphanFiles: report.orphanFiles,
      });
    }

    // Persistent audit-friendly log next to audit-verify.log.
    await fs.mkdir(dataDir, { recursive: true });
    const logPath = path.join(dataDir, "reconcile-photos.log");
    await fs.appendFile(
      logPath,
      JSON.stringify({
        scannedAt: report.scannedAt.toISOString(),
        expectedFiles: report.expectedFiles,
        foundFiles: report.foundFiles,
        orphanFiles: report.orphanFiles.length,
        missingFiles: report.missingFiles.length,
        skippedRecent: report.skippedRecentCount,
        deletedOrphans: deletedCount,
        deleteFlag: flags.deleteOrphans,
      }) + "\n",
      "utf8",
    );

    if (flags.json) {
      console.log(
        JSON.stringify({
          scannedAt: report.scannedAt.toISOString(),
          expectedFiles: report.expectedFiles,
          foundFiles: report.foundFiles,
          orphanFiles: report.orphanFiles,
          missingFiles: report.missingFiles,
          skippedRecent: report.skippedRecentCount,
          deletedOrphans: deletedCount,
        }),
      );
    } else {
      console.log(summariseHuman(report));
      if (flags.deleteOrphans) {
        console.log(`  deleted orphans  : ${deletedCount}`);
      }
    }

    const drift =
      report.orphanFiles.length > 0 || report.missingFiles.length > 0;
    return drift ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[reconcile-photos] failed:", err);
    process.exit(2);
  });
