import { execSync } from "node:child_process";

import { PrismaPg } from "@prisma/adapter-pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import type { AuditContext } from "@/server/audit";
import { verifyAuditChainWithClient } from "@/server/audit-verify";

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

  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });

  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  ({ appendAudit } = await import("@/server/audit"));
});

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
});

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE TABLE audit_log RESTART IDENTITY CASCADE');
});

describe("audit_log concurrency", () => {
  it("concurrent appends do not fork the hash chain", async () => {
    // Without pg_advisory_xact_lock, two writers reading the same tail produce the same prevHash, forking the chain and causing verification to fail.
    const N = 8;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        appendAudit(ctx, {
          action: "session.signin",
          entityType: "session",
          entityId: `s${i}`,
          after: { index: i },
        })
      );
    }
    
    await Promise.all(promises);

    const result = await verifyAuditChainWithClient(db);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(N);
  });

  it("sequential appends still verify clean", async () => {
    const N = 5;
    for (let i = 0; i < N; i++) {
      await appendAudit(ctx, {
        action: "session.signin",
        entityType: "session",
        entityId: `seq${i}`,
        after: { index: i },
      });
    }

    const result = await verifyAuditChainWithClient(db);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(N);
  });
});
