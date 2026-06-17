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
 *   - `files`: one or more `File` parts (repeated field, required).
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

  const ctx = await getAuditContext();
  const uploaded: UploadSuccess[] = [];
  const failed: UploadFailure[] = [];

  // Process files sequentially so one giant pipeline does not crowd
  // out the others on a small machine. (sharp is heavy.)
  for (const file of files) {
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const result = await uploadPhoto({ reportId, buffer, ctx, user });
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
