import "server-only";

import { prisma } from "@/lib/db";
import type { SessionUser } from "@/server/permissions";

/**
 * Cross-project aggregates for the authenticated BOSS landing page.
 *
 * Scope:
 *   * Counts cover ALL projects (BOSS oversight is firm-wide).
 *   * Lists are capped (10 / 20 rows) so the page renders fast even
 *     after a year of construction; the user clicks through to the
 *     project detail for the long form.
 *
 * BOSS-only — the route should return 404 for other roles. We still
 * accept a `SessionUser` so the function is consistent with the rest
 * of the service layer (and so unit tests can swap in any user
 * without touching the auth singleton).
 */

export interface UnsignedByProject {
  projectId: string;
  projectName: string;
  unsignedCount: number;
}

export interface PendingMaterialNeed {
  id: string;
  projectId: string;
  projectName: string;
  reportDate: Date;
  text: string;
  neededBy: Date | null;
  authorName: string;
}

export interface RecentReportRow {
  id: string;
  projectId: string;
  projectName: string;
  date: Date;
  authorName: string;
  signed: boolean;
}

export interface TimelineProject {
  id: string;
  name: string;
  startedAt: Date;
  /** `null` means the project is ongoing (no end date set). */
  endedAt: Date | null;
}

export interface MaterialTimelineEntry {
  id: string;
  projectId: string;
  projectName: string;
  text: string;
  /** When the requirement was raised. */
  createdAt: Date;
  /** Deadline if provided. */
  neededBy: Date | null;
  /** When the BOSS/WORKER ticked it as done; null while pending. */
  resolvedAt: Date | null;
  resolved: boolean;
}

export interface BossDashboard {
  activeProjects: number;
  archivedProjects: number;
  membersTotal: number;
  unsignedReportsTotal: number;
  reportsLast7Days: number;
  pendingMaterialsTotal: number;
  unsignedByProject: UnsignedByProject[];
  pendingMaterials: PendingMaterialNeed[];
  recentReports: RecentReportRow[];
  timelineProjects: TimelineProject[];
  materialsTimeline: MaterialTimelineEntry[];
}

/**
 * Build the BOSS dashboard payload. Throws if the caller is not a
 * BOSS (defensive — the route also gates via `requireBoss`).
 */
export async function getBossDashboard(
  user: SessionUser,
): Promise<BossDashboard> {
  if (user.role !== "BOSS") {
    throw new Error("getBossDashboard: caller is not a BOSS");
  }

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const [
    activeProjects,
    archivedProjects,
    membersTotal,
    unsignedReportsTotal,
    reportsLast7Days,
    pendingMaterialsTotal,
    unsignedRows,
    pendingMaterialsRows,
    recentReportRows,
    timelineRows,
    materialsTimelineRows,
  ] = await Promise.all([
    prisma.project.count({ where: { deletedAt: null } }),
    prisma.project.count({ where: { deletedAt: { not: null } } }),
    prisma.projectMember.count(),
    prisma.dailyReport.count({
      where: { deletedAt: null, signedAt: null },
    }),
    prisma.dailyReport.count({
      where: { deletedAt: null, date: { gte: sevenDaysAgo } },
    }),
    prisma.materialNeed.count({
      where: { deletedAt: null, resolved: false },
    }),
    // Top projects by unsigned-report count (active projects only).
    prisma.dailyReport.groupBy({
      by: ["projectId"],
      where: { deletedAt: null, signedAt: null, project: { deletedAt: null } },
      _count: { id: true },
      orderBy: { _count: { id: "desc" } },
      take: 10,
    }),
    // Pending material needs across all active projects.
    prisma.materialNeed.findMany({
      where: {
        deletedAt: null,
        resolved: false,
        report: { deletedAt: null, project: { deletedAt: null } },
      },
      orderBy: [{ neededBy: "asc" }, { createdAt: "asc" }],
      take: 20,
      include: {
        report: {
          select: {
            date: true,
            project: { select: { id: true, name: true } },
            author: { select: { displayName: true } },
          },
        },
      },
    }),
    // Most recent reports (regardless of signing state).
    prisma.dailyReport.findMany({
      where: { deletedAt: null, project: { deletedAt: null } },
      orderBy: { date: "desc" },
      take: 10,
      select: {
        id: true,
        date: true,
        signedAt: true,
        project: { select: { id: true, name: true } },
        author: { select: { displayName: true } },
      },
    }),
    // Timeline rows for the Gantt — only projects that have actually
    // started (no `startedAt` = nothing to plot).
    prisma.project.findMany({
      where: { deletedAt: null, startedAt: { not: null } },
      orderBy: { startedAt: "asc" },
      take: 50,
      select: { id: true, name: true, startedAt: true, endedAt: true },
    }),
    // Materials timeline — rows with EITHER a neededBy deadline OR a
    // recorded resolvedAt (so a bar always has a span). Pending items
    // come first (the BOSS cares about what's outstanding), then the
    // most recently resolved ones for context. Capped at 50 entries
    // so the rendered Gantt stays readable.
    prisma.materialNeed.findMany({
      where: {
        deletedAt: null,
        report: { deletedAt: null, project: { deletedAt: null } },
        OR: [{ neededBy: { not: null } }, { resolvedAt: { not: null } }],
      },
      orderBy: [
        { resolved: "asc" }, // false first
        { neededBy: "asc" },
        { createdAt: "asc" },
      ],
      take: 50,
      select: {
        id: true,
        text: true,
        createdAt: true,
        neededBy: true,
        resolvedAt: true,
        resolved: true,
        report: {
          select: {
            project: { select: { id: true, name: true } },
          },
        },
      },
    }),
  ]);

  const projectIds = unsignedRows.map((r) => r.projectId);
  const projectsForUnsigned =
    projectIds.length === 0
      ? []
      : await prisma.project.findMany({
          where: { id: { in: projectIds } },
          select: { id: true, name: true },
        });
  const nameByProjectId = new Map(
    projectsForUnsigned.map((p) => [p.id, p.name] as const),
  );

  return {
    activeProjects,
    archivedProjects,
    membersTotal,
    unsignedReportsTotal,
    reportsLast7Days,
    pendingMaterialsTotal,
    unsignedByProject: unsignedRows.map((r) => ({
      projectId: r.projectId,
      projectName: nameByProjectId.get(r.projectId) ?? "(neznámá zakázka)",
      unsignedCount: r._count.id,
    })),
    pendingMaterials: pendingMaterialsRows.map((m) => ({
      id: m.id,
      projectId: m.report.project.id,
      projectName: m.report.project.name,
      reportDate: m.report.date,
      text: m.text,
      neededBy: m.neededBy,
      authorName: m.report.author.displayName,
    })),
    recentReports: recentReportRows.map((r) => ({
      id: r.id,
      projectId: r.project.id,
      projectName: r.project.name,
      date: r.date,
      authorName: r.author.displayName,
      signed: r.signedAt !== null,
    })),
    timelineProjects: timelineRows.flatMap((p) =>
      p.startedAt
        ? [
            {
              id: p.id,
              name: p.name,
              startedAt: p.startedAt,
              endedAt: p.endedAt,
            } satisfies TimelineProject,
          ]
        : [],
    ),
    materialsTimeline: materialsTimelineRows.map((m) => ({
      id: m.id,
      projectId: m.report.project.id,
      projectName: m.report.project.name,
      text: m.text,
      createdAt: m.createdAt,
      neededBy: m.neededBy,
      resolvedAt: m.resolvedAt,
      resolved: m.resolved,
    })),
  };
}
