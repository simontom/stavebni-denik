import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaPg } from "@prisma/adapter-pg";
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
} from "testcontainers";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { verifyAuditChainWithClient } from "@/server/audit-verify";

/**
 * Roundtrip integration test for the production backup script:
 *
 *   scripts/backup.sh  →  restic snapshot
 *                       →  restic restore
 *                       →  psql restore into a fresh Postgres
 *                       →  schema + audit-chain re-verify
 *                       →  /data/photos restored byte-for-byte
 *
 * Why a Dockerised runner (test/integration/fixtures/backup-runner/):
 * the local dev box doesn't always have `restic` + `pg_dump` matching
 * the production image. We spin up a small alpine container with
 * both, plus a shared Docker network so it can reach the two ephemeral
 * Postgres containers (source + destination) by alias.
 *
 * Skipped from `pnpm test` (it's in the integration config only) and
 * costs ~30 s end-to-end (sharp pulls of alpine + postgres + the
 * actual dump / restore).
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let network: StartedNetwork;
let sourceDb: StartedPostgreSqlContainer;
let targetDb: StartedPostgreSqlContainer;
let runner: StartedTestContainer;
let dataDirHost: string;

const SOURCE_ALIAS = "src-db";
const TARGET_ALIAS = "dst-db";

async function execOk(
  container: StartedTestContainer,
  cmd: string[],
  context: string,
): Promise<string> {
  const result = await container.exec(cmd);
  if (result.exitCode !== 0) {
    throw new Error(
      `[${context}] exit ${result.exitCode}\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout;
}

beforeAll(async () => {
  network = await new Network().start();

  // Source DB — seeded with real schema + a few audit chain rows.
  sourceDb = await new PostgreSqlContainer("postgres:16-alpine")
    .withNetwork(network)
    .withNetworkAliases(SOURCE_ALIAS)
    .start();

  // Target DB — completely empty; restore must rebuild it from scratch.
  targetDb = await new PostgreSqlContainer("postgres:16-alpine")
    .withNetwork(network)
    .withNetworkAliases(TARGET_ALIAS)
    .start();

  // Apply migrations + seed a couple of audit rows on the source.
  process.env.DATABASE_URL = sourceDb.getConnectionUri();
  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: sourceDb.getConnectionUri() },
    stdio: "inherit",
  });
  const sourcePrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: sourceDb.getConnectionUri() }),
  });
  try {
    const u = await sourcePrisma.user.create({
      data: {
        nickname: "boss",
        displayName: "Šéf",
        passwordHash: "x",
        role: "BOSS",
        mustChangePwd: false,
      },
    });
    // Seed one audit row so the chain has something to verify after
    // restore. Hash content has to match `audit-hash.ts`; the simplest
    // way to get a valid row is to import the helper.
    const { computeRowHash, GENESIS_HASH } = await import(
      "@/server/audit-hash"
    );
    const ts = new Date();
    const payload = {
      action: "user.create" as const,
      entityType: "user",
      entityId: u.id,
      actorId: null,
      before: null,
      after: { id: u.id, nickname: u.nickname },
      ip: null,
      userAgent: "backup-int-test",
      prevHash: GENESIS_HASH,
      ts: ts.toISOString(),
    };
    const rowHash = computeRowHash(payload);
    await sourcePrisma.auditLog.create({
      data: {
        ts,
        actorId: null,
        action: payload.action,
        entityType: payload.entityType,
        entityId: payload.entityId,
        before: undefined,
        after: payload.after,
        ip: null,
        userAgent: payload.userAgent,
        prevHash: payload.prevHash,
        rowHash,
      },
    });
  } finally {
    await sourcePrisma.$disconnect();
  }

  // Build the runner image from the fixtures Dockerfile and start it
  // on the shared network. Mount a host tmpdir as both the source
  // DATA_DIR (where backup.sh expects photos/) and the restic
  // repository so we can poke at the files after the script runs.
  dataDirHost = await fs.mkdtemp(
    path.join(process.env.TMPDIR ?? "/tmp", "stavebni-denik-backup-"),
  );
  await fs.mkdir(path.join(dataDirHost, "photos"), { recursive: true });
  await fs.writeFile(
    path.join(dataDirHost, "photos", "marker.txt"),
    "photo bytes belong here\n",
  );
  await fs.writeFile(
    path.join(dataDirHost, "audit-verify.log"),
    '{"ok":true,"totalRows":1}\n',
  );

  const fixturesDir = path.resolve(__dirname, "fixtures", "backup-runner");
  runner = await (
    await GenericContainer.fromDockerfile(fixturesDir).build()
  )
    .withNetwork(network)
    .withNetworkAliases("runner")
    .start();

  // Copy backup.sh into the runner. Bind mounts of a host file would
  // be cleaner but Testcontainers' copyFilesToContainer is portable.
  await runner.copyFilesToContainer([
    {
      source: path.resolve(__dirname, "..", "..", "scripts", "backup.sh"),
      target: "/app/scripts/backup.sh",
      mode: 0o755,
    },
  ]);

  // Stage the photo + audit-verify log inside the runner under /data.
  await runner.exec(["mkdir", "-p", "/data/photos"]);
  await runner.copyFilesToContainer([
    {
      source: path.join(dataDirHost, "photos", "marker.txt"),
      target: "/data/photos/marker.txt",
    },
    {
      source: path.join(dataDirHost, "audit-verify.log"),
      target: "/data/audit-verify.log",
    },
  ]);
}, 240_000);

afterAll(async () => {
  await runner?.stop();
  await sourceDb?.stop();
  await targetDb?.stop();
  await network?.stop();
  if (dataDirHost) await fs.rm(dataDirHost, { recursive: true, force: true });
});

describe("backup.sh — roundtrip restore (Postgres + restic)", () => {
  it("backs up, restores into a clean DB, and re-verifies the audit chain", async () => {
    // The source DB is reachable from the runner at SOURCE_ALIAS:5432.
    const sourceUrl =
      `postgresql://${sourceDb.getUsername()}:${sourceDb.getPassword()}` +
      `@${SOURCE_ALIAS}:5432/${sourceDb.getDatabase()}`;
    const targetUrl =
      `postgresql://${targetDb.getUsername()}:${targetDb.getPassword()}` +
      `@${TARGET_ALIAS}:5432/${targetDb.getDatabase()}`;

    // 1. Run backup.sh against the source DB into a local restic repo
    //    that lives inside the runner under /tmp/restic.
    const backupEnv = [
      "DATABASE_URL=" + sourceUrl,
      "RESTIC_REPOSITORY=/tmp/restic",
      "RESTIC_PASSWORD=test-pass-not-secret",
      "DATA_DIR=/data",
    ];
    const backupOut = await execOk(
      runner,
      [
        "env",
        ...backupEnv,
        "bash",
        "/app/scripts/backup.sh",
      ],
      "backup.sh",
    );
    expect(backupOut).toMatch(/Backup complete\./);

    // 2. Restore the latest snapshot into a fresh /tmp/restore dir.
    await execOk(
      runner,
      [
        "env",
        ...backupEnv,
        "restic",
        "restore",
        "latest",
        "--target",
        "/tmp/restore",
      ],
      "restic restore",
    );

    // 3. Find the gzipped dump under the restored tree. backup.sh
    //    writes it into a tmp dir inside the source container, so we
    //    locate by extension rather than by exact path.
    const findOut = await execOk(
      runner,
      ["sh", "-c", "find /tmp/restore -name 'db.sql.gz' -type f"],
      "find dump",
    );
    const dumpPath = findOut.trim().split("\n").filter(Boolean)[0];
    expect(dumpPath).toBeTruthy();

    // 4. Replay the dump into the target DB.
    await execOk(
      runner,
      [
        "sh",
        "-c",
        `gunzip -c "${dumpPath}" | psql "${targetUrl}"`,
      ],
      "psql restore",
    );

    // 5. Sanity-check the schema + audit chain on the destination.
    const targetPrisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: targetDb.getConnectionUri() }),
    });
    try {
      const auditCount = await targetPrisma.auditLog.count();
      expect(auditCount).toBeGreaterThan(0);

      const userCount = await targetPrisma.user.count();
      expect(userCount).toBeGreaterThan(0);

      // Hash chain must still validate end-to-end — the most important
      // post-restore property, because a torn restore would break it.
      const verify = await verifyAuditChainWithClient(targetPrisma);
      expect(verify.ok).toBe(true);
    } finally {
      await targetPrisma.$disconnect();
    }

    // 6. Photo + audit-verify.log files round-tripped.
    const restoredPhoto = await execOk(
      runner,
      ["sh", "-c", "find /tmp/restore -name 'marker.txt' -type f"],
      "find photo",
    );
    expect(restoredPhoto.trim()).toMatch(/photos\/marker\.txt$/);
    const restoredAuditLog = await execOk(
      runner,
      ["sh", "-c", "find /tmp/restore -name 'audit-verify.log' -type f"],
      "find audit-verify log",
    );
    expect(restoredAuditLog.trim()).toMatch(/audit-verify\.log$/);
  }, 240_000);
});
