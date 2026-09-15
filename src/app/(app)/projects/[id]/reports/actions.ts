"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { returnServerError } from "next-safe-action";

import { pragueDayStart } from "@/lib/dates";
import { getAuditContext } from "@/server/audit-context";
import { ForbiddenError } from "@/server/permissions";
import { requireUser } from "@/server/rbac";
import { authActionClient, bossActionClient } from "@/server/safe-action";
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
import {
  ProjectAccessDeniedError as VisitProjectAccessError,
  ReportLockedError as VisitReportLockedError,
  VisitNotFoundError,
  createVisit,
  deleteVisit,
  visitCreateSchema,
} from "@/server/services/visits";

import type { ReportFormState } from "./report-form-types";

/** Map a failed zod parse into field-level error messages. */
function toFieldErrors(issues: { path: PropertyKey[]; message: string }[]): ReportFormState {
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
  revalidatePath(`/projects/${projectId}/reports/${dateStr}`);
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
  revalidatePath(`/projects/${projectId}/reports/${dateStr}`);
  redirect(`/projects/${projectId}/reports/${dateStr}`);
}

/** Append a remark (allowed for GUEST/TDS members). */
export const addRemarkAction = authActionClient
  .schema(
    z.object({
      reportId: z.string().min(1),
      text: z.string().trim().min(1, "Text připomínky je povinný."),
      isOfficial: z.boolean().default(false),
      projectId: z.string().min(1),
      date: z.string().min(1),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    try {
      await addRemark({
        reportId: parsedInput.reportId,
        text: parsedInput.text,
        isOfficial: parsedInput.isOfficial,
        ctx: ctx.auditContext,
        user: ctx.user,
      });
      revalidatePath(`/projects/${parsedInput.projectId}/reports/${parsedInput.date}`);
      return { ok: true };
    } catch (err) {
      if (err instanceof ForbiddenError) {
        returnServerError("Nemáte oprávnění přidat připomínku.");
      }
      if (err instanceof ReportLockedError) {
        returnServerError("Záznam je uzamčen.");
      }
      throw err;
    }
  });

/** Add a "material needed" checklist item. */
export const addMaterialAction = authActionClient
  .schema(
    z.object({
      reportId: z.string().min(1),
      text: z.string().trim().min(1, "Text materiálu je povinný."),
      neededBy: z.string().optional().nullable(),
      projectId: z.string().min(1),
      date: z.string().min(1),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    const neededBy =
      parsedInput.neededBy && parsedInput.neededBy.trim().length > 0
        ? new Date(`${parsedInput.neededBy.trim()}T00:00:00`)
        : null;

    try {
      await addMaterialNeed({
        reportId: parsedInput.reportId,
        text: parsedInput.text,
        neededBy,
        ctx: ctx.auditContext,
        user: ctx.user,
      });
      revalidatePath(`/projects/${parsedInput.projectId}/reports/${parsedInput.date}`);
      return { ok: true };
    } catch (err) {
      if (err instanceof ForbiddenError) {
        returnServerError("Nemáte oprávnění přidat materiál.");
      }
      if (err instanceof ReportLockedError) {
        returnServerError("Záznam je uzamčen.");
      }
      throw err;
    }
  });

/** Toggle the resolved state of a material checklist item. */
export const toggleMaterialAction = authActionClient
  .schema(
    z.object({
      materialId: z.string().min(1),
      resolved: z.boolean(),
      projectId: z.string().min(1),
      date: z.string().min(1),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    try {
      await setMaterialResolved({
        materialId: parsedInput.materialId,
        resolved: parsedInput.resolved,
        ctx: ctx.auditContext,
        user: ctx.user,
      });
      revalidatePath(`/projects/${parsedInput.projectId}/reports/${parsedInput.date}`);
      return { ok: true };
    } catch (err) {
      if (err instanceof ForbiddenError) {
        returnServerError("Nemáte oprávnění měnit stav položky.");
      }
      if (err instanceof ReportLockedError) {
        returnServerError("Záznam je uzamčen.");
      }
      throw err;
    }
  });

/**
 * Bulk-resolve a set of material checklist items.
 */
export const bulkResolveMaterialsAction = authActionClient
  .schema(
    z.object({
      materialIds: z.array(z.string()),
      projectId: z.string().min(1),
      date: z.string().min(1),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    for (const materialId of parsedInput.materialIds) {
      try {
        await setMaterialResolved({
          materialId,
          resolved: true,
          ctx: ctx.auditContext,
          user: ctx.user,
        });
      } catch {
        // Swallow per-item errors so a single invalid item doesn't stop the rest.
      }
    }
    revalidatePath(`/projects/${parsedInput.projectId}/reports/${parsedInput.date}`);
    return { ok: true };
  });

/**
 * Roll a single open material need to a later day.
 */
export const rolloverMaterialAction = authActionClient
  .schema(
    z.object({
      materialId: z.string().min(1),
      targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Vyberte cílový den."),
      projectId: z.string().min(1),
      date: z.string().min(1),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    try {
      await rolloverMaterial({
        materialId: parsedInput.materialId,
        targetDate: pragueDayStart(parsedInput.targetDate),
        ctx: ctx.auditContext,
        user: ctx.user,
      });
      revalidatePath(`/projects/${parsedInput.projectId}/reports/${parsedInput.date}`);
      return { ok: true };
    } catch (err) {
      if (err instanceof ForbiddenError) {
        returnServerError("Nemáte oprávnění přesunout položku.");
      }
      if (err instanceof MaterialNotFoundError) {
        returnServerError(err.message);
      }
      if (err instanceof MaterialAlreadyResolvedError) {
        returnServerError(err.message);
      }
      if (err instanceof InvalidRolloverTargetError) {
        returnServerError(err.message);
      }
      if (err instanceof TargetReportMissingError) {
        returnServerError(err.message);
      }
      if (err instanceof ReportLockedError) {
        returnServerError(err.message);
      }
      returnServerError("Přesunutí se nezdařilo.");
    }
  });

/** Fill in the weather by hand when the automatic fetch failed. */
export const setManualWeatherAction = authActionClient
  .schema(
    z.object({
      reportId: z.string().min(1),
      projectId: z.string().min(1),
      date: z.string().min(1),
      tempMinC: z.number().nullable().optional(),
      tempMaxC: z.number().nullable().optional(),
      precipitationMm: z.number().nullable().optional(),
      windMaxKmh: z.number().nullable().optional(),
      summary: z.string().nullable().optional(),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    try {
      await setManualWeather({
        reportId: parsedInput.reportId,
        input: {
          tempMinC: parsedInput.tempMinC ?? null,
          tempMaxC: parsedInput.tempMaxC ?? null,
          precipitationMm: parsedInput.precipitationMm ?? null,
          windMaxKmh: parsedInput.windMaxKmh ?? null,
          summary: parsedInput.summary ?? null,
        },
        ctx: ctx.auditContext,
        user: ctx.user,
      });
      revalidatePath(`/projects/${parsedInput.projectId}/reports/${parsedInput.date}`);
      return { ok: true };
    } catch (err) {
      if (err instanceof ForbiddenError) {
        returnServerError("Nemáte oprávnění nastavit počasí.");
      }
      if (err instanceof ReportLockedError) {
        returnServerError("Záznam je uzamčen.");
      }
      throw err;
    }
  });

/** Soft-delete a photo (BOSS-only on unlocked reports). */
export const deletePhotoAction = bossActionClient
  .schema(
    z.object({
      photoId: z.string().min(1),
      projectId: z.string().min(1),
      date: z.string().min(1),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    try {
      await softDeletePhoto({
        photoId: parsedInput.photoId,
        ctx: ctx.auditContext,
        user: ctx.user,
      });
      revalidatePath(`/projects/${parsedInput.projectId}/reports/${parsedInput.date}`);
      return { ok: true };
    } catch (err) {
      if (err instanceof ForbiddenError) {
        returnServerError("Nemáte oprávnění odstranit fotku.");
      }
      throw err;
    }
  });

/** Sign + lock a daily report (BOSS only). Idempotent at the service level. */
export const signReportAction = bossActionClient
  .schema(
    z.object({
      reportId: z.string().min(1),
      projectId: z.string().min(1),
      date: z.string().min(1),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    try {
      await signReport({
        reportId: parsedInput.reportId,
        ctx: ctx.auditContext,
        user: ctx.user,
      });
      revalidatePath(`/projects/${parsedInput.projectId}/reports/${parsedInput.date}`);
      return { ok: true };
    } catch (err) {
      if (err instanceof ForbiddenError) {
        returnServerError("Nemáte oprávnění podepsat záznam.");
      }
      throw err;
    }
  });

/** Append an addendum to a signed report (BOSS / WORKER members). */
export const addAddendumAction = authActionClient
  .schema(
    z.object({
      reportId: z.string().min(1),
      text: z.string().trim().min(1, "Text dodatku je povinný."),
      projectId: z.string().min(1),
      date: z.string().min(1),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    try {
      await addAddendum({
        reportId: parsedInput.reportId,
        text: parsedInput.text,
        ctx: ctx.auditContext,
        user: ctx.user,
      });
      revalidatePath(`/projects/${parsedInput.projectId}/reports/${parsedInput.date}`);
      return { ok: true };
    } catch (err) {
      if (err instanceof ForbiddenError) {
        returnServerError("Nemáte oprávnění přidat dodatek.");
      }
      throw err;
    }
  });

/** Delete (soft-delete) a visit. */
export const deleteVisitAction = authActionClient
  .schema(
    z.object({
      id: z.string().min(1),
      projectId: z.string().min(1),
      date: z.string().min(1),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    try {
      await deleteVisit({ id: parsedInput.id, user: ctx.user, ctx: ctx.auditContext });
      revalidatePath(`/projects/${parsedInput.projectId}/reports/${parsedInput.date}`);
      return { ok: true };
    } catch (err) {
      if (err instanceof ForbiddenError) {
        returnServerError("Nemáte oprávnění smazat návštěvu.");
      }
      throw err;
    }
  });

/** Investor confirmation of report. */
export const acknowledgeReportAction = authActionClient
  .schema(
    z.object({
      reportId: z.string().min(1),
      projectId: z.string().min(1),
      date: z.string().min(1),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    try {
      const { acknowledgeReport } = await import("@/server/services/reports");
      await acknowledgeReport({
        reportId: parsedInput.reportId,
        ctx: ctx.auditContext,
        user: ctx.user,
      });
      revalidatePath(`/projects/${parsedInput.projectId}/reports/${parsedInput.date}`);
      return { ok: true };
    } catch (err) {
      if (err instanceof ForbiddenError) {
        returnServerError("Nemáte oprávnění potvrdit seznámení.");
      }
      throw err;
    }
  });

/**
 * Add a visit/inspection entry to a daily report.
 */
export const addVisitAction = authActionClient
  .schema(
    visitCreateSchema.extend({
      projectId: z.string().min(1),
      date: z.string().min(1),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    try {
      await createVisit({
        input: {
          reportId: parsedInput.reportId,
          visitorName: parsedInput.visitorName,
          visitorRole: parsedInput.visitorRole,
          organization: parsedInput.organization,
          visitedAt: parsedInput.visitedAt,
          purpose: parsedInput.purpose,
          notes: parsedInput.notes,
        },
        user: ctx.user,
        ctx: ctx.auditContext,
      });
      revalidatePath(`/projects/${parsedInput.projectId}/reports/${parsedInput.date}`);
      return { ok: true };
    } catch (err) {
      if (err instanceof ForbiddenError || err instanceof VisitProjectAccessError) {
        returnServerError("Nemáte oprávnění zapsat návštěvu.");
      }
      if (err instanceof VisitReportLockedError) {
        returnServerError("Záznam je podepsaný a uzamčený — návštěva musí jít přes dodatek.");
      }
      if (err instanceof VisitNotFoundError) {
        returnServerError("Záznam neexistuje.");
      }
      returnServerError("Uložení návštěvy se nezdařilo.");
    }
  });
