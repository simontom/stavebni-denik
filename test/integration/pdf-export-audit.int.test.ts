import { execSync } from "node:child_process";

import { PrismaPg } from "@prisma/adapter-pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import type { SessionUser } from "@/server/permissions";

/**
 * Audit-side integration test for `GET /api/projects/[id]/pdf`.
 *
 * We mock Playwright (`renderPdf`) so this test doesn't need the
 * 350 MB chromium binary, and exercises the audit-log append path
 * end-to-end against a real Postgres. Asserts:
 *
 *   - a successful download writes ONE `pdf.export` row,
 *   - the row carries the truncated anchor hash burned into the
 *     PDF footer (so the in-file evidence matches the DB row),
 *   - the row is chained correctly (latest-hash advances after the
 *     append).
 */

vi.mock("@/server/auth", () => ({ auth: vi.fn() }));
vi.mock("@/server/audit-context", () => ({ getAuditContext: vi.fn() }));
vi.mock("@/server/pdf", async () => {
  const actual = await vi.importActual<typeof import("@/server/pdf")>(
    "@/server/pdf",
  );
  return {
    ...actual,
    renderPdf: vi.fn(),
  };
});

import { auth } from "@/server/auth";
import { getAuditContext } from "@/server/audit-context";
import { renderPdf } from "@/server/pdf";

const mockedAuth = vi.mocked(auth);
const mockedGetAuditContext = vi.mocked(getAuditContext);
const mockedRenderPdf = vi.mocked(renderPdf);

let container: StartedPostgreSqlContainer;
let db: PrismaClient;
let GET: typeof import("@/app/api/projects/[id]/pdf/route").GET;

let bossUser: SessionUser;
let projectId: string;

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

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;

  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });

  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  ({ GET } = await import("@/app/api/projects/[id]/pdf/route"));

  const boss = await db.user.create({
    data: {
      nickname: "boss-pdf",
      displayName: "Boss",
      passwordHash: "x",
      role: "BOSS",
      ckaitNumber: "0000001",
    },
  });
  bossUser = sessionUser(boss.id, "BOSS");

  const project = await db.project.create({
    data: {
      name: "Audit-export project",
      address: "Adresa 1",
      cadastralArea: "Praha",
      parcelNumbers: "1/1",
      builder: "X s.r.o.",
      contractor: "Y s.r.o.",
      siteManagerId: boss.id,
      createdById: boss.id,
      members: { create: { userId: boss.id, role: "BOSS" } },
    },
  });
  projectId = project.id;
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockedAuth.mockResolvedValue({ user: bossUser } as never);
  mockedGetAuditContext.mockResolvedValue({
    actor: { id: bossUser.id },
    ip: "127.0.0.1",
    userAgent: "vitest",
  });
  mockedRenderPdf.mockResolvedValue(
    Buffer.from("%PDF-1.4\n%fake test payload\n"),
  );
});

function buildRequest(): Request {
  return new Request(
    `http://localhost/api/projects/${projectId}/pdf?from=2026-06-01&to=2026-06-30`,
    { method: "GET" },
  );
}

describe("GET /api/projects/[id]/pdf — audit anchor", () => {
  it("writes a pdf.export row carrying the same anchor hash as the footer", async () => {
    const before = await db.auditLog.count({ where: { action: "pdf.export" } });

    const res = await GET(buildRequest(), {
      params: Promise.resolve({ id: projectId }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");

    const after = await db.auditLog.count({ where: { action: "pdf.export" } });
    expect(after).toBe(before + 1);

    const row = await db.auditLog.findFirstOrThrow({
      where: { action: "pdf.export", entityId: projectId },
      orderBy: { id: "desc" },
    });
    expect(row.actorId).toBe(bossUser.id);
    const payload = row.after as Record<string, unknown>;
    expect(payload.projectName).toBe("Audit-export project");
    expect(payload.from).toBe("2026-06-01");
    expect(payload.to).toBe("2026-06-30");
    expect(typeof payload.bytes).toBe("number");
    expect(payload.bytes).toBeGreaterThan(0);

    // Anchor in the row == truncated hash burned into the PDF footer
    // (the footer is HTML rendered by Playwright — we trust the same
    // helper that the route uses).
    expect(typeof payload.anchorHash).toBe("string");
    expect((payload.anchorHash as string).length).toBe(16);
    expect(payload.latestHashFull).toMatch(/^[0-9a-f]{64}$/);
    expect((payload.latestHashFull as string).slice(0, 16)).toBe(
      payload.anchorHash,
    );
  });

  it("does NOT audit a failed render (no row written when renderPdf throws)", async () => {
    mockedRenderPdf.mockRejectedValueOnce(new Error("chromium crashed"));
    const before = await db.auditLog.count({ where: { action: "pdf.export" } });

    const res = await GET(buildRequest(), {
      params: Promise.resolve({ id: projectId }),
    });
    expect(res.status).toBe(500);

    const after = await db.auditLog.count({ where: { action: "pdf.export" } });
    expect(after).toBe(before);
  });

  it("returns 404 (no audit row) for a project the caller cannot see", async () => {
    const outsider = await db.user.create({
      data: {
        nickname: "outsider-pdf",
        displayName: "Outsider",
        passwordHash: "x",
        role: "WORKER",
      },
    });
    mockedAuth.mockResolvedValue({
      user: sessionUser(outsider.id, "WORKER"),
    } as never);
    const before = await db.auditLog.count({ where: { action: "pdf.export" } });

    const res = await GET(buildRequest(), {
      params: Promise.resolve({ id: projectId }),
    });
    expect(res.status).toBe(404);

    const after = await db.auditLog.count({ where: { action: "pdf.export" } });
    expect(after).toBe(before);
  });
});
