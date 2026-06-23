import { execSync } from "node:child_process";

import { PrismaPg } from "@prisma/adapter-pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";

/**
 * Integration tests pro `buildProjectCsv` service.
 *
 * Pokrývá end-to-end build proti reálné DB:
 *   - reports CSV: BOM, header, data rows, escaping uvozovek/čárek/newlines
 *   - materials CSV: open vs resolved rows
 *   - visits CSV: čárka v účelu vynucuje quoting
 *   - from/to filter
 *   - soft-deleted reports/materials se neobjevují
 */

let container: StartedPostgreSqlContainer;
let db: PrismaClient;
let buildProjectCsv: typeof import("@/server/services/csv").buildProjectCsv;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;

  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });

  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  ({ buildProjectCsv } = await import("@/server/services/csv"));
});

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
});

beforeEach(async () => {
  await db.visit.deleteMany({});
  await db.materialNeed.deleteMany({});
  await db.dailyReport.deleteMany({});
  await db.projectMember.deleteMany({});
  await db.project.deleteMany({});
  await db.user.deleteMany({});
});

interface Scenario {
  boss: { id: string };
  project: { id: string };
  report: { id: string };
}

async function seed(): Promise<Scenario> {
  const boss = await db.user.create({
    data: {
      nickname: "csv-svc-boss",
      displayName: "CSV Boss",
      passwordHash: "x",
      role: "BOSS",
      ckaitNumber: "0000001",
    },
  });
  const project = await db.project.create({
    data: {
      name: "Rodinný dům, Praha 7",
      address: "Letenská 5",
      cadastralArea: "Bubeneč",
      parcelNumbers: "100/1",
      builder: "Firma A.",
      contractor: "Firma B.",
      siteManagerId: boss.id,
    },
  });
  const report = await db.dailyReport.create({
    data: {
      projectId: project.id,
      date: new Date("2026-06-23T00:00:00Z"),
      authorId: boss.id,
      workersByTrade: [
        { trade: "zedník", count: 3 },
        { trade: "tesař", count: 1 },
      ],
      workDescription: 'Betonáž základů (komentář s "uvozovkami" a, čárkou)',
      materialsIn: "Beton C25/30\n3 m³",
      machinery: "Domíchávač Tatra",
      weather: {},
    },
  });
  return { boss: { id: boss.id }, project: { id: project.id }, report: { id: report.id } };
}

describe("buildProjectCsv — reports", () => {
  it("starts with BOM and header row", async () => {
    const s = await seed();
    const body = await buildProjectCsv({ projectId: s.project.id, type: "reports" });

    expect(body.charCodeAt(0)).toBe(0xfeff); // BOM
    expect(body).toContain("Datum,Autor,Pracovníci celkem,Podepsáno");
  });

  it("escapes inner quotes, commas and newlines per RFC 4180", async () => {
    const s = await seed();
    const body = await buildProjectCsv({ projectId: s.project.id, type: "reports" });

    expect(body).toContain(
      '"Betonáž základů (komentář s ""uvozovkami"" a, čárkou)"',
    );
    expect(body).toContain('"Beton C25/30\n3 m³"');
  });

  it("aggregates worker count from workersByTrade JSON", async () => {
    const s = await seed();
    const body = await buildProjectCsv({ projectId: s.project.id, type: "reports" });
    // 3 + 1 = 4
    expect(body).toMatch(/,4,/);
  });

  it("hides soft-deleted reports", async () => {
    const s = await seed();
    await db.dailyReport.update({
      where: { id: s.report.id },
      data: { deletedAt: new Date() },
    });
    const body = await buildProjectCsv({ projectId: s.project.id, type: "reports" });
    expect(body).not.toContain("Betonáž");
  });

  it("respects from/to range", async () => {
    const s = await seed();
    await db.dailyReport.create({
      data: {
        projectId: s.project.id,
        date: new Date("2026-07-15T00:00:00Z"),
        authorId: s.boss.id,
        workersByTrade: [{ trade: "natěrač", count: 1 }],
        workDescription: "Mimo rozsah",
        weather: {},
      },
    });

    const body = await buildProjectCsv({
      projectId: s.project.id,
      type: "reports",
      from: new Date("2026-06-01T00:00:00Z"),
      to: new Date("2026-06-30T23:59:59Z"),
    });
    expect(body).toContain("Betonáž");
    expect(body).not.toContain("Mimo rozsah");
  });
});

describe("buildProjectCsv — materials", () => {
  it("renders open and resolved items distinctly", async () => {
    const s = await seed();
    await db.materialNeed.create({
      data: {
        reportId: s.report.id,
        text: "Štěrk frakce 4-8",
        neededBy: new Date("2026-06-25T00:00:00Z"),
      },
    });
    await db.materialNeed.create({
      data: {
        reportId: s.report.id,
        text: "Hutnící deska",
        resolved: true,
        resolvedAt: new Date("2026-06-24T10:00:00Z"),
      },
    });

    const body = await buildProjectCsv({ projectId: s.project.id, type: "materials" });
    expect(body).toContain("Datum reportu,Položka,Potřeba do,Stav");
    expect(body).toContain("Štěrk frakce 4-8");
    expect(body).toContain("otevřené");
    expect(body).toContain("Hutnící deska");
    expect(body).toContain("vyřízeno");
  });
});

describe("buildProjectCsv — visits", () => {
  it("renders visit rows with quoting when needed", async () => {
    const s = await seed();
    await db.visit.create({
      data: {
        reportId: s.report.id,
        visitorName: "Ing. Nováková",
        visitorRole: "TDS",
        organization: "Dozor s.r.o.",
        visitedAt: new Date("2026-06-23T10:30:00Z"),
        purpose: "Kontrola izolace, spár.",
        authorId: s.boss.id,
      },
    });

    const body = await buildProjectCsv({ projectId: s.project.id, type: "visits" });
    expect(body).toContain("Datum reportu,Čas návštěvy,Jméno,Role");
    expect(body).toContain("Ing. Nováková");
    expect(body).toContain("TDS");
    // Čárka v purpose vynucuje quoting:
    expect(body).toContain('"Kontrola izolace, spár."');
  });

  it("skips soft-deleted visits", async () => {
    const s = await seed();
    const v = await db.visit.create({
      data: {
        reportId: s.report.id,
        visitorName: "Smazaná návštěva",
        visitorRole: "TDS",
        visitedAt: new Date(),
        purpose: "X",
        authorId: s.boss.id,
      },
    });
    await db.visit.update({
      where: { id: v.id },
      data: { deletedAt: new Date() },
    });

    const body = await buildProjectCsv({ projectId: s.project.id, type: "visits" });
    expect(body).not.toContain("Smazaná návštěva");
  });
});
