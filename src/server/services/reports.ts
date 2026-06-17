import "server-only";

import { z } from "zod";

import { prisma } from "@/lib/db";
import type {
  DailyReport,
  Prisma,
} from "@/generated/prisma/client";

import type { AuditContext } from "@/server/audit";
import { withAudit } from "@/server/audit";
import {
  assertCan,
  can,
  canAccessProject,
  type SessionUser,
} from "@/server/permissions";
import { formatDateInput } from "@/lib/dates";
import {
  fetchWeatherSnapshot,
  type WeatherSnapshot,
} from "@/server/weather";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const LONG_TEXT_MAX = 20000;

const workerLineSchema = z.object({
  trade: z.string().trim().min(1, "Vyplňte profesi.").max(120),
  count: z.number().int().min(0).max(9999),
});

export type WorkerLine = z.infer<typeof workerLineSchema>;

/**
 * Daily-report content schema. Works on already-normalised values
 * (empty optionals → `null`, worker lines parsed into an array); the
 * mechanical `FormData` extraction is `normalizeReportForm`.
 */
export const reportFormSchema = z.object({
  workersByTrade: z.array(workerLineSchema).max(50),
  workDescription: z
    .string()
    .trim()
    .min(1, "Popište provedené práce.")
    .max(LONG_TEXT_MAX),
  materialsIn: z.string().trim().max(LONG_TEXT_MAX).nullable(),
  machinery: z.string().trim().max(LONG_TEXT_MAX).nullable(),
  testsAndChecks: z.string().trim().max(LONG_TEXT_MAX).nullable(),
  safetyNotes: z.string().trim().max(LONG_TEXT_MAX).nullable(),
  defects: z.string().trim().max(LONG_TEXT_MAX).nullable(),
  otherNotes: z.string().trim().max(LONG_TEXT_MAX).nullable(),
});

export type ReportInput = z.infer<typeof reportFormSchema>;

/** Manual weather override — only usable when the auto fetch failed. */
export const manualWeatherSchema = z.object({
  tempMinC: z.number().min(-90).max(60).nullable(),
  tempMaxC: z.number().min(-90).max(60).nullable(),
  precipitationMm: z.number().min(0).max(1000).nullable(),
  windMaxKmh: z.number().min(0).max(500).nullable(),
  summary: z.string().trim().max(255).nullable(),
});

export type ManualWeatherInput = z.infer<typeof manualWeatherSchema>;

const remarkSchema = z.object({
  text: z.string().trim().min(1, "Napište text připomínky.").max(LONG_TEXT_MAX),
  isOfficial: z.boolean().optional(),
});

const addendumSchema = z.object({
  text: z.string().trim().min(1, "Napište text dodatku.").max(LONG_TEXT_MAX),
});

const materialSchema = z.object({
  text: z.string().trim().min(1, "Popište potřebný materiál.").max(2000),
  neededBy: z.date().nullable(),
});

/**
 * Mechanically pull a daily-report payload out of `FormData`. Worker
 * lines arrive as parallel `workerTrade[]` / `workerCount[]` fields;
 * empty rows are dropped. Validation stays in `reportFormSchema`.
 */
export function normalizeReportForm(data: FormData): Record<string, unknown> {
  const str = (key: string): string => {
    const v = data.get(key);
    return typeof v === "string" ? v : "";
  };
  const optStr = (key: string): string | null => {
    const v = str(key).trim();
    return v.length > 0 ? v : null;
  };

  const trades = data.getAll("workerTrade").map((v) => String(v));
  const counts = data.getAll("workerCount").map((v) => String(v));
  const workersByTrade = trades
    .map((trade, i) => ({
      trade: trade.trim(),
      count: Math.trunc(Number((counts[i] ?? "0").replace(",", ".")) || 0),
    }))
    .filter((w) => w.trade.length > 0);

  return {
    workersByTrade,
    workDescription: str("workDescription"),
    materialsIn: optStr("materialsIn"),
    machinery: optStr("machinery"),
    testsAndChecks: optStr("testsAndChecks"),
    safetyNotes: optStr("safetyNotes"),
    defects: optStr("defects"),
    otherNotes: optStr("otherNotes"),
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ProjectNotAccessibleError extends Error {
  code = "ProjectNotAccessible" as const;
  constructor() {
    super("Zakázka neexistuje nebo k ní nemáte přístup.");
  }
}

export class ReportNotFoundError extends Error {
  code = "ReportNotFound" as const;
  constructor() {
    super("Denní záznam nebyl nalezen.");
  }
}

export class ReportExistsError extends Error {
  code = "ReportExists" as const;
  constructor() {
    super("Pro tento den už záznam existuje.");
  }
}

export class ReportLockedError extends Error {
  code = "ReportLocked" as const;
  constructor() {
    super("Záznam je po podpisu uzamčen; změny lze provést jen dodatkem.");
  }
}

export class ReportAlreadySignedError extends Error {
  code = "ReportAlreadySigned" as const;
  constructor() {
    super("Záznam je už podepsaný.");
  }
}

export class ReportNotLockedError extends Error {
  code = "ReportNotLocked" as const;
  constructor() {
    super("Dodatek lze přidat pouze k podepsanému (uzamčenému) záznamu.");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Coerce a persisted JSON value into a typed worker array. */
function parseWorkers(value: Prisma.JsonValue): WorkerLine[] {
  if (!Array.isArray(value)) return [];
  const out: WorkerLine[] = [];
  for (const item of value) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      const trade = typeof rec.trade === "string" ? rec.trade : "";
      const count = typeof rec.count === "number" ? rec.count : 0;
      if (trade.length > 0) out.push({ trade, count });
    }
  }
  return out;
}

/** Read the weather snapshot column back into its typed shape. */
function parseWeather(value: Prisma.JsonValue): WeatherSnapshot {
  return value as unknown as WeatherSnapshot;
}

/** Project a report row for the audit log (dates → ISO strings). */
function reportForAudit(r: DailyReport) {
  return {
    id: r.id,
    projectId: r.projectId,
    date: r.date.toISOString(),
    authorId: r.authorId,
    workersByTrade: r.workersByTrade,
    workDescription: r.workDescription,
    materialsIn: r.materialsIn,
    machinery: r.machinery,
    testsAndChecks: r.testsAndChecks,
    safetyNotes: r.safetyNotes,
    defects: r.defects,
    otherNotes: r.otherNotes,
    weather: r.weather,
    signedAt: r.signedAt ? r.signedAt.toISOString() : null,
    signedById: r.signedById,
    lockedAt: r.lockedAt ? r.lockedAt.toISOString() : null,
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
  };
}

/**
 * Resolve the project + the acting user's membership in a single place.
 * Throws `ProjectNotAccessibleError` when the project is missing,
 * archived, or out of the user's visibility scope (no existence leak).
 */
async function loadProjectScope(
  projectId: string,
  user: SessionUser,
): Promise<{ gpsLat: number | null; gpsLon: number | null; isMember: boolean }> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: {
      gpsLat: true,
      gpsLon: true,
      members: { where: { userId: user.id }, select: { userId: true } },
    },
  });
  if (!project) throw new ProjectNotAccessibleError();
  const isMember = project.members.length > 0;
  if (!canAccessProject(user.role, isMember)) {
    throw new ProjectNotAccessibleError();
  }
  return { gpsLat: project.gpsLat, gpsLon: project.gpsLon, isMember };
}

/** Cast a typed object into Prisma's JSON input type. */
function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

// ---------------------------------------------------------------------------
// Mutations (all audited)
// ---------------------------------------------------------------------------

/**
 * Create a daily report for `(projectId, date)`. Fetches a weather
 * snapshot at creation time and freezes it into the row. Enforces the
 * project scope and the `report.create` capability. Throws
 * `ReportExistsError` when a report for the day already exists (the unique
 * `(projectId, date)` constraint also guards against races).
 */
export async function createReport(opts: {
  projectId: string;
  /** Prague day start (see `pragueDayStart`). */
  date: Date;
  input: ReportInput;
  ctx: AuditContext;
  user: SessionUser;
}): Promise<DailyReport> {
  const { projectId, date, ctx, user } = opts;
  const data = reportFormSchema.parse(opts.input);

  const { gpsLat, gpsLon, isMember } = await loadProjectScope(projectId, user);
  assertCan(user, "report.create", { projectMember: isMember });

  const existing = await prisma.dailyReport.findUnique({
    where: { projectId_date: { projectId, date } },
    select: { id: true },
  });
  if (existing) throw new ReportExistsError();

  const weather = await fetchWeatherSnapshot({
    lat: gpsLat,
    lon: gpsLon,
    date: formatDateInput(date),
  });

  try {
    return await withAudit<DailyReport>(
      {
        ctx,
        action: "report.create",
        entityType: "report",
        resolveEntityId: (r) => r.id,
        before: null,
        projectAfter: reportForAudit,
      },
      (tx) =>
        tx.dailyReport.create({
          data: {
            projectId,
            date,
            authorId: user.id,
            createdById: user.id,
            workersByTrade: asJson(data.workersByTrade),
            workDescription: data.workDescription,
            materialsIn: data.materialsIn,
            machinery: data.machinery,
            testsAndChecks: data.testsAndChecks,
            safetyNotes: data.safetyNotes,
            defects: data.defects,
            otherNotes: data.otherNotes,
            weather: asJson(weather),
          },
        }),
    );
  } catch (err) {
    // Unique constraint race — another writer created the day first.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      throw new ReportExistsError();
    }
    throw err;
  }
}

/**
 * Update a daily report's content. Blocked once the report is locked
 * (signed) — only an addendum is allowed then. Enforces `report.update`
 * (BOSS, or the WORKER author who is still a project member). The weather
 * snapshot is intentionally NOT changed here (it is evidentiary).
 */
export async function updateReport(opts: {
  reportId: string;
  input: ReportInput;
  ctx: AuditContext;
  user: SessionUser;
}): Promise<DailyReport> {
  const { reportId, ctx, user } = opts;
  const data = reportFormSchema.parse(opts.input);

  const before = await prisma.dailyReport.findFirst({
    where: { id: reportId, deletedAt: null },
  });
  if (!before) throw new ReportNotFoundError();

  const { isMember } = await loadProjectScope(before.projectId, user);
  if (before.lockedAt) throw new ReportLockedError();
  assertCan(user, "report.update", {
    projectMember: isMember,
    reportLocked: before.lockedAt !== null,
    authorId: before.authorId,
  });

  return withAudit<DailyReport>(
    {
      ctx,
      action: "report.update",
      entityType: "report",
      resolveEntityId: (r) => r.id,
      before: reportForAudit(before),
      projectAfter: reportForAudit,
    },
    (tx) =>
      tx.dailyReport.update({
        where: { id: reportId },
        data: {
          workersByTrade: asJson(data.workersByTrade),
          workDescription: data.workDescription,
          materialsIn: data.materialsIn,
          machinery: data.machinery,
          testsAndChecks: data.testsAndChecks,
          safetyNotes: data.safetyNotes,
          defects: data.defects,
          otherNotes: data.otherNotes,
        },
      }),
  );
}

/**
 * Manually fill in the weather when the automatic Open-Meteo fetch
 * failed (`source: "unavailable"`). Allowed only in that case and only
 * while the report is unlocked. Audited as a `report.update`.
 */
export async function setManualWeather(opts: {
  reportId: string;
  input: ManualWeatherInput;
  ctx: AuditContext;
  user: SessionUser;
}): Promise<DailyReport> {
  const { reportId, ctx, user } = opts;
  const data = manualWeatherSchema.parse(opts.input);

  const before = await prisma.dailyReport.findFirst({
    where: { id: reportId, deletedAt: null },
  });
  if (!before) throw new ReportNotFoundError();

  const { isMember } = await loadProjectScope(before.projectId, user);
  if (before.lockedAt) throw new ReportLockedError();
  assertCan(user, "report.update", {
    projectMember: isMember,
    reportLocked: before.lockedAt !== null,
    authorId: before.authorId,
  });

  const current = parseWeather(before.weather);
  if (current.source === "open-meteo") {
    // Auto data already present — refuse to overwrite evidentiary data.
    return before;
  }

  const next: WeatherSnapshot = {
    source: "manual",
    fetchedAt: new Date().toISOString(),
    date: current.date,
    tempMinC: data.tempMinC,
    tempMaxC: data.tempMaxC,
    precipitationMm: data.precipitationMm,
    windMaxKmh: data.windMaxKmh,
    weatherCode: null,
    summary:
      data.summary ??
      (data.tempMinC !== null && data.tempMaxC !== null
        ? `Ručně zadáno, ${data.tempMinC}–${data.tempMaxC} °C`
        : "Ručně zadané počasí"),
    manuallyEntered: true,
  };

  return withAudit<DailyReport>(
    {
      ctx,
      action: "report.update",
      entityType: "report",
      resolveEntityId: (r) => r.id,
      before: reportForAudit(before),
      projectAfter: reportForAudit,
    },
    (tx) =>
      tx.dailyReport.update({
        where: { id: reportId },
        data: { weather: asJson(next) },
      }),
  );
}

/**
 * Add a remark to a report. The single mutation a GUEST (TDS / BOZP
 * coordinator / designer) is allowed to perform on a project they belong
 * to. Allowed even on locked reports — official site visits happen after
 * a day is signed.
 *
 * When `isOfficial` is set, the remark is persisted with the flag and
 * counts as a signed TDS / BOZP / projektant record. We restrict the
 * official flag to GUEST and BOSS to keep WORKERs from accidentally
 * passing themselves off as the dozor.
 */
export async function addRemark(opts: {
  reportId: string;
  text: string;
  isOfficial?: boolean;
  ctx: AuditContext;
  user: SessionUser;
}): Promise<void> {
  const { reportId, ctx, user } = opts;
  const { text, isOfficial } = remarkSchema.parse({
    text: opts.text,
    isOfficial: opts.isOfficial,
  });

  const report = await prisma.dailyReport.findFirst({
    where: { id: reportId, deletedAt: null },
    select: { id: true, projectId: true },
  });
  if (!report) throw new ReportNotFoundError();

  const { isMember } = await loadProjectScope(report.projectId, user);
  assertCan(user, "remark.create", { projectMember: isMember });

  // Only GUEST/BOSS can post an "official" record — the legal weight
  // of an official remark belongs to the dozor (TDS/BOZP/projektant),
  // not to the worker filling in the diary.
  const isOfficialResolved =
    isOfficial === true && (user.role === "GUEST" || user.role === "BOSS");

  await withAudit(
    {
      ctx,
      action: "remark.create",
      entityType: "remark",
      resolveEntityId: (r: { id: string }) => r.id,
      before: null,
      projectAfter: (r: { id: string }) => ({
        id: r.id,
        reportId,
        authorId: user.id,
        text,
        isOfficial: isOfficialResolved,
      }),
    },
    (tx) =>
      tx.remark.create({
        data: {
          reportId,
          authorId: user.id,
          text,
          isOfficial: isOfficialResolved,
        },
      }),
  );
}

/** Add a "material needed" checklist item to a report. */
export async function addMaterialNeed(opts: {
  reportId: string;
  text: string;
  neededBy: Date | null;
  ctx: AuditContext;
  user: SessionUser;
}): Promise<void> {
  const { reportId, ctx, user } = opts;
  const { text, neededBy } = materialSchema.parse({
    text: opts.text,
    neededBy: opts.neededBy,
  });

  const report = await prisma.dailyReport.findFirst({
    where: { id: reportId, deletedAt: null },
    select: { id: true, projectId: true, lockedAt: true },
  });
  if (!report) throw new ReportNotFoundError();

  const { isMember } = await loadProjectScope(report.projectId, user);
  if (report.lockedAt) throw new ReportLockedError();
  assertCan(user, "material.create", {
    projectMember: isMember,
    reportLocked: report.lockedAt !== null,
  });

  await withAudit(
    {
      ctx,
      action: "material.create",
      entityType: "material_need",
      resolveEntityId: (r: { id: string }) => r.id,
      before: null,
      projectAfter: (r: { id: string }) => ({
        id: r.id,
        reportId,
        text,
        neededBy: neededBy ? neededBy.toISOString() : null,
      }),
    },
    (tx) =>
      tx.materialNeed.create({
        data: { reportId, text, neededBy, createdById: user.id },
      }),
  );
}

/** Toggle the `resolved` state of a material checklist item. */
export async function setMaterialResolved(opts: {
  materialId: string;
  resolved: boolean;
  ctx: AuditContext;
  user: SessionUser;
}): Promise<void> {
  const { materialId, resolved, ctx, user } = opts;

  const item = await prisma.materialNeed.findFirst({
    where: { id: materialId, deletedAt: null },
    include: { report: { select: { projectId: true } } },
  });
  if (!item) throw new ReportNotFoundError();

  const { isMember } = await loadProjectScope(item.report.projectId, user);
  assertCan(user, "material.resolve", { projectMember: isMember });

  await withAudit(
    {
      ctx,
      action: "material.resolve",
      entityType: "material_need",
      resolveEntityId: (r: { id: string }) => r.id,
      before: { id: item.id, resolved: item.resolved },
      projectAfter: (r: { id: string }) => ({ id: r.id, resolved }),
    },
    (tx) =>
      tx.materialNeed.update({
        where: { id: materialId },
        data: {
          resolved,
          resolvedAt: resolved ? new Date() : null,
          resolvedById: resolved ? user.id : null,
        },
      }),
  );
}

/**
 * Sign + lock a daily report. BOSS only.
 *
 * Records the signature timestamp + signer id and locks the report
 * (`lockedAt = now`). Once locked, the only allowed mutations are
 * `addRemark` (TDS site visits) and `addAddendum` (errata) — both go
 * through `withAudit` and are visible in the audit log.
 *
 * Idempotent on already-signed reports: throws `ReportAlreadySignedError`
 * so the UI can show "already signed" without a confusing re-sign
 * attempt that would otherwise change `signedAt`.
 */
export async function signReport(opts: {
  reportId: string;
  ctx: AuditContext;
  user: SessionUser;
}): Promise<DailyReport> {
  const { reportId, ctx, user } = opts;

  const before = await prisma.dailyReport.findFirst({
    where: { id: reportId, deletedAt: null },
  });
  if (!before) throw new ReportNotFoundError();

  const { isMember } = await loadProjectScope(before.projectId, user);
  assertCan(user, "report.sign", { projectMember: isMember });

  if (before.signedAt || before.lockedAt) {
    throw new ReportAlreadySignedError();
  }

  const now = new Date();
  return withAudit<DailyReport>(
    {
      ctx,
      action: "report.sign",
      entityType: "report",
      resolveEntityId: (r) => r.id,
      before: reportForAudit(before),
      projectAfter: reportForAudit,
    },
    (tx) =>
      tx.dailyReport.update({
        where: { id: reportId },
        data: {
          signedAt: now,
          signedById: user.id,
          lockedAt: now,
        },
      }),
  );
}

/**
 * Append an addendum (errata) to a SIGNED report. Pre-lock corrections
 * should use `updateReport` instead — addenda are how we extend evidence
 * of a day whose original content is now legally frozen.
 *
 * Project membership is required (no GUEST addenda; GUESTs stick with
 * official remarks for site-visit records).
 */
export async function addAddendum(opts: {
  reportId: string;
  text: string;
  ctx: AuditContext;
  user: SessionUser;
}): Promise<void> {
  const { reportId, ctx, user } = opts;
  const { text } = addendumSchema.parse({ text: opts.text });

  const report = await prisma.dailyReport.findFirst({
    where: { id: reportId, deletedAt: null },
    select: { id: true, projectId: true, lockedAt: true },
  });
  if (!report) throw new ReportNotFoundError();
  if (!report.lockedAt) throw new ReportNotLockedError();

  const { isMember } = await loadProjectScope(report.projectId, user);
  assertCan(user, "report.addendum.create", { projectMember: isMember });

  await withAudit(
    {
      ctx,
      action: "report.addendum.create",
      entityType: "addendum",
      resolveEntityId: (r: { id: string }) => r.id,
      before: null,
      projectAfter: (r: { id: string }) => ({
        id: r.id,
        reportId,
        authorId: user.id,
        text,
      }),
    },
    (tx) =>
      tx.addendum.create({
        data: { reportId, authorId: user.id, text },
      }),
  );
}

// ---------------------------------------------------------------------------
// Queries (scope-aware)
// ---------------------------------------------------------------------------

export interface ReportListItem {
  id: string;
  date: Date;
  authorName: string;
  workersTotal: number;
  weatherSummary: string;
  signed: boolean;
  remarkCount: number;
  photoCount: number;
}

/**
 * List a project's daily reports (newest first), scope-enforced. Returns
 * an empty array shape only after access is confirmed; access failures
 * throw `ProjectNotAccessibleError`.
 */
export async function listReportsForProject(
  projectId: string,
  user: SessionUser,
): Promise<ReportListItem[]> {
  await loadProjectScope(projectId, user);

  const rows = await prisma.dailyReport.findMany({
    where: { projectId, deletedAt: null },
    orderBy: { date: "desc" },
    select: {
      id: true,
      date: true,
      workersByTrade: true,
      weather: true,
      signedAt: true,
      author: { select: { displayName: true } },
      _count: { select: { remarks: true, photos: true } },
    },
  });

  return rows.map((r) => {
    const workers = parseWorkers(r.workersByTrade);
    const weather = parseWeather(r.weather);
    return {
      id: r.id,
      date: r.date,
      authorName: r.author.displayName,
      workersTotal: workers.reduce((sum, w) => sum + w.count, 0),
      weatherSummary: weather.summary ?? "",
      signed: r.signedAt !== null,
      remarkCount: r._count.remarks,
      photoCount: r._count.photos,
    };
  });
}

export interface RemarkView {
  id: string;
  text: string;
  authorName: string;
  isOfficial: boolean;
  createdAt: Date;
}

export interface MaterialView {
  id: string;
  text: string;
  neededBy: Date | null;
  resolved: boolean;
  resolvedAt: Date | null;
}

export interface AddendumView {
  id: string;
  text: string;
  authorName: string;
  createdAt: Date;
}

export interface ReportDetail {
  report: DailyReport;
  projectId: string;
  projectName: string;
  authorName: string;
  signedByName: string | null;
  weather: WeatherSnapshot;
  workers: WorkerLine[];
  remarks: RemarkView[];
  materials: MaterialView[];
  addenda: AddendumView[];
  isMember: boolean;
  locked: boolean;
  canEdit: boolean;
  canAddRemark: boolean;
  canMarkRemarkOfficial: boolean;
  canAddMaterial: boolean;
  canResolveMaterial: boolean;
  canSign: boolean;
  canAddAddendum: boolean;
}

/**
 * Load a single report by `(projectId, date)`, enforcing the project
 * scope. Returns `null` when the project is out of scope or the report
 * does not exist (so the caller renders 404 without leaking existence).
 */
export async function getReportForUser(opts: {
  projectId: string;
  date: Date;
  user: SessionUser;
}): Promise<ReportDetail | null> {
  const { projectId, date, user } = opts;

  let isMember = false;
  try {
    ({ isMember } = await loadProjectScope(projectId, user));
  } catch {
    return null;
  }

  const report = await prisma.dailyReport.findFirst({
    where: { projectId, date, deletedAt: null },
    include: {
      project: { select: { name: true } },
      author: { select: { displayName: true } },
      signedBy: { select: { displayName: true } },
      remarks: {
        where: { deletedAt: null },
        orderBy: { createdAt: "asc" },
        include: { author: { select: { displayName: true } } },
      },
      materialNeeds: {
        where: { deletedAt: null },
        orderBy: { createdAt: "asc" },
      },
      addenda: {
        orderBy: { createdAt: "asc" },
        include: { author: { select: { displayName: true } } },
      },
    },
  });
  if (!report) return null;

  const {
    project,
    author,
    signedBy,
    remarks,
    materialNeeds,
    addenda,
    ...rest
  } = report;
  const locked = report.lockedAt !== null;
  const resource = {
    projectMember: isMember,
    reportLocked: locked,
    authorId: report.authorId,
  };

  return {
    report: rest as DailyReport,
    projectId,
    projectName: project.name,
    authorName: author.displayName,
    signedByName: signedBy?.displayName ?? null,
    weather: parseWeather(report.weather),
    workers: parseWorkers(report.workersByTrade),
    remarks: remarks.map((rm) => ({
      id: rm.id,
      text: rm.text,
      authorName: rm.author.displayName,
      isOfficial: rm.isOfficial,
      createdAt: rm.createdAt,
    })),
    materials: materialNeeds.map((m) => ({
      id: m.id,
      text: m.text,
      neededBy: m.neededBy,
      resolved: m.resolved,
      resolvedAt: m.resolvedAt,
    })),
    addenda: addenda.map((a) => ({
      id: a.id,
      text: a.text,
      authorName: a.author.displayName,
      createdAt: a.createdAt,
    })),
    isMember,
    locked,
    canEdit: can(user, "report.update", resource),
    canAddRemark: can(user, "remark.create", resource),
    canMarkRemarkOfficial:
      can(user, "remark.create", resource) &&
      (user.role === "BOSS" || user.role === "GUEST"),
    canAddMaterial: can(user, "material.create", resource),
    canResolveMaterial: can(user, "material.resolve", resource),
    canSign: !locked && can(user, "report.sign", resource),
    canAddAddendum:
      locked && can(user, "report.addendum.create", resource),
  };
}

/** True when the user may open the "new report" form for the project. */
export async function canCreateReport(
  projectId: string,
  user: SessionUser,
): Promise<boolean> {
  try {
    const { isMember } = await loadProjectScope(projectId, user);
    return can(user, "report.create", { projectMember: isMember });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Bulk export (PDF print page)
// ---------------------------------------------------------------------------

export interface ProjectExportPhoto {
  id: string;
  capturedAt: Date | null;
}

export interface ProjectExportDay {
  id: string;
  date: Date;
  authorName: string;
  signedByName: string | null;
  signedAt: Date | null;
  lockedAt: Date | null;
  weather: WeatherSnapshot;
  workers: WorkerLine[];
  workDescription: string;
  materialsIn: string | null;
  machinery: string | null;
  testsAndChecks: string | null;
  safetyNotes: string | null;
  defects: string | null;
  otherNotes: string | null;
  remarks: RemarkView[];
  materials: MaterialView[];
  addenda: AddendumView[];
  photos: ProjectExportPhoto[];
}

/**
 * One-shot data loader for the print page. Returns every report in
 * the optional `[from, to]` Prague-day window (both inclusive, both
 * optional), ordered oldest → newest so the PDF reads chronologically.
 * Project access is checked once via `loadProjectScope`; the caller
 * gets `null` for out-of-scope users (so the print route can 404
 * without leaking existence).
 */
export async function getProjectExportForUser(opts: {
  projectId: string;
  from: Date | null;
  to: Date | null;
  user: SessionUser;
}): Promise<{ days: ProjectExportDay[] } | null> {
  const { projectId, from, to, user } = opts;
  try {
    await loadProjectScope(projectId, user);
  } catch {
    return null;
  }

  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (from) dateFilter.gte = from;
  if (to) dateFilter.lte = to;

  const rows = await prisma.dailyReport.findMany({
    where: {
      projectId,
      deletedAt: null,
      ...(from || to ? { date: dateFilter } : {}),
    },
    orderBy: { date: "asc" },
    include: {
      author: { select: { displayName: true } },
      signedBy: { select: { displayName: true } },
      remarks: {
        where: { deletedAt: null },
        orderBy: { createdAt: "asc" },
        include: { author: { select: { displayName: true } } },
      },
      materialNeeds: {
        where: { deletedAt: null },
        orderBy: { createdAt: "asc" },
      },
      addenda: {
        orderBy: { createdAt: "asc" },
        include: { author: { select: { displayName: true } } },
      },
      photos: {
        where: { deletedAt: null },
        orderBy: { createdAt: "asc" },
        select: { id: true, capturedAt: true },
      },
    },
  });

  return {
    days: rows.map((r) => ({
      id: r.id,
      date: r.date,
      authorName: r.author.displayName,
      signedByName: r.signedBy?.displayName ?? null,
      signedAt: r.signedAt,
      lockedAt: r.lockedAt,
      weather: parseWeather(r.weather),
      workers: parseWorkers(r.workersByTrade),
      workDescription: r.workDescription,
      materialsIn: r.materialsIn,
      machinery: r.machinery,
      testsAndChecks: r.testsAndChecks,
      safetyNotes: r.safetyNotes,
      defects: r.defects,
      otherNotes: r.otherNotes,
      remarks: r.remarks.map((rm) => ({
        id: rm.id,
        text: rm.text,
        authorName: rm.author.displayName,
        isOfficial: rm.isOfficial,
        createdAt: rm.createdAt,
      })),
      materials: r.materialNeeds.map((m) => ({
        id: m.id,
        text: m.text,
        neededBy: m.neededBy,
        resolved: m.resolved,
        resolvedAt: m.resolvedAt,
      })),
      addenda: r.addenda.map((a) => ({
        id: a.id,
        text: a.text,
        authorName: a.author.displayName,
        createdAt: a.createdAt,
      })),
      photos: r.photos.map((p) => ({
        id: p.id,
        capturedAt: p.capturedAt,
      })),
    })),
  };
}
