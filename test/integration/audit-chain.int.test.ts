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

  it("verifies chain integrity after full legislative flow (handover, authorized person, report acknowledge)", async () => {
    // We start from the tampered state so clear it
    await db.$executeRawUnsafe("ALTER TABLE audit_log DISABLE TRIGGER USER");
    await db.$executeRawUnsafe("DELETE FROM audit_log");
    await db.$executeRawUnsafe("ALTER TABLE audit_log ENABLE TRIGGER USER");
    
    const projSvc = await import("@/server/services/projects");
    const handoversSvc = await import("@/server/services/site-handovers");
    const authPersonSvc = await import("@/server/services/authorized-persons");
    const reportsSvc = await import("@/server/services/reports");
    const { pragueDayStart } = await import("@/lib/dates");

    const boss = await db.user.create({
      data: { nickname: "boss2", displayName: "Boss", passwordHash: "x", role: "BOSS", isAdmin: true, mustChangePwd: false }
    });
    const inv = await db.user.create({
      data: { nickname: "inv2", displayName: "Inv", passwordHash: "x", role: "INVESTOR", isAdmin: false, mustChangePwd: false }
    });

    const ctxB: AuditContext = { actor: { id: boss.id }, ip: "127.0.0.1", userAgent: "test" };
    const ctxI: AuditContext = { actor: { id: inv.id }, ip: "127.0.0.1", userAgent: "test" };

    const project = await projSvc.createProject({
      name: "Proj", address: "A", cadastralArea: "C", parcelNumbers: "1", builder: "B", contractor: "C",
      siteManagerId: boss.id,
      permitNumber: null, tdsName: null, bozpName: null, designerName: null, contractNumber: null, contractDate: null, designDocVersion: null, designDocDate: null,
      gpsLat: 1, gpsLon: 1, startedAt: null, endedAt: null,
    }, ctxB, boss.id);

    await projSvc.addProjectMember(project.id, inv.id, "INVESTOR", ctxB, boss.id);

    // handover.create
    const handover = await handoversSvc.createHandover(project.id, boss.id, {
      type: "handover", date: new Date(), participants: "P", meterStates: [], notes: ""
    });

    // handover.sign
    await handoversSvc.signHandover(handover.id, boss.id);

    // authorized_person.create
    const ap = await authPersonSvc.addExternalPerson({
      projectId: project.id, name: "AP", company: "C", authorization: "A"
    }, ctxB);

    // authorized_person.revoke
    await authPersonSvc.revokePerson(ap.id, ctxB);

    // report.create & report.acknowledge
    const userMockBoss: any = { id: boss.id, role: "BOSS" };
    const userMockInv: any = { id: inv.id, role: "INVESTOR" };

    const report = await reportsSvc.createReport({
      projectId: project.id, date: pragueDayStart(new Date()),
      input: { workersByTrade: [], workDescription: "Work", materialsIn: null, machinery: null, testsAndChecks: null, safetyNotes: null, defects: null, otherNotes: null, isControlDay: false, constructionObj: null },
      ctx: ctxB, user: userMockBoss
    });

    await reportsSvc.acknowledgeReport({
      reportId: report.id, ctx: ctxI, user: userMockInv
    });

    // Verify chain
    const result = await verifyAuditChainWithClient(db);
    expect(result.ok).toBe(true);
  });
});
