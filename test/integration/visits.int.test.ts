import { execSync } from "node:child_process";

import { PrismaPg } from "@prisma/adapter-pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";

/**
 * Integration tests for the visits/inspections feature.
 *
 * Covers:
 *   - happy path: BOSS creates a visit, audit row is appended
 *   - GUEST (TDS) can record their own visit (vyhláška § 6 — typický scénář)
 *   - WORKER cannot delete BOSS's visit (only own)
 *   - cannot create visit when report is locked (signed)
 *   - service throws ProjectAccessDeniedError when actor is not a member
 *   - soft-delete preserves row + appends audit
 */

let container: StartedPostgreSqlContainer;
let db: PrismaClient;
let createVisit: typeof import("@/server/services/visits").createVisit;
let deleteVisit: typeof import("@/server/services/visits").deleteVisit;
let listVisitsForReport: typeof import("@/server/services/visits").listVisitsForReport;
let ProjectAccessDeniedError: typeof import("@/server/services/visits").ProjectAccessDeniedError;
let ReportLockedError: typeof import("@/server/services/visits").ReportLockedError;
let VisitNotFoundError: typeof import("@/server/services/visits").VisitNotFoundError;
let ForbiddenError: typeof import("@/server/permissions").ForbiddenError;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;

  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });

  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  ({
    createVisit,
    deleteVisit,
    listVisitsForReport,
    ProjectAccessDeniedError,
    ReportLockedError,
    VisitNotFoundError,
  } = await import("@/server/services/visits"));
  ({ ForbiddenError } = await import("@/server/permissions"));
});

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
});

interface Scenario {
  boss: { id: string; nickname: string };
  worker: { id: string; nickname: string };
  guest: { id: string; nickname: string };
  outsider: { id: string; nickname: string };
  project: { id: string };
  report: { id: string };
}

async function createScenario(suffix: string): Promise<Scenario> {
  const boss = await db.user.create({
    data: {
      nickname: `boss-${suffix}`,
      displayName: "Boss",
      passwordHash: "x",
      role: "BOSS",
      ckaitNumber: "0000001",
    },
  });
  const worker = await db.user.create({
    data: {
      nickname: `worker-${suffix}`,
      displayName: "Worker",
      passwordHash: "x",
      role: "WORKER",
    },
  });
  const guest = await db.user.create({
    data: {
      nickname: `guest-${suffix}`,
      displayName: "TDS Novák",
      passwordHash: "x",
      role: "GUEST",
    },
  });
  const outsider = await db.user.create({
    data: {
      nickname: `outsider-${suffix}`,
      displayName: "Outsider",
      passwordHash: "x",
      role: "WORKER",
    },
  });
  const project = await db.project.create({
    data: {
      name: `Project ${suffix}`,
      address: "Testovací 1",
      cadastralArea: "Praha",
      parcelNumbers: "1/2",
      builder: "Builder",
      contractor: "Contractor",
      siteManagerId: boss.id,
    },
  });
  // boss is also a member (siteManager má auto-membership)
  await db.projectMember.createMany({
    data: [
      { projectId: project.id, userId: boss.id, role: "BOSS" },
      { projectId: project.id, userId: worker.id, role: "WORKER" },
      { projectId: project.id, userId: guest.id, role: "GUEST" },
    ],
  });
  const report = await db.dailyReport.create({
    data: {
      projectId: project.id,
      date: new Date("2026-06-23T00:00:00Z"),
      authorId: boss.id,
      workersByTrade: [{ trade: "zedník", count: 2 }],
      workDescription: "test",
      weather: {},
    },
  });
  return {
    boss: { id: boss.id, nickname: boss.nickname },
    worker: { id: worker.id, nickname: worker.nickname },
    guest: { id: guest.id, nickname: guest.nickname },
    outsider: { id: outsider.id, nickname: outsider.nickname },
    project: { id: project.id },
    report: { id: report.id },
  };
}

beforeEach(async () => {
  // POZOR: audit_log se NESMÍ mazat (append-only trigger).
  await db.visit.deleteMany({});
  await db.dailyReport.deleteMany({});
  await db.projectMember.deleteMany({});
  await db.project.deleteMany({});
  await db.user.deleteMany({});
});

function actor(
  s: Pick<Scenario, "boss" | "worker" | "guest" | "outsider">,
  which: "boss" | "worker" | "guest" | "outsider",
) {
  const u = s[which];
  return {
    id: u.id,
    nickname: u.nickname,
    displayName: u.nickname,
    role: which === "boss" ? "BOSS" : which === "worker" ? "WORKER" : "GUEST",
    isAdmin: false,
    mustChangePwd: false,
    sessionId: "test-session",
  } as Parameters<typeof createVisit>[0]["user"];
}

const auditCtx = (actorId: string) =>
  ({
    actor: { id: actorId },
    ip: "127.0.0.1",
    userAgent: "vitest",
  }) as Parameters<typeof createVisit>[0]["ctx"];

describe("createVisit", () => {
  it("happy path — BOSS creates a visit, audit row is appended", async () => {
    const s = await createScenario("happy");
    const created = await createVisit({
      input: {
        reportId: s.report.id,
        visitorName: "Ing. Novák",
        visitorRole: "TDS",
        organization: "Novák & Co",
        visitedAt: new Date("2026-06-23T10:00:00Z"),
        purpose: "Kontrola izolace.",
        notes: null,
      },
      user: actor(s, "boss"),
      ctx: auditCtx(s.boss.id),
    });
    expect(created.id).toBeTruthy();
    expect(created.visitorName).toBe("Ing. Novák");

    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: "visit.create", entityId: created.id },
    });
    expect(audit.actorId).toBe(s.boss.id);

    const list = await listVisitsForReport(s.report.id);
    expect(list).toHaveLength(1);
    expect(list[0].visitorRole).toBe("TDS");
  });

  it("GUEST (TDS) can record their own visit (typický scénář § 6)", async () => {
    const s = await createScenario("guest-visit");
    const created = await createVisit({
      input: {
        reportId: s.report.id,
        visitorName: s.guest.nickname,
        visitorRole: "TDS",
        organization: null,
        visitedAt: new Date("2026-06-23T11:00:00Z"),
        purpose: "TDS sám sebe zaznamenává.",
        notes: null,
      },
      user: actor(s, "guest"),
      ctx: auditCtx(s.guest.id),
    });
    expect(created.authorId).toBe(s.guest.id);
  });

  it("throws ProjectAccessDeniedError when actor is not a member", async () => {
    const s = await createScenario("not-member");
    await expect(
      createVisit({
        input: {
          reportId: s.report.id,
          visitorName: "X",
          visitorRole: "Investor",
          organization: null,
          visitedAt: new Date(),
          purpose: "Pokus.",
          notes: null,
        },
        user: actor(s, "outsider"),
        ctx: auditCtx(s.outsider.id),
      }),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
  });

  it("throws ReportLockedError when the report is signed", async () => {
    const s = await createScenario("locked");
    await db.dailyReport.update({
      where: { id: s.report.id },
      data: { lockedAt: new Date(), signedAt: new Date(), signedById: s.boss.id },
    });

    await expect(
      createVisit({
        input: {
          reportId: s.report.id,
          visitorName: "Y",
          visitorRole: "Investor",
          organization: null,
          visitedAt: new Date(),
          purpose: "Pokus.",
          notes: null,
        },
        user: actor(s, "boss"),
        ctx: auditCtx(s.boss.id),
      }),
    ).rejects.toBeInstanceOf(ReportLockedError);
  });
});

describe("deleteVisit", () => {
  it("soft-deletes a visit and appends visit.delete audit row", async () => {
    const s = await createScenario("delete-happy");
    const created = await createVisit({
      input: {
        reportId: s.report.id,
        visitorName: "Z",
        visitorRole: "Investor",
        organization: null,
        visitedAt: new Date(),
        purpose: "Pokus.",
        notes: null,
      },
      user: actor(s, "boss"),
      ctx: auditCtx(s.boss.id),
    });

    await deleteVisit({
      id: created.id,
      user: actor(s, "boss"),
      ctx: auditCtx(s.boss.id),
    });

    const after = await db.visit.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.deletedAt).not.toBeNull();

    const list = await listVisitsForReport(s.report.id);
    expect(list).toHaveLength(0);

    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: "visit.delete", entityId: created.id },
    });
    expect(audit.actorId).toBe(s.boss.id);
  });

  it("WORKER cannot delete BOSS's visit (only own)", async () => {
    const s = await createScenario("worker-delete-foreign");
    const bossVisit = await createVisit({
      input: {
        reportId: s.report.id,
        visitorName: "Boss visit",
        visitorRole: "Investor",
        organization: null,
        visitedAt: new Date(),
        purpose: "Pokus.",
        notes: null,
      },
      user: actor(s, "boss"),
      ctx: auditCtx(s.boss.id),
    });

    await expect(
      deleteVisit({
        id: bossVisit.id,
        user: actor(s, "worker"),
        ctx: auditCtx(s.worker.id),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // visit zůstává nezměněný
    const stillThere = await db.visit.findUniqueOrThrow({
      where: { id: bossVisit.id },
    });
    expect(stillThere.deletedAt).toBeNull();
  });

  it("throws VisitNotFoundError for non-existent id", async () => {
    const s = await createScenario("not-found");
    await expect(
      deleteVisit({
        id: "ckxxxnonexistent000000000",
        user: actor(s, "boss"),
        ctx: auditCtx(s.boss.id),
      }),
    ).rejects.toBeInstanceOf(VisitNotFoundError);
  });
});
