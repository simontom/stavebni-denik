import "server-only";

import { z } from "zod";

import { prisma } from "@/lib/db";
import type { Prisma, Project, Role } from "@/generated/prisma/client";

import type { AuditContext } from "@/server/audit";
import { withAudit } from "@/server/audit";
import { canAccessProject, type SessionUser } from "@/server/permissions";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Identifikační údaje stavby dle § 157 stavebního zákona a přílohy č. 16
 * vyhlášky č. 499/2006 Sb. Schéma pracuje s již normalizovanými hodnotami
 * (prázdné řetězce → `null`, GPS jako číslo, datumy jako `Date`); mechanické
 * vytažení z `FormData` dělá server action.
 */
export const createProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Vyplňte název stavby.")
    .max(255, "Maximálně 255 znaků."),
  address: z
    .string()
    .trim()
    .min(1, "Vyplňte místo stavby.")
    .max(255, "Maximálně 255 znaků."),
  cadastralArea: z
    .string()
    .trim()
    .min(1, "Vyplňte katastrální území.")
    .max(255, "Maximálně 255 znaků."),
  parcelNumbers: z
    .string()
    .trim()
    .min(1, "Vyplňte parcelní čísla.")
    .max(255, "Maximálně 255 znaků."),
  builder: z
    .string()
    .trim()
    .min(1, "Vyplňte stavebníka.")
    .max(255, "Maximálně 255 znaků."),
  contractor: z
    .string()
    .trim()
    .min(1, "Vyplňte zhotovitele.")
    .max(255, "Maximálně 255 znaků."),
  siteManagerId: z.string().min(1, "Vyberte stavbyvedoucího."),
  permitNumber: z.string().trim().max(255, "Maximálně 255 znaků.").nullable(),
  tdsName: z.string().trim().max(255, "Maximálně 255 znaků.").nullable(),
  bozpName: z.string().trim().max(255, "Maximálně 255 znaků.").nullable(),
  designerName: z.string().trim().max(255, "Maximálně 255 znaků.").nullable(),
  gpsLat: z
    .number()
    .min(-90, "Zeměpisná šířka musí být mezi -90 a 90.")
    .max(90, "Zeměpisná šířka musí být mezi -90 a 90.")
    .nullable(),
  gpsLon: z
    .number()
    .min(-180, "Zeměpisná délka musí být mezi -180 a 180.")
    .max(180, "Zeměpisná délka musí být mezi -180 a 180.")
    .nullable(),
  startedAt: z.date().nullable(),
  endedAt: z.date().nullable(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = CreateProjectInput;

/**
 * Mechanically normalise a project `FormData` payload into the shape the
 * `createProjectSchema` expects: empty optional fields become `null`,
 * GPS becomes a number (Czech decimal comma tolerated), and dates become
 * `Date`. Validation itself is left to the schema so field-level error
 * messages stay in one place.
 */
export function normalizeProjectForm(data: FormData): Record<string, unknown> {
  const str = (key: string): string => {
    const v = data.get(key);
    return typeof v === "string" ? v : "";
  };
  const optStr = (key: string): string | null => {
    const v = str(key).trim();
    return v.length > 0 ? v : null;
  };
  const optNum = (key: string): number | null => {
    const v = str(key).trim();
    if (v.length === 0) return null;
    return Number(v.replace(",", "."));
  };
  const optDate = (key: string): Date | null => {
    const v = str(key).trim();
    if (v.length === 0) return null;
    return new Date(`${v}T00:00:00`);
  };

  return {
    name: str("name"),
    address: str("address"),
    cadastralArea: str("cadastralArea"),
    parcelNumbers: str("parcelNumbers"),
    builder: str("builder"),
    contractor: str("contractor"),
    siteManagerId: str("siteManagerId"),
    permitNumber: optStr("permitNumber"),
    tdsName: optStr("tdsName"),
    bozpName: optStr("bozpName"),
    designerName: optStr("designerName"),
    gpsLat: optNum("gpsLat"),
    gpsLon: optNum("gpsLon"),
    startedAt: optDate("startedAt"),
    endedAt: optDate("endedAt"),
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SiteManagerInvalidError extends Error {
  code = "SiteManagerInvalid" as const;
  constructor() {
    super("Vybraný stavbyvedoucí neexistuje nebo nemá roli stavbyvedoucího.");
  }
}

export class ProjectNotFoundError extends Error {
  code = "ProjectNotFound" as const;
  constructor() {
    super("Zakázka nebyla nalezena.");
  }
}

export class MemberInvalidError extends Error {
  code = "MemberInvalid" as const;
  constructor(message = "Uživatele nelze přiřadit.") {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Audit projection
// ---------------------------------------------------------------------------

/** Project a `Project` row for the audit log (dates as ISO strings). */
function projectForAudit(p: Project) {
  return {
    id: p.id,
    name: p.name,
    address: p.address,
    cadastralArea: p.cadastralArea,
    parcelNumbers: p.parcelNumbers,
    permitNumber: p.permitNumber,
    builder: p.builder,
    contractor: p.contractor,
    siteManagerId: p.siteManagerId,
    tdsName: p.tdsName,
    bozpName: p.bozpName,
    designerName: p.designerName,
    gpsLat: p.gpsLat,
    gpsLon: p.gpsLon,
    startedAt: p.startedAt ? p.startedAt.toISOString() : null,
    endedAt: p.endedAt ? p.endedAt.toISOString() : null,
    createdById: p.createdById,
    deletedAt: p.deletedAt ? p.deletedAt.toISOString() : null,
  };
}

/** Ensure the given user id is an existing, active BOSS (site manager). */
async function assertValidSiteManager(siteManagerId: string): Promise<void> {
  const u = await prisma.user.findUnique({ where: { id: siteManagerId } });
  if (!u || u.deletedAt || !u.isActive || u.role !== "BOSS") {
    throw new SiteManagerInvalidError();
  }
}

// ---------------------------------------------------------------------------
// Mutations (all audited)
// ---------------------------------------------------------------------------

/**
 * BOSS-only — create a new construction project (zakázka). The site
 * manager is also recorded as a project member so the membership-based
 * scope stays consistent (even though BOSS sees every project anyway).
 */
export async function createProject(
  input: CreateProjectInput,
  ctx: AuditContext,
  createdById: string,
): Promise<Project> {
  const data = createProjectSchema.parse(input);
  await assertValidSiteManager(data.siteManagerId);

  return withAudit<Project>(
    {
      ctx,
      action: "project.create",
      entityType: "project",
      resolveEntityId: (p) => p.id,
      before: null,
      projectAfter: projectForAudit,
    },
    (tx) =>
      tx.project.create({
        data: {
          name: data.name,
          address: data.address,
          cadastralArea: data.cadastralArea,
          parcelNumbers: data.parcelNumbers,
          permitNumber: data.permitNumber,
          builder: data.builder,
          contractor: data.contractor,
          siteManagerId: data.siteManagerId,
          tdsName: data.tdsName,
          bozpName: data.bozpName,
          designerName: data.designerName,
          gpsLat: data.gpsLat,
          gpsLon: data.gpsLon,
          startedAt: data.startedAt,
          endedAt: data.endedAt,
          createdById,
          members: {
            create: {
              userId: data.siteManagerId,
              role: "BOSS",
              addedById: createdById,
            },
          },
        },
      }),
  );
}

/** BOSS-only — update a project's identifying details. */
export async function updateProject(
  id: string,
  input: UpdateProjectInput,
  ctx: AuditContext,
): Promise<Project> {
  const data = createProjectSchema.parse(input);
  const before = await prisma.project.findUnique({ where: { id } });
  if (!before || before.deletedAt) throw new ProjectNotFoundError();
  await assertValidSiteManager(data.siteManagerId);

  return withAudit<Project>(
    {
      ctx,
      action: "project.update",
      entityType: "project",
      resolveEntityId: (p) => p.id,
      before: projectForAudit(before),
      projectAfter: projectForAudit,
    },
    (tx) =>
      tx.project.update({
        where: { id },
        data: {
          name: data.name,
          address: data.address,
          cadastralArea: data.cadastralArea,
          parcelNumbers: data.parcelNumbers,
          permitNumber: data.permitNumber,
          builder: data.builder,
          contractor: data.contractor,
          siteManagerId: data.siteManagerId,
          tdsName: data.tdsName,
          bozpName: data.bozpName,
          designerName: data.designerName,
          gpsLat: data.gpsLat,
          gpsLon: data.gpsLon,
          startedAt: data.startedAt,
          endedAt: data.endedAt,
        },
      }),
  );
}

/**
 * BOSS-only — archive a project (soft delete). Historical reports stay
 * intact; the project simply disappears from active lists and is only
 * visible in the BOSS archive view.
 */
export async function archiveProject(
  id: string,
  ctx: AuditContext,
): Promise<void> {
  const before = await prisma.project.findUnique({ where: { id } });
  if (!before) throw new ProjectNotFoundError();
  if (before.deletedAt) return; // already archived — keep the log clean

  await withAudit<Project>(
    {
      ctx,
      action: "project.delete",
      entityType: "project",
      resolveEntityId: (p) => p.id,
      before: projectForAudit(before),
      projectAfter: projectForAudit,
    },
    (tx) =>
      tx.project.update({
        where: { id },
        data: { deletedAt: new Date() },
      }),
  );
}

/** BOSS-only — restore a previously archived project. */
export async function restoreProject(
  id: string,
  ctx: AuditContext,
): Promise<void> {
  const before = await prisma.project.findUnique({ where: { id } });
  if (!before) throw new ProjectNotFoundError();
  if (!before.deletedAt) return; // not archived — nothing to do

  await withAudit<Project>(
    {
      ctx,
      action: "project.update",
      entityType: "project",
      resolveEntityId: (p) => p.id,
      before: projectForAudit(before),
      projectAfter: projectForAudit,
    },
    (tx) =>
      tx.project.update({
        where: { id },
        data: { deletedAt: null },
      }),
  );
}

/**
 * BOSS-only — assign a user to a project with a project-scoped role.
 * Idempotent: re-adding an existing member only updates their role.
 */
export async function addProjectMember(
  projectId: string,
  userId: string,
  role: Role,
  ctx: AuditContext,
  addedById: string,
): Promise<void> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project || project.deletedAt) throw new ProjectNotFoundError();

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.deletedAt || !user.isActive) {
    throw new MemberInvalidError();
  }

  const existing = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });

  await withAudit(
    {
      ctx,
      action: "project.member.add",
      entityType: "project_member",
      resolveEntityId: () => `${projectId}:${userId}`,
      before: existing ? { projectId, userId, role: existing.role } : null,
      projectAfter: () => ({ projectId, userId, role }),
    },
    (tx) =>
      tx.projectMember.upsert({
        where: { projectId_userId: { projectId, userId } },
        create: { projectId, userId, role, addedById },
        update: { role },
      }),
  );
}

/** BOSS-only — remove a user's assignment from a project. */
export async function removeProjectMember(
  projectId: string,
  userId: string,
  ctx: AuditContext,
): Promise<void> {
  const existing = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
  if (!existing) return; // nothing to remove — keep the log clean

  await withAudit(
    {
      ctx,
      action: "project.member.remove",
      entityType: "project_member",
      resolveEntityId: () => `${projectId}:${userId}`,
      before: { projectId, userId, role: existing.role },
      projectAfter: () => null,
    },
    (tx) =>
      tx.projectMember.delete({
        where: { projectId_userId: { projectId, userId } },
      }),
  );
}

// ---------------------------------------------------------------------------
// Queries (scope-aware)
// ---------------------------------------------------------------------------

export interface ProjectListItem {
  id: string;
  name: string;
  address: string;
  siteManagerName: string;
  memberCount: number;
  startedAt: Date | null;
  deletedAt: Date | null;
}

const listSelect = {
  id: true,
  name: true,
  address: true,
  startedAt: true,
  deletedAt: true,
  siteManager: { select: { displayName: true } },
  _count: { select: { members: true } },
} satisfies Prisma.ProjectSelect;

function toListItem(p: {
  id: string;
  name: string;
  address: string;
  startedAt: Date | null;
  deletedAt: Date | null;
  siteManager: { displayName: string };
  _count: { members: number };
}): ProjectListItem {
  return {
    id: p.id,
    name: p.name,
    address: p.address,
    siteManagerName: p.siteManager.displayName,
    memberCount: p._count.members,
    startedAt: p.startedAt,
    deletedAt: p.deletedAt,
  };
}

/**
 * List active (non-archived) projects visible to the user.
 *  - BOSS sees every project.
 *  - WORKER / GUEST see only projects they are a member of.
 */
export async function listProjectsForUser(
  user: SessionUser,
): Promise<ProjectListItem[]> {
  const where: Prisma.ProjectWhereInput =
    user.role === "BOSS"
      ? { deletedAt: null }
      : { deletedAt: null, members: { some: { userId: user.id } } };

  const rows = await prisma.project.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: listSelect,
  });
  return rows.map(toListItem);
}

/** BOSS-only — archived (soft-deleted) projects for the archive view. */
export async function listArchivedProjects(): Promise<ProjectListItem[]> {
  const rows = await prisma.project.findMany({
    where: { deletedAt: { not: null } },
    orderBy: { deletedAt: "desc" },
    select: listSelect,
  });
  return rows.map(toListItem);
}

export interface ProjectMemberView {
  userId: string;
  nickname: string;
  displayName: string;
  globalRole: Role;
  projectRole: Role;
  addedAt: Date;
}

export interface ProjectDetail {
  project: Project & { siteManagerName: string };
  members: ProjectMemberView[];
  isMember: boolean;
  canManage: boolean;
}

/**
 * Load a single project enforcing the visibility scope. Returns `null`
 * when the project does not exist or the user is not allowed to see it
 * (so the caller can render a 404 without leaking existence).
 */
export async function getProjectForUser(
  projectId: string,
  user: SessionUser,
): Promise<ProjectDetail | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      siteManager: { select: { displayName: true } },
      members: {
        include: {
          user: {
            select: { nickname: true, displayName: true, role: true },
          },
        },
        orderBy: { addedAt: "asc" },
      },
    },
  });
  if (!project) return null;

  const isMember = project.members.some((m) => m.userId === user.id);
  if (!canAccessProject(user.role, isMember)) return null;

  const { siteManager, members, ...rest } = project;
  return {
    project: { ...rest, siteManagerName: siteManager.displayName },
    members: members.map((m) => ({
      userId: m.userId,
      nickname: m.user.nickname,
      displayName: m.user.displayName,
      globalRole: m.user.role,
      projectRole: m.role,
      addedAt: m.addedAt,
    })),
    isMember,
    canManage: user.role === "BOSS",
  };
}

/**
 * Active BOSS users with ČKAIT autorizací — candidates for the
 * site-manager picker (Project.siteManagerId).
 *
 * Filtrujeme tvrdě: `role = BOSS AND ckaitNumber IS NOT NULL`. Per
 * Vyhláška 499/2006 § 153 stavbyvedoucí MUSÍ mít ČKAIT autorizační
 * číslo — BOSS bez ČKAIT (např. první seedovaný admin účet) sem
 * NEPATŘÍ. Admin uživatelé (isAdmin=true) bez role BOSS taky ne —
 * jsou to správci aplikace, ne stavbyvedoucí.
 */
export async function listSiteManagerCandidates() {
  return prisma.user.findMany({
    where: {
      deletedAt: null,
      isActive: true,
      role: "BOSS",
      ckaitNumber: { not: null },
    },
    orderBy: { displayName: "asc" },
    select: { id: true, displayName: true, nickname: true },
  });
}

/**
 * Active users who are not yet members of the given project — candidates
 * for the "add member" control on the project detail page.
 */
export async function listAddableUsers(projectId: string) {
  return prisma.user.findMany({
    where: {
      deletedAt: null,
      isActive: true,
      projectMemberships: { none: { projectId } },
    },
    orderBy: { displayName: "asc" },
    select: { id: true, displayName: true, nickname: true, role: true },
  });
}

// ---------------------------------------------------------------------------
// Materiálový timeline (Gantt) — celá zakázka, ne jen jeden report
// ---------------------------------------------------------------------------

export interface MaterialGanttItem {
  id: string;
  text: string;
  neededBy: Date | null;
  resolved: boolean;
  resolvedAt: Date | null;
  /** Datum reportu, kde byla položka založena — odkaz na zdroj. */
  reportDate: Date;
  reportId: string;
}

/**
 * Vrátí všechny MaterialNeed položky zakázky napříč všemi reporty,
 * setříděné podle neededBy (nulls last) a pak podle reportDate.
 * Použité v "Materiál" tabu na project detail page.
 *
 * RBAC: caller MUSÍ ověřit přístup k zakázce přes `getProjectForUser`
 * + že role NENÍ GUEST (Dozor/TDS by checklist materiálu neměli vidět
 * — je to vnitřní info brigády/firmy).
 *
 * Filtruje soft-delete: report.deletedAt = null AND material.deletedAt
 * = null.
 */
export async function listMaterialsForProject(
  projectId: string,
): Promise<MaterialGanttItem[]> {
  const rows = await prisma.materialNeed.findMany({
    where: {
      deletedAt: null,
      report: { projectId, deletedAt: null },
    },
    orderBy: [{ neededBy: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      text: true,
      neededBy: true,
      resolved: true,
      resolvedAt: true,
      reportId: true,
      report: { select: { date: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    neededBy: r.neededBy,
    resolved: r.resolved,
    resolvedAt: r.resolvedAt,
    reportDate: r.report.date,
    reportId: r.reportId,
  }));
}
