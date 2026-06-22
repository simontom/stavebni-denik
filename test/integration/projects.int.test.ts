import { execSync } from "node:child_process";

import { PrismaPg } from "@prisma/adapter-pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import type { AuditContext } from "@/server/audit";
import type { SessionUser } from "@/server/permissions";
import type { CreateProjectInput } from "@/server/services/projects";
import { verifyAuditChainWithClient } from "@/server/audit-verify";

/**
 * Integration test for the project (zakázka) layer against a real
 * Postgres (Testcontainers). Requires Docker — run with
 * `pnpm test:integration`, NOT part of `pnpm test`.
 *
 * Covers the security-critical pieces of Stage 4:
 *  - BOSS can create a project and is auto-enrolled as a member,
 *  - the membership-based visibility scope (BOSS sees all, WORKER/GUEST
 *    only their own projects),
 *  - `getProjectForUser` returns null for a non-member (no leak),
 *  - archive (soft delete) removes a project from active lists but keeps
 *    it in the archive,
 *  - every mutation appends to the tamper-evident audit chain, which
 *    stays valid throughout.
 */
let container: StartedPostgreSqlContainer;
let db: PrismaClient;
let svc: typeof import("@/server/services/projects");

const ctx: AuditContext = {
  actor: { id: "boss1" },
  ip: "127.0.0.1",
  userAgent: "vitest-integration",
};

function sessionUser(id: string, role: SessionUser["role"]): SessionUser {
  return {
    id,
    nickname: id,
    displayName: id,
    role,
    isAdmin: true,
    mustChangePwd: false,
    sessionId: `sess-${id}`,
  };
}

let bossUser: SessionUser;
let worker1: SessionUser;
let worker2: SessionUser;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;

  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });

  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  // Seed three users directly (no audit needed for the fixture).
  const boss = await db.user.create({
    data: {
      nickname: "boss",
      displayName: "Šéf Stavbyvedoucí",
      passwordHash: "x",
      role: "BOSS",
      isAdmin: true,
    mustChangePwd: false,
    },
  });
  const w1 = await db.user.create({
    data: {
      nickname: "delnik1",
      displayName: "Dělník Jedna",
      passwordHash: "x",
      role: "WORKER",
      isAdmin: true,
    mustChangePwd: false,
    },
  });
  const w2 = await db.user.create({
    data: {
      nickname: "delnik2",
      displayName: "Dělník Dva",
      passwordHash: "x",
      role: "WORKER",
      isAdmin: true,
    mustChangePwd: false,
    },
  });

  ctx.actor = { id: boss.id };
  bossUser = sessionUser(boss.id, "BOSS");
  worker1 = sessionUser(w1.id, "WORKER");
  worker2 = sessionUser(w2.id, "WORKER");

  // Import the service only AFTER DATABASE_URL is set so the lib/db
  // singleton connects to the container.
  svc = await import("@/server/services/projects");
}, 180_000);

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
});

function baseInput(siteManagerId: string): CreateProjectInput {
  return {
    name: "Novostavba RD Hlučín",
    address: "Polní 12, Hlučín",
    cadastralArea: "Hlučín",
    parcelNumbers: "123/4, 123/5",
    builder: "Jan Stavebník",
    contractor: "ACME s.r.o.",
    siteManagerId,
    permitNumber: null,
    tdsName: null,
    bozpName: null,
    designerName: null,
    gpsLat: 49.8209,
    gpsLon: 18.1925,
    startedAt: null,
    endedAt: null,
  };
}

describe("projects — scope & audit (real Postgres)", () => {
  let projectId: string;

  it("BOSS creates a project and is auto-enrolled as a member", async () => {
    const project = await svc.createProject(
      baseInput(bossUser.id),
      ctx,
      bossUser.id,
    );
    projectId = project.id;

    const detail = await svc.getProjectForUser(projectId, bossUser);
    expect(detail).not.toBeNull();
    expect(detail!.members).toHaveLength(1);
    expect(detail!.members[0]?.userId).toBe(bossUser.id);

    // Audit row for the creation must exist and the chain stays valid.
    const created = await db.auditLog.findFirst({
      where: { action: "project.create", entityId: projectId },
    });
    expect(created).not.toBeNull();
    expect((await verifyAuditChainWithClient(db)).ok).toBe(true);
  });

  it("rejects a site manager who is not an active BOSS", async () => {
    await expect(
      svc.createProject(baseInput(worker1.id), ctx, bossUser.id),
    ).rejects.toBeInstanceOf(svc.SiteManagerInvalidError);
  });

  it("hides projects from non-members and reveals them to members", async () => {
    // Before assignment: worker1 is not a member.
    expect(await svc.listProjectsForUser(worker1)).toHaveLength(0);
    expect(await svc.getProjectForUser(projectId, worker1)).toBeNull();

    await svc.addProjectMember(projectId, worker1.id, "WORKER", ctx, bossUser.id);

    // After assignment: worker1 sees exactly this project; worker2 none.
    const w1List = await svc.listProjectsForUser(worker1);
    expect(w1List.map((p) => p.id)).toEqual([projectId]);
    expect(await svc.getProjectForUser(projectId, worker1)).not.toBeNull();

    expect(await svc.listProjectsForUser(worker2)).toHaveLength(0);
    expect(await svc.getProjectForUser(projectId, worker2)).toBeNull();

    // BOSS always sees every project regardless of membership.
    expect((await svc.listProjectsForUser(bossUser)).map((p) => p.id)).toContain(
      projectId,
    );

    const added = await db.auditLog.findFirst({
      where: { action: "project.member.add", entityId: `${projectId}:${worker1.id}` },
    });
    expect(added).not.toBeNull();
  });

  it("archives a project: gone from active lists, present in archive", async () => {
    await svc.archiveProject(projectId, ctx);

    expect(await svc.listProjectsForUser(bossUser)).toHaveLength(0);
    expect(await svc.listProjectsForUser(worker1)).toHaveLength(0);

    const archived = await svc.listArchivedProjects();
    expect(archived.map((p) => p.id)).toEqual([projectId]);

    const del = await db.auditLog.findFirst({
      where: { action: "project.delete", entityId: projectId },
    });
    expect(del).not.toBeNull();

    // Restore brings it back to the active list.
    await svc.restoreProject(projectId, ctx);
    expect((await svc.listProjectsForUser(bossUser)).map((p) => p.id)).toEqual([
      projectId,
    ]);

    // The whole chain (create + member.add + delete + update) is intact.
    const result = await verifyAuditChainWithClient(db);
    expect(result.ok).toBe(true);
  });
});
