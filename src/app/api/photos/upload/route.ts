import { NextResponse } from "next/server";

import { getAuditContext } from "@/server/audit-context";
import { auth } from "@/server/auth";
import { ForbiddenError, type SessionUser } from "@/server/permissions";
import {
  ImageTooLargeError,
  InvalidImageError,
  ProjectNotAccessibleError,
  ReportLockedError,
  ReportNotFoundError,
  uploadPhoto,
} from "@/server/services/photos";

/**
 * Photo upload endpoint.
 *
 * Accepts a `multipart/form-data` POST with:
 *   - `reportId`: the daily-report id the photos belong to (required),
 *   - `files`: one or more `File` parts (repeated field, required),
 *   - `capturedAt`: ISO date string per file (parallel array, optional —
 *     send `""` for unknown),
 *   - `gps`: JSON `{lat, lon}` per file (parallel array, optional —
 *     send `""` for unknown).
 *
 * The client sends `capturedAt` / `gps` because the browser already
 * resized the picture and stripped its EXIF block; the server falls
 * back to parsing EXIF off the buffer when both extra fields are
 * absent (so legacy callers and server-side integration tests still
 * work).
 *
 * Returns `{ uploaded: [{ id, width, height, bytes }], failed: [{...}] }`
 * — partial success is OK so the uploader UI can mark only the bad
 * pictures and retry. All upload paths funnel through the audited
 * `uploadPhoto` service.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface UploadFailure {
  filename: string;
  reason: string;
}

interface UploadSuccess {
  id: string;
  filename: string;
  width: number;
  height: number;
  bytes: number;
}

function describeFailure(err: unknown): string {
  if (err instanceof InvalidImageError) return err.message;
  if (err instanceof ImageTooLargeError) return err.message;
  if (err instanceof ReportLockedError) return "Záznam je uzamčen.";
  if (err instanceof ForbiddenError)
    return "Nemáte oprávnění nahrávat fotky k tomuto záznamu.";
  if (err instanceof ReportNotFoundError) return "Záznam nebyl nalezen.";
  if (err instanceof ProjectNotAccessibleError)
    return "Záznam nebyl nalezen.";
  return "Nahrání selhalo.";
}

export async function POST(request: Request) {
  const session = await auth();
  const user = session?.user as SessionUser | undefined;
  if (!user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Neplatný formulář." },
      { status: 400 },
    );
  }

  const reportId = String(form.get("reportId") ?? "").trim();
  if (reportId.length === 0) {
    return NextResponse.json(
      { error: "Chybí ID záznamu." },
      { status: 400 },
    );
  }

  const files = form
    .getAll("files")
    .filter((v): v is File => v instanceof File && v.size > 0);
  if (files.length === 0) {
    return NextResponse.json(
      { error: "Nebyl vybrán žádný soubor." },
      { status: 400 },
    );
  }

  // Per-file metadata, index-aligned with `files`. The client sends
  // these as a parallel array so we can attach EXIF that the
  // browser parsed BEFORE the resize stripped it. When the form
  // omits these fields entirely (legacy clients / integration
  // tests), we leave the per-file values `undefined` so the service
  // falls back to parsing EXIF off the buffer.
  const hasClientMeta =
    form.getAll("capturedAt").length > 0 || form.getAll("gps").length > 0;
  const capturedAtParts = form.getAll("capturedAt").map((v) => String(v));
  const gpsParts = form.getAll("gps").map((v) => String(v));

  const ctx = await getAuditContext();
  const uploaded: UploadSuccess[] = [];
  const failed: UploadFailure[] = [];

  // Process files sequentially so one giant pipeline does not crowd
  // out the others on a small machine. (sharp is heavy.)
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const clientCapturedAt = hasClientMeta
      ? parseIsoDate(capturedAtParts[i])
      : undefined;
    const clientGps = hasClientMeta ? parseGps(gpsParts[i]) : undefined;
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const result = await uploadPhoto({
        reportId,
        buffer,
        ctx,
        user,
        clientCapturedAt,
        clientGps,
      });
      uploaded.push({
        id: result.id,
        filename: file.name,
        width: result.width,
        height: result.height,
        bytes: result.bytes,
      });
    } catch (err) {
      // Authorisation failures should make the WHOLE request fail —
      // there is no useful partial state for "you can't write here".
      if (
        err instanceof ForbiddenError ||
        err instanceof ReportNotFoundError ||
        err instanceof ProjectNotAccessibleError ||
        err instanceof ReportLockedError
      ) {
        return NextResponse.json(
          { error: describeFailure(err) },
          {
            status:
              err instanceof ForbiddenError
                ? 403
                : err instanceof ReportLockedError
                  ? 409
                  : 404,
          },
        );
      }
      failed.push({ filename: file.name, reason: describeFailure(err) });
    }
  }

  return NextResponse.json(
    { uploaded, failed },
    { status: uploaded.length > 0 ? 200 : 422 },
  );
}

function parseIsoDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseGps(value: string | undefined): { lat: number; lon: number } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).lat === "number" &&
      typeof (parsed as Record<string, unknown>).lon === "number"
    ) {
      const lat = (parsed as { lat: number }).lat;
      const lon = (parsed as { lon: number }).lon;
      if (
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        lat >= -90 &&
        lat <= 90 &&
        lon >= -180 &&
        lon <= 180
      ) {
        return { lat, lon };
      }
    }
  } catch {
    // ignore malformed payload
  }
  return null;
}
