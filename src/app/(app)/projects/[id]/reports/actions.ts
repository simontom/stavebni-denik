"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { pragueDayStart } from "@/lib/dates";
import { getAuditContext } from "@/server/audit-context";
import { ForbiddenError } from "@/server/permissions";
import { requireUser } from "@/server/rbac";
import {
  InvalidRolloverTargetError,
  MaterialAlreadyResolvedError,
  MaterialNotFoundError,
  ReportExistsError,
  ReportLockedError,
  TargetReportMissingError,
  addAddendum,
  addMaterialNeed,
  addRemark,
  createReport,
  reportFormSchema,
  normalizeReportForm,
  rolloverMaterial,
  setMaterialResolved,
  setManualWeather,
  signReport,
  updateReport,
} from "@/server/services/reports";
import { softDeletePhoto } from "@/server/services/photos";

import type { ReportFormState } from "./report-form-types";

/** Map a failed zod parse into field-level error messages. */
function toFieldErrors(
  issues: { path: PropertyKey[]; message: string }[],
): ReportFormState {
  const fieldErrors: Record<string, string> = {};
  for (const issue of issues) {
    const field = issue.path[0];
    const key = typeof field === "string" ? field : "workersByTrade";
    if (!fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  return { status: "field-error", fieldErrors };
}

/**
 * Create a daily report for `(projectId, date)`. The project id and the
 * day are bound on the server so the client form can neither carry nor
 * tamper with the target.
 */
export async function createReportAction(
  projectId: string,
  dateStr: string,
  _prev: ReportFormState | undefined,
  data: FormData,
): Promise<ReportFormState> {
  const user = await requireUser();

  const parsed = reportFormSchema.safeParse(normalizeReportForm(data));
  if (!parsed.success) return toFieldErrors(parsed.error.issues);

  try {
    const ctx = await getAuditContext();
    await createReport({
      projectId,
      date: pragueDayStart(dateStr),
      input: parsed.data,
      ctx,
      user,
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return { status: "forbidden" };
    if (err instanceof ReportExistsError) return { status: "exists" };
    return { status: "error", message: "Uložení záznamu se nezdařilo." };
  }

  revalidatePath(`/projects/${projectId}`);
  redirect(`/projects/${projectId}/reports/${dateStr}`);
}

/** Edit an existing (unlocked) daily report. */
export async function updateReportAction(
  reportId: string,
  projectId: string,
  dateStr: string,
  _prev: ReportFormState | undefined,
  data: FormData,
): Promise<ReportFormState> {
  const user = await requireUser();

  const parsed = reportFormSchema.safeParse(normalizeReportForm(data));
  if (!parsed.success) return toFieldErrors(parsed.error.issues);

  try {
    const ctx = await getAuditContext();
    await updateReport({ reportId, input: parsed.data, ctx, user });
  } catch (err) {
    if (err instanceof ForbiddenError) return { status: "forbidden" };
    if (err instanceof ReportLockedError) return { status: "locked" };
    return { status: "error", message: "Uložení změn se nezdařilo." };
  }

  revalidatePath(`/projects/${projectId}`);
  redirect(`/projects/${projectId}/reports/${dateStr}`);
}

/** Append a remark (allowed for GUEST/TDS members). */
export async function addRemarkAction(data: FormData): Promise<void> {
  const user = await requireUser();
  const reportId = String(data.get("reportId") ?? "");
  const text = String(data.get("text") ?? "");
  const projectId = String(data.get("projectId") ?? "");
  const dateStr = String(data.get("date") ?? "");
  const isOfficial = String(data.get("isOfficial") ?? "") === "true";
  if (!reportId || text.trim().length === 0) return;

  try {
    const ctx = await getAuditContext();
    await addRemark({ reportId, text, isOfficial, ctx, user });
  } catch {
    return;
  }
  revalidatePath(`/projects/${projectId}/reports/${dateStr}`);
}

/** Add a "material needed" checklist item. */
export async function addMaterialAction(data: FormData): Promise<void> {
  const user = await requireUser();
  const reportId = String(data.get("reportId") ?? "");
  const text = String(data.get("text") ?? "");
  const projectId = String(data.get("projectId") ?? "");
  const dateStr = String(data.get("date") ?? "");
  const neededByRaw = String(data.get("neededBy") ?? "").trim();
  const neededBy = neededByRaw.length > 0 ? new Date(`${neededByRaw}T00:00:00`) : null;
  if (!reportId || text.trim().length === 0) return;

  try {
    const ctx = await getAuditContext();
    await addMaterialNeed({ reportId, text, neededBy, ctx, user });
  } catch {
    return;
  }
  revalidatePath(`/projects/${projectId}/reports/${dateStr}`);
}

/** Toggle the resolved state of a material checklist item. */
export async function toggleMaterialAction(data: FormData): Promise<void> {
  const user = await requireUser();
  const materialId = String(data.get("materialId") ?? "");
  const resolved = String(data.get("resolved") ?? "") === "true";
  const projectId = String(data.get("projectId") ?? "");
  const dateStr = String(data.get("date") ?? "");
  if (!materialId) return;

  try {
    const ctx = await getAuditContext();
    await setMaterialResolved({ materialId, resolved, ctx, user });
  } catch {
    return;
  }
  revalidatePath(`/projects/${projectId}/reports/${dateStr}`);
}

/**
 * Bulk-resolve a set of material checklist items. Each id is funnelled
 * through the audited `setMaterialResolved` so the audit log keeps
 * one row per item — the same as if the user clicked through them
 * individually. Errors on individual ids are swallowed so a single
 * stale id does not undo the whole batch.
 */
export async function bulkResolveMaterialsAction(
  data: FormData,
): Promise<void> {
  const user = await requireUser();
  const ids = data
    .getAll("materialId")
    .map((v) => String(v))
    .filter((s) => s.length > 0);
  const projectId = String(data.get("projectId") ?? "");
  const dateStr = String(data.get("date") ?? "");
  if (ids.length === 0) return;

  const ctx = await getAuditContext();
  for (const materialId of ids) {
    try {
      await setMaterialResolved({
        materialId,
        resolved: true,
        ctx,
        user,
      });
    } catch {
      // Swallow per-item errors (already-resolved, missing id) so a
      // single bad apple doesn't drop the rest of the batch.
    }
  }
  revalidatePath(`/projects/${projectId}/reports/${dateStr}`);
}

export type RolloverState =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "error"; message: string };

/**
 * Roll a single open material need to a later day. Reads `materialId`
 * + `targetDate` (YYYY-MM-DD) + `projectId` + `date` from the form.
 * Returns a discriminated state so the calling component can surface
 * the precise reason (locked target, invalid date, already resolved)
 * rather than silently no-op'ing like the other panel actions.
 */
export async function rolloverMaterialAction(
  _prev: RolloverState | undefined,
  data: FormData,
): Promise<RolloverState> {
  const user = await requireUser();
  const materialId = String(data.get("materialId") ?? "");
  const targetDateStr = String(data.get("targetDate") ?? "");
  const projectId = String(data.get("projectId") ?? "");
  const dateStr = String(data.get("date") ?? "");

  if (!materialId || !/^\d{4}-\d{2}-\d{2}$/.test(targetDateStr)) {
    return { status: "error", message: "Vyberte cílový den." };
  }

  try {
    const ctx = await getAuditContext();
    await rolloverMaterial({
      materialId,
      targetDate: pragueDayStart(targetDateStr),
      ctx,
      user,
    });
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return { status: "error", message: "Nemáte oprávnění přesunout položku." };
    }
    if (err instanceof MaterialNotFoundError) {
      return { status: "error", message: err.message };
    }
    if (err instanceof MaterialAlreadyResolvedError) {
      return { status: "error", message: err.message };
    }
    if (err instanceof InvalidRolloverTargetError) {
      return { status: "error", message: err.message };
    }
    if (err instanceof TargetReportMissingError) {
      return { status: "error", message: err.message };
    }
    if (err instanceof ReportLockedError) {
      return { status: "error", message: err.message };
    }
    return { status: "error", message: "Přesunutí se nezdařilo." };
  }

  revalidatePath(`/projects/${projectId}/reports/${dateStr}`);
  return { status: "ok" };
}

/** Fill in the weather by hand when the automatic fetch failed. */
export async function setManualWeatherAction(data: FormData): Promise<void> {
  const user = await requireUser();
  const reportId = String(data.get("reportId") ?? "");
  const projectId = String(data.get("projectId") ?? "");
  const dateStr = String(data.get("date") ?? "");
  if (!reportId) return;

  const num = (key: string): number | null => {
    const v = String(data.get(key) ?? "").trim();
    if (v.length === 0) return null;
    const n = Number(v.replace(",", "."));
    return Number.isNaN(n) ? null : n;
  };
  const summaryRaw = String(data.get("summary") ?? "").trim();

  try {
    const ctx = await getAuditContext();
    await setManualWeather({
      reportId,
      input: {
        tempMinC: num("tempMinC"),
        tempMaxC: num("tempMaxC"),
        precipitationMm: num("precipitationMm"),
        windMaxKmh: num("windMaxKmh"),
        summary: summaryRaw.length > 0 ? summaryRaw : null,
      },
      ctx,
      user,
    });
  } catch {
    return;
  }
  revalidatePath(`/projects/${projectId}/reports/${dateStr}`);
}

/** Soft-delete a photo (BOSS-only on unlocked reports). */
export async function deletePhotoAction(data: FormData): Promise<void> {
  const user = await requireUser();
  const photoId = String(data.get("photoId") ?? "");
  const projectId = String(data.get("projectId") ?? "");
  const dateStr = String(data.get("date") ?? "");
  if (!photoId) return;

  try {
    const ctx = await getAuditContext();
    await softDeletePhoto({ photoId, ctx, user });
  } catch {
    return;
  }
  revalidatePath(`/projects/${projectId}/reports/${dateStr}`);
}

/** Sign + lock a daily report (BOSS only). Idempotent at the service level. */
export async function signReportAction(data: FormData): Promise<void> {
  const user = await requireUser();
  const reportId = String(data.get("reportId") ?? "");
  const projectId = String(data.get("projectId") ?? "");
  const dateStr = String(data.get("date") ?? "");
  if (!reportId) return;

  try {
    const ctx = await getAuditContext();
    await signReport({ reportId, ctx, user });
  } catch {
    return;
  }
  revalidatePath(`/projects/${projectId}/reports/${dateStr}`);
}

/** Append an addendum to a signed report (BOSS / WORKER members). */
export async function addAddendumAction(data: FormData): Promise<void> {
  const user = await requireUser();
  const reportId = String(data.get("reportId") ?? "");
  const text = String(data.get("text") ?? "");
  const projectId = String(data.get("projectId") ?? "");
  const dateStr = String(data.get("date") ?? "");
  if (!reportId || text.trim().length === 0) return;

  try {
    const ctx = await getAuditContext();
    await addAddendum({ reportId, text, ctx, user });
  } catch {
    return;
  }
  revalidatePath(`/projects/${projectId}/reports/${dateStr}`);
}
