import "server-only";

import { promises as fs } from "node:fs";

import { type Photo } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { AuditContext } from "@/server/audit";
import { withAudit } from "@/server/audit";
import {
  assertCan,
  canAccessProject,
  type SessionUser,
} from "@/server/permissions";
import {
  InvalidImageError,
  ImageTooLargeError,
  processImage,
} from "@/server/images";
import { parseExifSafely } from "@/server/exif";
import {
  deletePhotoVariants,
  resolvePhotoAbsolutePath,
  writePhotoVariants,
} from "@/server/photo-storage";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export { InvalidImageError, ImageTooLargeError };

export class ReportNotFoundError extends Error {
  code = "ReportNotFound" as const;
  constructor() {
    super("Denní záznam nebyl nalezen.");
  }
}

export class ReportLockedError extends Error {
  code = "ReportLocked" as const;
  constructor() {
    super("Záznam je po podpisu uzamčen.");
  }
}

export class ProjectNotAccessibleError extends Error {
  code = "ProjectNotAccessible" as const;
  constructor() {
    super("Zakázka neexistuje nebo k ní nemáte přístup.");
  }
}

export class PhotoNotFoundError extends Error {
  code = "PhotoNotFound" as const;
  constructor() {
    super("Fotografie nebyla nalezena.");
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ReportContext {
  reportId: string;
  projectId: string;
  reportLocked: boolean;
  isMember: boolean;
}

/**
 * Resolve report + project + the acting user's membership in one place.
 * Throws `ReportNotFoundError` / `ProjectNotAccessibleError` so the
 * caller does not have to repeat the scope dance. Avoids existence
 * leaks: a non-member gets the same error as if the report did not
 * exist.
 */
async function loadReportContext(
  reportId: string,
  user: SessionUser,
): Promise<ReportContext> {
  const report = await prisma.dailyReport.findFirst({
    where: { id: reportId, deletedAt: null },
    select: {
      id: true,
      projectId: true,
      lockedAt: true,
      project: {
        select: {
          deletedAt: true,
          members: { where: { userId: user.id }, select: { userId: true } },
        },
      },
    },
  });
  if (!report || report.project.deletedAt !== null) {
    throw new ReportNotFoundError();
  }
  const isMember = report.project.members.length > 0;
  if (!canAccessProject(user.role, isMember)) {
    throw new ProjectNotAccessibleError();
  }
  return {
    reportId: report.id,
    projectId: report.projectId,
    reportLocked: report.lockedAt !== null,
    isMember,
  };
}

/** Project a Photo row for the audit log (dates → ISO strings). */
function photoForAudit(p: Photo) {
  return {
    id: p.id,
    reportId: p.reportId,
    pathOriginal: p.pathOriginal,
    pathThumb: p.pathThumb,
    width: p.width,
    height: p.height,
    bytes: p.bytes,
    capturedAt: p.capturedAt ? p.capturedAt.toISOString() : null,
    gps: p.gps,
    uploadedById: p.uploadedById,
    deletedAt: p.deletedAt ? p.deletedAt.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Mutations (audited)
// ---------------------------------------------------------------------------

export interface UploadPhotoResult {
  id: string;
  width: number;
  height: number;
  bytes: number;
}

/**
 * Process + persist a single uploaded image. Steps:
 *
 *   1. Permission + scope check (refuses non-members and locked reports
 *      before touching disk).
 *   2. Run the sharp pipeline (resize 1920 px, thumb 400 px, JPEG, no
 *      EXIF). May throw `InvalidImageError` / `ImageTooLargeError`.
 *   3. Write both variants to DATA_DIR.
 *   4. Insert the `Photo` row inside `withAudit()` so a hash-chained
 *      audit entry is created atomically. If the transaction fails the
 *      already-written files are removed (best effort).
 */
export async function uploadPhoto(opts: {
  reportId: string;
  buffer: Buffer;
  ctx: AuditContext;
  user: SessionUser;
  clientCapturedAt?: Date | null;
  clientGps?: { lat: number; lon: number } | null;
}): Promise<UploadPhotoResult> {
  const {
    reportId,
    buffer,
    ctx,
    user,
    clientCapturedAt,
    clientGps,
  } = opts;

  const reportCtx = await loadReportContext(reportId, user);
  if (reportCtx.reportLocked) throw new ReportLockedError();
  assertCan(user, "photo.upload", {
    projectMember: reportCtx.isMember,
    reportLocked: reportCtx.reportLocked,
  });

  const startedRender = Date.now();
  let processed;
  try {
    processed = await processImage(buffer);
  } catch (err) {
    if (err instanceof InvalidImageError || err instanceof ImageTooLargeError) {
      logger.warn("photo.upload.invalid", { reason: err.message, bytes: buffer.length });
    } else {
      logger.error("photo.upload.error", err, { bytes: buffer.length });
    }
    throw err;
  }
  
  // Prefer EXIF harvested by the browser BEFORE the resize stripped
  // it. If the client did not (or could not) send any, fall back to
  // server-side parsing — this still works for legacy clients or
  // server-side ingestion paths (e.g. integration tests).
  let capturedAt: Date | null;
  let gps: { lat: number; lon: number } | null;
  if (clientCapturedAt !== undefined || clientGps !== undefined) {
    capturedAt = clientCapturedAt ?? null;
    gps = clientGps ?? null;
  } else {
    const exif = await parseExifSafely(buffer);
    capturedAt = exif.capturedAt;
    gps = exif.gps;
  }
  const stored = await writePhotoVariants({
    projectId: reportCtx.projectId,
    reportId: reportCtx.reportId,
    main: processed.main,
    thumb: processed.thumb,
  });

  try {
    const photo = await withAudit<Photo>(
      {
        ctx,
        action: "photo.upload",
        entityType: "photo",
        resolveEntityId: (p) => p.id,
        before: null,
        projectAfter: photoForAudit,
      },
      (tx) =>
        tx.photo.create({
          data: {
            reportId,
            pathOriginal: stored.pathOriginal,
            pathThumb: stored.pathThumb,
            width: processed.width,
            height: processed.height,
            bytes: stored.bytes,
            uploadedById: user.id,
            capturedAt,
            gps: gps ?? undefined,
          },
        }),
    );
    logger.info("photo.upload.done", { userId: user.id, photoId: photo.id, bytes: stored.bytes, durationMs: Date.now() - startedRender });
    return {
      id: photo.id,
      width: photo.width,
      height: photo.height,
      bytes: photo.bytes,
    };
  } catch (err) {
    // Roll the files back so a failed insert does not leak storage.
    await deletePhotoVariants({
      pathOriginal: stored.pathOriginal,
      pathThumb: stored.pathThumb,
    });
    throw err;
  }
}

/**
 * Soft-delete a photo (`deletedAt` set). Files stay on disk so that we
 * keep the chain of custody intact (legal context — the appendix to
 * Vyhláška 499/2006 doesn't allow silent removal of evidence). BOSS-only
 * and only while the report is unlocked.
 */
export async function softDeletePhoto(opts: {
  photoId: string;
  ctx: AuditContext;
  user: SessionUser;
}): Promise<void> {
  const { photoId, ctx, user } = opts;

  const photo = await prisma.photo.findFirst({
    where: { id: photoId, deletedAt: null },
    select: {
      id: true,
      reportId: true,
      pathOriginal: true,
      pathThumb: true,
      width: true,
      height: true,
      bytes: true,
      uploadedById: true,
      createdAt: true,
    },
  });
  if (!photo) throw new PhotoNotFoundError();

  const reportCtx = await loadReportContext(photo.reportId, user);
  if (reportCtx.reportLocked) throw new ReportLockedError();
  assertCan(user, "photo.delete", {
    projectMember: reportCtx.isMember,
    reportLocked: reportCtx.reportLocked,
  });

  await withAudit(
    {
      ctx,
      action: "photo.delete",
      entityType: "photo",
      resolveEntityId: (p: { id: string }) => p.id,
      before: {
        id: photo.id,
        reportId: photo.reportId,
        pathOriginal: photo.pathOriginal,
        pathThumb: photo.pathThumb,
        bytes: photo.bytes,
        uploadedById: photo.uploadedById,
      },
      projectAfter: (p: { id: string; deletedAt: Date | null }) => ({
        id: p.id,
        deletedAt: p.deletedAt ? p.deletedAt.toISOString() : null,
      }),
    },
    (tx) =>
      tx.photo.update({
        where: { id: photoId },
        data: { deletedAt: new Date() },
      }),
  );
}

// ---------------------------------------------------------------------------
// Queries (scope-aware)
// ---------------------------------------------------------------------------

export interface PhotoListItem {
  id: string;
  width: number;
  height: number;
  bytes: number;
  createdAt: Date;
  capturedAt: Date | null;
  gps: { lat: number; lon: number } | null;
  uploadedByName: string;
}

/**
 * List active photos for a report (oldest first), enforcing the project
 * scope. Throws `ReportNotFoundError` / `ProjectNotAccessibleError`
 * uniformly so the caller cannot distinguish "no access" from "no
 * report".
 */
export async function listPhotosForReport(opts: {
  reportId: string;
  user: SessionUser;
}): Promise<PhotoListItem[]> {
  const { reportId, user } = opts;
  await loadReportContext(reportId, user);

  const rows = await prisma.photo.findMany({
    where: { reportId, deletedAt: null },
    orderBy: { createdAt: "asc" },
    include: { uploader: { select: { displayName: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    width: r.width,
    height: r.height,
    bytes: r.bytes,
    createdAt: r.createdAt,
    capturedAt: r.capturedAt,
    gps: coerceGpsJson(r.gps),
    uploadedByName: r.uploader.displayName,
  }));
}

/** Narrow the persisted JSON gps shape back into our typed pair. */
function coerceGpsJson(value: unknown): { lat: number; lon: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.lat === "number" && typeof rec.lon === "number") {
    return { lat: rec.lat, lon: rec.lon };
  }
  return null;
}

export type PhotoVariant = "main" | "thumb";

export interface PhotoFileResult {
  absolutePath: string;
  bytes: number;
}

/**
 * Resolve a photo's on-disk path for a given (auth-checked) user, with
 * defence-in-depth path-traversal protection. Returns `null` for
 * out-of-scope users and missing photos — the serving route should map
 * that to 404 without distinguishing between the two.
 */
export async function getPhotoFileForUser(opts: {
  photoId: string;
  variant: PhotoVariant;
  user: SessionUser;
}): Promise<PhotoFileResult | null> {
  const { photoId, variant, user } = opts;

  const photo = await prisma.photo.findFirst({
    where: { id: photoId, deletedAt: null },
    select: {
      pathOriginal: true,
      pathThumb: true,
      report: {
        select: {
          projectId: true,
          project: {
            select: {
              deletedAt: true,
              members: {
                where: { userId: user.id },
                select: { userId: true },
              },
            },
          },
        },
      },
    },
  });
  if (!photo) return null;
  if (photo.report.project.deletedAt !== null) return null;
  const isMember = photo.report.project.members.length > 0;
  if (!canAccessProject(user.role, isMember)) return null;

  const rel = variant === "thumb" ? photo.pathThumb : photo.pathOriginal;
  const abs = resolvePhotoAbsolutePath(rel);
  if (!abs) return null;
  try {
    const stat = await fs.stat(abs);
    return { absolutePath: abs, bytes: stat.size };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Capability helper for the report-detail server component
// ---------------------------------------------------------------------------

/** True if the user is a member of the report's project AND it's unlocked. */
export async function canUploadToReport(
  reportId: string,
  user: SessionUser,
): Promise<boolean> {
  try {
    const reportCtx = await loadReportContext(reportId, user);
    if (reportCtx.reportLocked) return false;
    return (user.role === "BOSS" || user.role === "WORKER") && reportCtx.isMember;
  } catch {
    return false;
  }
}

/** True if BOSS member can delete (used to render the bin button). */
export async function canDeleteInReport(
  reportId: string,
  user: SessionUser,
): Promise<boolean> {
  try {
    const reportCtx = await loadReportContext(reportId, user);
    if (reportCtx.reportLocked) return false;
    return user.role === "BOSS" && reportCtx.isMember;
  } catch {
    return false;
  }
}
