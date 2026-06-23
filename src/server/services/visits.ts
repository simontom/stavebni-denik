import "server-only";

import { z } from "zod";

import { prisma } from "@/lib/db";
import type { Visit } from "@/generated/prisma/client";
import { VISITOR_ROLES, type VisitorRole } from "@/lib/visits-types";

import type { AuditContext } from "@/server/audit";
import { withAudit } from "@/server/audit";
import {
  assertCan,
  canAccessProject,
  ForbiddenError,
  type SessionUser,
} from "@/server/permissions";

// Re-export pure constants tak, aby ostatní server kód mohl spolehlivě
// brát všechno z jednoho místa.
export { VISITOR_ROLES };
export type { VisitorRole };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class VisitNotFoundError extends Error {
  code = "VisitNotFound" as const;
}

export class ReportLockedError extends Error {
  code = "ReportLocked" as const;
}

export class ProjectAccessDeniedError extends Error {
  code = "ProjectAccessDenied" as const;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SHORT_MAX = 200;
const LONG_MAX = 5000;

export const visitCreateSchema = z.object({
  reportId: z.string().min(1),
  visitorName: z
    .string()
    .trim()
    .min(1, "Vyplňte jméno návštěvníka.")
    .max(SHORT_MAX),
  visitorRole: z.enum(VISITOR_ROLES),
  organization: z
    .string()
    .trim()
    .max(SHORT_MAX)
    .nullish()
    .transform((v) => (v === "" ? null : (v ?? null))),
  visitedAt: z.coerce.date({
    message: "Vyplňte platný čas návštěvy.",
  }),
  purpose: z.string().trim().min(1, "Vyplňte účel návštěvy.").max(LONG_MAX),
  notes: z
    .string()
    .trim()
    .max(LONG_MAX)
    .nullish()
    .transform((v) => (v === "" ? null : (v ?? null))),
});

export type VisitCreateInput = z.input<typeof visitCreateSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Audit projection — vše krom soft-delete cesty co je v before/after redundantní. */
function projectVisitForAudit(v: Visit) {
  return {
    id: v.id,
    reportId: v.reportId,
    visitorName: v.visitorName,
    visitorRole: v.visitorRole,
    organization: v.organization,
    visitedAt: v.visitedAt,
    purpose: v.purpose,
    notes: v.notes,
    authorId: v.authorId,
    deletedAt: v.deletedAt,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface CreateArgs {
  input: VisitCreateInput;
  user: SessionUser;
  ctx: AuditContext;
}

export async function createVisit({
  input,
  user,
  ctx,
}: CreateArgs): Promise<Visit> {
  const data = visitCreateSchema.parse(input);

  // Pre-flight: report existuje, user má přístup, není locked.
  const report = await prisma.dailyReport.findFirst({
    where: { id: data.reportId, deletedAt: null },
    select: { id: true, projectId: true, lockedAt: true },
  });
  if (!report) throw new VisitNotFoundError();

  const member = await prisma.projectMember.findUnique({
    where: {
      projectId_userId: {
        projectId: report.projectId,
        userId: user.id,
      },
    },
    select: { role: true },
  });
  const isMember = member !== null;
  if (!canAccessProject(user.role, isMember)) {
    throw new ProjectAccessDeniedError();
  }
  if (report.lockedAt) throw new ReportLockedError();

  assertCan(user, "visit.create", { projectMember: isMember });

  return withAudit(
    {
      ctx,
      action: "visit.create",
      entityType: "visit",
      resolveEntityId: (v) => v.id,
      before: null,
      projectAfter: projectVisitForAudit,
    },
    (tx) =>
      tx.visit.create({
        data: {
          reportId: data.reportId,
          visitorName: data.visitorName,
          visitorRole: data.visitorRole,
          organization: data.organization,
          visitedAt: data.visitedAt,
          purpose: data.purpose,
          notes: data.notes,
          authorId: user.id,
        },
      }),
  );
}

interface DeleteArgs {
  id: string;
  user: SessionUser;
  ctx: AuditContext;
}

export async function deleteVisit({ id, user, ctx }: DeleteArgs): Promise<void> {
  const visit = await prisma.visit.findFirst({
    where: { id, deletedAt: null },
    include: {
      report: { select: { lockedAt: true, projectId: true } },
    },
  });
  if (!visit) throw new VisitNotFoundError();
  if (visit.report.lockedAt) throw new ReportLockedError();

  const member = await prisma.projectMember.findUnique({
    where: {
      projectId_userId: {
        projectId: visit.report.projectId,
        userId: user.id,
      },
    },
    select: { role: true },
  });
  const isMember = member !== null;

  // BOSS vždy pokud member; jinak jen autor zápisu (pokud member).
  const allowed =
    isMember && (user.role === "BOSS" || visit.authorId === user.id);
  if (!allowed) throw new ForbiddenError("visit.delete");

  await withAudit(
    {
      ctx,
      action: "visit.delete",
      entityType: "visit",
      resolveEntityId: (v) => v.id,
      before: projectVisitForAudit(visit),
      projectAfter: projectVisitForAudit,
    },
    (tx) =>
      tx.visit.update({
        where: { id },
        data: { deletedAt: new Date() },
      }),
  );
}

export interface VisitListItem {
  id: string;
  visitorName: string;
  visitorRole: string;
  organization: string | null;
  visitedAt: Date;
  purpose: string;
  notes: string | null;
  authorId: string;
  authorName: string;
  createdAt: Date;
}

export async function listVisitsForReport(
  reportId: string,
): Promise<VisitListItem[]> {
  const rows = await prisma.visit.findMany({
    where: { reportId, deletedAt: null },
    orderBy: [{ visitedAt: "asc" }, { createdAt: "asc" }],
    include: { author: { select: { displayName: true } } },
  });
  return rows.map((v) => ({
    id: v.id,
    visitorName: v.visitorName,
    visitorRole: v.visitorRole,
    organization: v.organization,
    visitedAt: v.visitedAt,
    purpose: v.purpose,
    notes: v.notes,
    authorId: v.authorId,
    authorName: v.author.displayName,
    createdAt: v.createdAt,
  }));
}
