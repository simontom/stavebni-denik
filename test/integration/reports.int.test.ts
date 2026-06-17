import { execSync } from "node:child_process";

import { PrismaPg } from "@prisma/adapter-pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import type { AuditContext } from "@/server/audit";
import { ForbiddenError, type SessionUser } from "@/server/permissions";
import { verifyAuditChainWithClient } from "@/server/audit-verify";
import { pragueDayStart } from "@/lib/dates";

/**
 * Integration test for the daily-report layer (Stage 5). Spins up a real
 * Postgres via Testcontainers (so foreign keys, the unique
 * (projectId, date) constraint, and the append-only audit triggers are
 * actually exercised) and exercises the security-critical flows:
 *
 *  - BOSS can create a report; the weather snapshot is frozen on
 *    creation (we stub `fetch` so no real Open-Meteo traffic is needed),
 *  - the project membership scope is enforced for both list and detail
 *    (non-members get `null`, not a 403, to avoid existence leaks),
 *  - GUEST members can ONLY append remarks — not create reports or
 *    material checklist items,
 *  - once a report is signed (lockedAt set), updates are refused but
 *    remarks remain possible (official TDS visits happen after sign),
 *  - the hash-chained audit log stays valid throughout.
 */

let container: StartedPostgreSqlContainer;
let db: PrismaClient;
let svc: typeof import("@/server/services/reports");

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
    mustChangePwd: false,
    sessionId: `sess-${id}`,
  };
}

let bossUser: SessionUser;
let workerMember: SessionUser;
let workerOutsider: SessionUser;
let guestMember: SessionUser;

let projectId: string;
let otherProjectId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;
  // Make sure the weather module's network call (if it ever reaches the
  // wire under a misconfigured mock) goes nowhere useful.
  process.env.OPEN_METEO_BASE = "http://localhost:1";

  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });

  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  const boss = await db.user.create({
    data: {
      nickname: "boss",
      displayName: "Šéf",
      passwordHash: "x",
      role: "BOSS",
      mustChangePwd: false,
    },
  });
  const wMember = await db.user.create({
    data: {
      nickname: "wm",
      displayName: "Dělník Člen",
      passwordHash: "x",
      role: "WORKER",
      mustChangePwd: false,
    },
  });
  const wOut = await db.user.create({
    data: {
      nickname: "wo",
      displayName: "Dělník Cizí",
      passwordHash: "x",
      role: "WORKER",
      mustChangePwd: false,
    },
  });
  const guest = await db.user.create({
    data: {
      nickname: "tds",
      displayName: "Technický Dozor",
      passwordHash: "x",
      role: "GUEST",
      mustChangePwd: false,
    },
  });

  ctx.actor = { id: boss.id };
  bossUser = sessionUser(boss.id, "BOSS");
  workerMember = sessionUser(wMember.id, "WORKER");
  workerOutsider = sessionUser(wOut.id, "WORKER");
  guestMember = sessionUser(guest.id, "GUEST");

  // Two projects: the primary one the worker + guest are members of,
  // and a second one nobody but the BOSS belongs to (used for the
  // "non-member sees nothing" scope check).
  const projSvc = await import("@/server/services/projects");
  const baseInput = (siteManagerId: string) => ({
    name: "Stavba A",
    address: "Polní 12, Hlučín",
    cadastralArea: "Hlučín",
    parcelNumbers: "1/1",
    builder: "Stavebník",
    contractor: "Zhotovitel",
    siteManagerId,
    permitNumber: null,
    tdsName: null,
    bozpName: null,
    designerName: null,
    gpsLat: 49.82,
    gpsLon: 18.19,
    startedAt: null,
    endedAt: null,
  });
  const proj = await projSvc.createProject(baseInput(boss.id), ctx, boss.id);
  projectId = proj.id;
  await projSvc.addProjectMember(projectId, wMember.id, "WORKER", ctx, boss.id);
  await projSvc.addProjectMember(projectId, guest.id, "GUEST", ctx, boss.id);

  const other = await projSvc.createProject(
    { ...baseInput(boss.id), name: "Stavba B", parcelNumbers: "2/2" },
    ctx,
    boss.id,
  );
  otherProjectId = other.id;

  svc = await import("@/server/services/reports");
}, 180_000);

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
});

/**
 * Stub `globalThis.fetch` so the weather snapshot uses a deterministic
 * Open-Meteo response (no network needed). Resets per-test so mutations
 * don't leak between cases.
 */
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        daily: {
          time: ["2026-06-15"],
          temperature_2m_min: [10],
          temperature_2m_max: [21],
          precipitation_sum: [0],
          wind_speed_10m_max: [8],
          weather_code: [2],
        },
      }),
      { status: 200 },
    ),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("daily reports — scope, lock, audit (real Postgres)", () => {
  it("BOSS creates a report, freezes the weather snapshot, audit chain valid", async () => {
    const day = pragueDayStart("2026-06-15");
    const report = await svc.createReport({
      projectId,
      date: day,
      input: {
        workersByTrade: [{ trade: "zedník", count: 3 }],
        workDescription: "Bednění stropu nad 1. NP.",
        materialsIn: null,
        machinery: null,
        testsAndChecks: null,
        safetyNotes: null,
        defects: null,
        otherNotes: null,
      },
      ctx,
      user: bossUser,
    });

    expect(report.projectId).toBe(projectId);
    // Weather snapshot is captured at create time and pinned to the row.
    const weather = report.weather as Record<string, unknown>;
    expect(weather.source).toBe("open-meteo");
    expect(weather.tempMinC).toBe(10);
    expect(weather.tempMaxC).toBe(21);

    const audit = await db.auditLog.findFirst({
      where: { action: "report.create", entityId: report.id },
    });
    expect(audit).not.toBeNull();
    expect((await verifyAuditChainWithClient(db)).ok).toBe(true);
  });

  it("refuses a duplicate report for the same (projectId, date)", async () => {
    await expect(
      svc.createReport({
        projectId,
        date: pragueDayStart("2026-06-15"),
        input: {
          workersByTrade: [],
          workDescription: "Druhý pokus.",
          materialsIn: null,
          machinery: null,
          testsAndChecks: null,
          safetyNotes: null,
          defects: null,
          otherNotes: null,
        },
        ctx,
        user: bossUser,
      }),
    ).rejects.toBeInstanceOf(svc.ReportExistsError);
  });

  it("WORKER member can create a report; WORKER non-member cannot", async () => {
    const dayOk = pragueDayStart("2026-06-16");
    const r = await svc.createReport({
      projectId,
      date: dayOk,
      input: {
        workersByTrade: [{ trade: "tesař", count: 2 }],
        workDescription: "Tesařské práce nad 1. NP.",
        materialsIn: null,
        machinery: null,
        testsAndChecks: null,
        safetyNotes: null,
        defects: null,
        otherNotes: null,
      },
      ctx,
      user: workerMember,
    });
    expect(r.authorId).toBe(workerMember.id);

    // Non-member cannot even see the project, let alone create a report.
    await expect(
      svc.createReport({
        projectId,
        date: pragueDayStart("2026-06-17"),
        input: {
          workersByTrade: [],
          workDescription: "Cizí worker by neměl projít.",
          materialsIn: null,
          machinery: null,
          testsAndChecks: null,
          safetyNotes: null,
          defects: null,
          otherNotes: null,
        },
        ctx,
        user: workerOutsider,
      }),
    ).rejects.toBeInstanceOf(svc.ProjectNotAccessibleError);
  });

  it("GUEST member can append a remark but cannot create reports or materials", async () => {
    const day = pragueDayStart("2026-06-15");
    const report = await db.dailyReport.findFirstOrThrow({
      where: { projectId, date: day },
    });

    await svc.addRemark({
      reportId: report.id,
      text: "TDS: zkontrolováno bednění, OK.",
      ctx,
      user: guestMember,
    });
    const remarks = await db.remark.findMany({ where: { reportId: report.id } });
    expect(remarks).toHaveLength(1);
    expect(remarks[0]?.authorId).toBe(guestMember.id);

    await expect(
      svc.createReport({
        projectId,
        date: pragueDayStart("2026-06-18"),
        input: {
          workersByTrade: [],
          workDescription: "Guest by neměl moct.",
          materialsIn: null,
          machinery: null,
          testsAndChecks: null,
          safetyNotes: null,
          defects: null,
          otherNotes: null,
        },
        ctx,
        user: guestMember,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await expect(
      svc.addMaterialNeed({
        reportId: report.id,
        text: "Cement",
        neededBy: null,
        ctx,
        user: guestMember,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("scope: list & detail return only projects the user belongs to", async () => {
    // Member sees the day in the primary project, nothing in the other.
    const memberList = await svc.listReportsForProject(projectId, workerMember);
    expect(memberList.length).toBeGreaterThan(0);

    await expect(
      svc.listReportsForProject(otherProjectId, workerMember),
    ).rejects.toBeInstanceOf(svc.ProjectNotAccessibleError);

    const day = pragueDayStart("2026-06-15");
    const outsiderDetail = await svc.getReportForUser({
      projectId,
      date: day,
      user: workerOutsider,
    });
    expect(outsiderDetail).toBeNull();
  });

  it("locked (signed) report refuses updates but still accepts remarks", async () => {
    const day = pragueDayStart("2026-06-15");
    const before = await db.dailyReport.findFirstOrThrow({
      where: { projectId, date: day },
    });

    // Simulate the sign step from Stage 6 (no service yet).
    await db.dailyReport.update({
      where: { id: before.id },
      data: {
        signedAt: new Date(),
        signedById: bossUser.id,
        lockedAt: new Date(),
      },
    });

    await expect(
      svc.updateReport({
        reportId: before.id,
        input: {
          workersByTrade: [],
          workDescription: "Po podpisu už ne.",
          materialsIn: null,
          machinery: null,
          testsAndChecks: null,
          safetyNotes: null,
          defects: null,
          otherNotes: null,
        },
        ctx,
        user: bossUser,
      }),
    ).rejects.toBeInstanceOf(svc.ReportLockedError);

    await expect(
      svc.addMaterialNeed({
        reportId: before.id,
        text: "Na zítřek lepidlo",
        neededBy: null,
        ctx,
        user: workerMember,
      }),
    ).rejects.toBeInstanceOf(svc.ReportLockedError);

    // Remarks remain allowed — official TDS visits happen after sign.
    await svc.addRemark({
      reportId: before.id,
      text: "Dodatečná připomínka po podpisu.",
      ctx,
      user: guestMember,
    });
    const remarks = await db.remark.findMany({ where: { reportId: before.id } });
    expect(remarks.length).toBeGreaterThanOrEqual(2);

    // Whole hash chain (all the above mutations) stays valid.
    expect((await verifyAuditChainWithClient(db)).ok).toBe(true);
  });
});
