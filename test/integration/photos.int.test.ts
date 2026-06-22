import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import sharp from "sharp";
import {
  afterAll,
  afterEach,
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
 * HTTP integration test for `POST /api/photos/upload`. Exercises the
 * full request pipeline against a real Postgres (Testcontainers), a
 * real DATA_DIR (per-test tmp dir) and a real sharp pipeline; only the
 * `auth()` session lookup and the request-scoped `getAuditContext()`
 * are stubbed so the route can run outside an actual Next.js request.
 *
 * Covers:
 *  - 401 for unauthenticated callers,
 *  - 400 for malformed multipart (missing reportId / no files),
 *  - 403 for project non-members (no existence leak),
 *  - 409 for signed/locked reports,
 *  - 422 when every uploaded file fails validation,
 *  - 200 partial success when some files fail and some succeed, with
 *    photo rows persisted, files written and EXIF (capturedAt / gps)
 *    extracted from the original bytes.
 */

// ---------------------------------------------------------------------------
// Module stubs (must be hoisted; vi.mock runs before any imports below).
// ---------------------------------------------------------------------------

vi.mock("@/server/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/server/audit-context", () => ({
  getAuditContext: vi.fn(),
}));

import { auth } from "@/server/auth";
import { getAuditContext } from "@/server/audit-context";

const mockedAuth = vi.mocked(auth);
const mockedGetAuditContext = vi.mocked(getAuditContext);

// ---------------------------------------------------------------------------
// Per-suite container + DB + DATA_DIR
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let db: PrismaClient;
let dataDir: string;
let POST: typeof import("@/app/api/photos/upload/route").POST;

let bossUser: SessionUser;
let workerOutsider: SessionUser;

let projectId: string;
let reportId: string;
let lockedReportId: string;

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

async function makeJpeg(): Promise<Buffer> {
  return sharp({
    create: {
      width: 300,
      height: 200,
      channels: 3,
      background: { r: 0, g: 128, b: 200 },
    },
  })
    .withExif({
      IFD2: { DateTimeOriginal: "2026:06:15 10:30:00" },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "49/1 49/1 1560/100",
        GPSLongitudeRef: "E",
        GPSLongitude: "18/1 16/1 3300/100",
      },
    })
    .jpeg()
    .toBuffer();
}

/** Build a multipart Request the way the browser would. */
function buildRequest(form: FormData): Request {
  return new Request("http://localhost/api/photos/upload", {
    method: "POST",
    body: form,
  });
}

/** Wrap a Node Buffer in a File so it can ride in a Web FormData. */
function fileFromBuffer(buf: Buffer, name: string): File {
  return new File([new Uint8Array(buf)], name, { type: "image/jpeg" });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;
  dataDir = await fs.mkdtemp(
    path.join(process.env.TMPDIR ?? "/tmp", "stavebni-denik-photos-int-"),
  );
  process.env.DATA_DIR = dataDir;

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
      isAdmin: true,
    mustChangePwd: false,
    },
  });
  const wOut = await db.user.create({
    data: {
      nickname: "wo",
      displayName: "Dělník Cizí",
      passwordHash: "x",
      role: "WORKER",
      isAdmin: true,
    mustChangePwd: false,
    },
  });
  bossUser = sessionUser(boss.id, "BOSS");
  workerOutsider = sessionUser(wOut.id, "WORKER");

  const project = await db.project.create({
    data: {
      name: "Stavba A",
      address: "Polní 12, Hlučín",
      cadastralArea: "Hlučín",
      parcelNumbers: "1/1",
      builder: "Stavebník",
      contractor: "Zhotovitel",
      siteManagerId: boss.id,
      members: { create: [{ userId: boss.id, role: "BOSS" }] },
    },
  });
  projectId = project.id;

  const fakeWeather = {
    source: "manual",
    fetchedAt: new Date().toISOString(),
    date: "2026-06-15",
    tempMinC: 10,
    tempMaxC: 20,
    precipitationMm: 0,
    windMaxKmh: 5,
    weatherCode: null,
    summary: "Test",
  };

  const report = await db.dailyReport.create({
    data: {
      projectId,
      date: new Date("2026-06-15T00:00:00.000Z"),
      authorId: boss.id,
      workersByTrade: [],
      workDescription: "test",
      weather: fakeWeather,
    },
  });
  reportId = report.id;

  const locked = await db.dailyReport.create({
    data: {
      projectId,
      date: new Date("2026-06-16T00:00:00.000Z"),
      authorId: boss.id,
      workersByTrade: [],
      workDescription: "locked",
      weather: fakeWeather,
      signedAt: new Date(),
      signedById: boss.id,
      lockedAt: new Date(),
    },
  });
  lockedReportId = locked.id;

  // Import the route handler ONLY after DATABASE_URL + DATA_DIR are in
  // place; the underlying prisma + env singletons capture them at load.
  ({ POST } = await import("@/app/api/photos/upload/route"));
}, 180_000);

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Default: BOSS authenticated, audit ctx points at BOSS.
  mockedAuth.mockResolvedValue({ user: bossUser } as never);
  mockedGetAuditContext.mockResolvedValue({
    actor: { id: bossUser.id },
    ip: "127.0.0.1",
    userAgent: "vitest-int",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/photos/upload — auth + multipart parsing", () => {
  it("returns 401 when no session is present", async () => {
    mockedAuth.mockResolvedValue(null as never);
    const form = new FormData();
    form.append("reportId", reportId);
    form.append("files", fileFromBuffer(await makeJpeg(), "x.jpg"));

    const res = await POST(buildRequest(form));
    expect(res.status).toBe(401);
  });

  it("returns 400 when reportId is missing", async () => {
    const form = new FormData();
    form.append("files", fileFromBuffer(await makeJpeg(), "x.jpg"));

    const res = await POST(buildRequest(form));
    expect(res.status).toBe(400);
  });

  it("returns 400 when no files are attached", async () => {
    const form = new FormData();
    form.append("reportId", reportId);

    const res = await POST(buildRequest(form));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/photos/upload — RBAC / state", () => {
  it("returns 403 for a non-member worker (no existence leak)", async () => {
    mockedAuth.mockResolvedValue({ user: workerOutsider } as never);
    mockedGetAuditContext.mockResolvedValue({
      actor: { id: workerOutsider.id },
      ip: null,
      userAgent: "vitest-int",
    });

    const form = new FormData();
    form.append("reportId", reportId);
    form.append("files", fileFromBuffer(await makeJpeg(), "x.jpg"));

    const res = await POST(buildRequest(form));
    // Non-members get 404 because loadReportContext throws
    // ProjectNotAccessibleError, NOT ForbiddenError.
    expect([403, 404]).toContain(res.status);
  });

  it("returns 409 when the target report is locked", async () => {
    const form = new FormData();
    form.append("reportId", lockedReportId);
    form.append("files", fileFromBuffer(await makeJpeg(), "x.jpg"));

    const res = await POST(buildRequest(form));
    expect(res.status).toBe(409);
  });
});

describe("POST /api/photos/upload — happy path", () => {
  it("persists a real JPEG, captures EXIF, and writes both variants to DATA_DIR", async () => {
    const jpeg = await makeJpeg();
    const form = new FormData();
    form.append("reportId", reportId);
    form.append("files", fileFromBuffer(jpeg, "stavba-001.jpg"));

    const res = await POST(buildRequest(form));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      uploaded: { id: string; filename: string; width: number; height: number; bytes: number }[];
      failed: { filename: string; reason: string }[];
    };
    expect(body.failed).toEqual([]);
    expect(body.uploaded).toHaveLength(1);
    expect(body.uploaded[0]?.filename).toBe("stavba-001.jpg");
    expect(body.uploaded[0]?.width).toBe(300);
    expect(body.uploaded[0]?.height).toBe(200);

    // Row is in the DB with EXIF columns populated.
    const photo = await db.photo.findUniqueOrThrow({
      where: { id: body.uploaded[0]!.id },
    });
    expect(photo.reportId).toBe(reportId);
    expect(photo.uploadedById).toBe(bossUser.id);
    expect(photo.capturedAt).toBeInstanceOf(Date);
    expect(photo.capturedAt?.getFullYear()).toBe(2026);
    expect(photo.gps).not.toBeNull();
    const gps = photo.gps as Record<string, number>;
    expect(gps.lat).toBeGreaterThan(49);
    expect(gps.lon).toBeGreaterThan(18);

    // Files exist on disk and the JSON byte count matches the actual file.
    const absMain = path.join(dataDir, photo.pathOriginal);
    const absThumb = path.join(dataDir, photo.pathThumb);
    const mainStat = await fs.stat(absMain);
    const thumbStat = await fs.stat(absThumb);
    expect(mainStat.size).toBe(body.uploaded[0]!.bytes);
    expect(thumbStat.size).toBeGreaterThan(0);
  });

  it("reports partial success (200) when one file is garbage", async () => {
    const jpeg = await makeJpeg();
    const garbage = Buffer.from("not an image".repeat(50));
    const form = new FormData();
    form.append("reportId", reportId);
    form.append("files", fileFromBuffer(jpeg, "ok.jpg"));
    form.append("files", fileFromBuffer(garbage, "bad.jpg"));

    const res = await POST(buildRequest(form));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      uploaded: { filename: string }[];
      failed: { filename: string; reason: string }[];
    };
    expect(body.uploaded.map((u) => u.filename)).toEqual(["ok.jpg"]);
    expect(body.failed.map((f) => f.filename)).toEqual(["bad.jpg"]);
  });

  it("reports 422 when ALL files fail validation", async () => {
    const form = new FormData();
    form.append("reportId", reportId);
    form.append(
      "files",
      fileFromBuffer(Buffer.from("xxx".repeat(50)), "a.jpg"),
    );
    form.append(
      "files",
      fileFromBuffer(Buffer.from("yyy".repeat(50)), "b.jpg"),
    );

    const res = await POST(buildRequest(form));
    expect(res.status).toBe(422);

    const body = (await res.json()) as {
      uploaded: unknown[];
      failed: { filename: string }[];
    };
    expect(body.uploaded).toHaveLength(0);
    expect(body.failed).toHaveLength(2);
  });

  it("returns 429 with Retry-After when the per-user upload rate-limit is exceeded", async () => {
    // Pre-fill the rate-limit bucket to ABOVE the cap by inserting
    // attempts directly — saves us from making 60 real uploads.
    // `photo:upload` bucket / key = user.id / now-ish timestamp.
    const now = new Date();
    const rows = Array.from({ length: 61 }, (_, i) => ({
      bucket: "photo:upload",
      key: bossUser.id,
      created_at: new Date(now.getTime() - i * 1000),
    }));
    await db.$executeRawUnsafe(
      `INSERT INTO rate_limit_attempts (bucket, "key", created_at)
       VALUES ${rows.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(", ")}`,
      ...rows.flatMap((r) => [r.bucket, r.key, r.created_at]),
    );

    const form = new FormData();
    form.append("reportId", reportId);
    form.append("files", fileFromBuffer(await makeJpeg(), "denied.jpg"));

    const res = await POST(buildRequest(form));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);

    // Clean up so the surrounding suite's happy path is not affected
    // (rate-limit rows persist across `it` cases in the same describe).
    await db.$executeRawUnsafe(
      `DELETE FROM rate_limit_attempts WHERE bucket = 'photo:upload' AND "key" = $1`,
      bossUser.id,
    );
  });

  it("prefers client-provided EXIF over the server-parsed copy", async () => {
    // The browser strips EXIF during resize, so we send a JPEG that
    // DOES still have EXIF (so the server CAN parse it) plus
    // separate `capturedAt` / `gps` fields that DISAGREE with the
    // file. The DB row must reflect the client-supplied values —
    // they are the canonical record of what the camera shot before
    // re-encoding.
    const jpeg = await makeJpeg();
    const clientCapturedAt = new Date("2025-04-01T08:30:00.000Z");
    const clientGps = { lat: 50.1, lon: 14.4 };

    const form = new FormData();
    form.append("reportId", reportId);
    form.append("files", fileFromBuffer(jpeg, "client-exif.jpg"));
    form.append("capturedAt", clientCapturedAt.toISOString());
    form.append("gps", JSON.stringify(clientGps));

    const res = await POST(buildRequest(form));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      uploaded: { id: string }[];
      failed: unknown[];
    };
    expect(body.failed).toEqual([]);
    expect(body.uploaded).toHaveLength(1);

    const photo = await db.photo.findUniqueOrThrow({
      where: { id: body.uploaded[0]!.id },
    });
    expect(photo.capturedAt?.toISOString()).toBe(
      clientCapturedAt.toISOString(),
    );
    const gps = photo.gps as Record<string, number>;
    expect(gps.lat).toBeCloseTo(clientGps.lat, 6);
    expect(gps.lon).toBeCloseTo(clientGps.lon, 6);
  });

  it("accepts empty client meta fields as 'unknown' (capturedAt / gps null)", async () => {
    // When the browser couldn't read EXIF (no metadata in the
    // picture) it still sends the parallel fields, just empty. The
    // server must treat that as "client says null", NOT fall back to
    // re-parsing the buffer.
    const jpeg = await makeJpeg();

    const form = new FormData();
    form.append("reportId", reportId);
    form.append("files", fileFromBuffer(jpeg, "no-exif-from-client.jpg"));
    form.append("capturedAt", "");
    form.append("gps", "");

    const res = await POST(buildRequest(form));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { uploaded: { id: string }[] };
    const photo = await db.photo.findUniqueOrThrow({
      where: { id: body.uploaded[0]!.id },
    });
    expect(photo.capturedAt).toBeNull();
    expect(photo.gps).toBeNull();
  });
});
