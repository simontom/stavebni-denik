import { execSync } from "node:child_process";

import { PrismaPg } from "@prisma/adapter-pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import type { AuditContext } from "@/server/audit";
import { verifyAuditChainWithClient } from "@/server/audit-verify";

/**
 * End-to-end integration test for the tamper-evident audit log against a
 * real Postgres (via Testcontainers). Requires a running Docker daemon —
 * it is NOT part of `pnpm test`; run with `pnpm test:integration`.
 *
 * Covers:
 *  - a freshly appended chain verifies clean,
 *  - the append-only DB triggers reject UPDATE/DELETE,
 *  - tampering that bypasses the triggers (privileged DB admin) is
 *    detected by the verifier, which reports the offending row id.
 */
let container: StartedPostgreSqlContainer;
let db: PrismaClient;
let appendAudit: typeof import("@/server/audit").appendAudit;

const ctx: AuditContext = {
  actor: { id: "tester" },
  ip: "127.0.0.1",
  userAgent: "vitest-integration",
};

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;

  // Apply migrations — creates audit_log plus the append-only triggers.
  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });

  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  // Import the real append path only AFTER DATABASE_URL is set so the
  // singleton in `lib/db` connects to the container.
  ({ appendAudit } = await import("@/server/audit"));
}, 180_000);

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
});

describe("audit_log integrity (real Postgres)", () => {
  it("verifies an intact chain and enforces append-only", async () => {
    for (let i = 0; i < 3; i++) {
      await appendAudit(ctx, {
        action: "session.signin",
        entityType: "session",
        entityId: `s${i}`,
        after: { index: i },
      });
    }

    const result = await verifyAuditChainWithClient(db);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(3);

    // The BEFORE UPDATE/DELETE triggers must reject any mutation.
    await expect(
      db.$executeRawUnsafe(
        "UPDATE audit_log SET action = 'tampered' WHERE id = (SELECT MIN(id) FROM audit_log)",
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.$executeRawUnsafe(
        "DELETE FROM audit_log WHERE id = (SELECT MIN(id) FROM audit_log)",
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("detects tampering performed with the triggers disabled", async () => {
    const rows = await db.$queryRaw<Array<{ id: bigint }>>`
      SELECT id FROM audit_log ORDER BY id ASC LIMIT 1 OFFSET 1
    `;
    const targetId = rows[0].id;

    // Simulate a privileged DB admin who disables the guard, edits a row,
    // then re-enables it — the hash chain must still expose the change.
    await db.$executeRawUnsafe("ALTER TABLE audit_log DISABLE TRIGGER USER");
    await db.$executeRawUnsafe(
      `UPDATE audit_log SET after = '{"tampered":true}'::jsonb WHERE id = ${targetId}`,
    );
    await db.$executeRawUnsafe("ALTER TABLE audit_log ENABLE TRIGGER USER");

    const result = await verifyAuditChainWithClient(db);
    expect(result.ok).toBe(false);
    expect(result.brokenAtId).toBe(targetId);
    expect(result.reason).toContain("row_hash mismatch");
  });
});
