import { execSync } from "node:child_process";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import type { AuditContext } from "@/server/audit";
import { type SessionUser } from "@/server/permissions";
import { pragueDayStart } from "@/lib/dates";

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
    isAdmin: true,
    mustChangePwd: false,
    sessionId: `sess-${id}`,
  };
}

let bossUser: SessionUser;
let investorUser: SessionUser;
let projectId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;
  process.env.OPEN_METEO_BASE = "http://localhost:1";

  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });

  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  const boss = await db.user.create({
    data: { nickname: "boss", displayName: "Boss", passwordHash: "x", role: "BOSS", isAdmin: true, mustChangePwd: false },
  });
  const investor = await db.user.create({
    data: { nickname: "inv", displayName: "Inv", passwordHash: "x", role: "INVESTOR", isAdmin: false, mustChangePwd: false },
  });
  bossUser = sessionUser(boss.id, "BOSS");
  investorUser = sessionUser(investor.id, "INVESTOR");

  svc = await import("@/server/services/reports");
});

afterAll(async () => {
  await db.$disconnect();
  await container.stop();
});

beforeEach(async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 400 }));

  await db.project.deleteMany();

  const p = await db.project.create({
    data: {
      name: "Seq Test",
      address: "123 Test St",
      cadastralArea: "Test Area",
      parcelNumbers: "123/4",
      builder: "Bob Builder",
      contractor: "Corp",
      siteManagerId: bossUser.id,
      members: {
        create: [
          { userId: bossUser.id, role: "BOSS" },
          { userId: investorUser.id, role: "INVESTOR" }
        ],
      },
    },
  });
  projectId = p.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Report Sequence and Acknowledgement", () => {
  it("should sequentially generate sequenceNumber", async () => {
    const r1 = await svc.createReport({
      projectId,
      date: pragueDayStart(new Date("2026-09-01T10:00:00Z")),
      input: {
        workersByTrade: [],
        workDescription: "Day 1",
        materialsIn: null, machinery: null, testsAndChecks: null, safetyNotes: null, defects: null, otherNotes: null,
        isControlDay: false, constructionObj: "Obj A",
      },
      ctx,
      user: bossUser,
    });
    expect(r1.sequenceNumber).toBe(1);
    expect(r1.constructionObj).toBe("Obj A");
    expect(r1.isControlDay).toBe(false);

    const r2 = await svc.createReport({
      projectId,
      date: pragueDayStart(new Date("2026-09-02T10:00:00Z")),
      input: {
        workersByTrade: [],
        workDescription: "Day 2",
        materialsIn: null, machinery: null, testsAndChecks: null, safetyNotes: null, defects: null, otherNotes: null,
        isControlDay: true, constructionObj: null,
      },
      ctx,
      user: bossUser,
    });
    expect(r2.sequenceNumber).toBe(2);
    expect(r2.isControlDay).toBe(true);
    expect(r2.constructionObj).toBeNull();
  });

  it("should update isControlDay and constructionObj", async () => {
    const r = await svc.createReport({
      projectId,
      date: pragueDayStart(new Date("2026-09-03T10:00:00Z")),
      input: {
        workersByTrade: [], workDescription: "...", isControlDay: false, constructionObj: null,
        materialsIn: null, machinery: null, testsAndChecks: null, safetyNotes: null, defects: null, otherNotes: null,
      },
      ctx,
      user: bossUser,
    });

    const updated = await svc.updateReport({
      reportId: r.id,
      input: {
        workersByTrade: [], workDescription: "updated",
        materialsIn: null, machinery: null, testsAndChecks: null, safetyNotes: null, defects: null, otherNotes: null,
        isControlDay: true, constructionObj: "Obj B",
      },
      ctx,
      user: bossUser,
    });

    expect(updated.isControlDay).toBe(true);
    expect(updated.constructionObj).toBe("Obj B");
  });

  it("should allow INVESTOR to acknowledge report", async () => {
    const r = await svc.createReport({
      projectId,
      date: pragueDayStart(new Date("2026-09-04T10:00:00Z")),
      input: {
        workersByTrade: [], workDescription: "...", isControlDay: false, constructionObj: null,
        materialsIn: null, machinery: null, testsAndChecks: null, safetyNotes: null, defects: null, otherNotes: null,
      },
      ctx,
      user: bossUser,
    });

    const ack = await svc.acknowledgeReport({
      reportId: r.id,
      ctx: { ...ctx, actor: { id: investorUser.id } },
      user: investorUser,
    });

    expect(ack.acknowledgedAt).not.toBeNull();
    expect(ack.acknowledgedById).toBe(investorUser.id);
  });

  it("should prevent double acknowledgement of a report", async () => {
    const r = await svc.createReport({
      projectId,
      date: pragueDayStart(new Date("2026-09-05T10:00:00Z")),
      input: {
        workersByTrade: [], workDescription: "...", isControlDay: false, constructionObj: null,
        materialsIn: null, machinery: null, testsAndChecks: null, safetyNotes: null, defects: null, otherNotes: null,
      },
      ctx,
      user: bossUser,
    });

    await svc.acknowledgeReport({
      reportId: r.id,
      ctx: { ...ctx, actor: { id: investorUser.id } },
      user: investorUser,
    });

    await expect(
      svc.acknowledgeReport({
        reportId: r.id,
        ctx: { ...ctx, actor: { id: investorUser.id } },
        user: investorUser,
      })
    ).rejects.toThrowError("Denní záznam již byl investorem potvrzen.");
  });
});
