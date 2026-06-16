/**
 * Pure, dependency-free RBAC capability matrix.
 *
 * This module imports nothing from Next.js, the database, or
 * `server-only`, so the permission rules can be unit-tested in isolation.
 * The session gates that actually resolve the current user
 * (`requireUser`, `requireRole`, `requireBoss`) live in `rbac.ts`, which
 * re-exports everything from here.
 */

export type Role = "BOSS" | "WORKER" | "GUEST";

export interface SessionUser {
  id: string;
  nickname: string;
  displayName: string;
  role: Role;
  mustChangePwd: boolean;
  sessionId: string;
}

export class UnauthenticatedError extends Error {
  code = "Unauthenticated" as const;
}

export class ForbiddenError extends Error {
  code = "Forbidden" as const;
  constructor(public action: string) {
    super(`Forbidden: ${action}`);
  }
}

/**
 * Discrete actions that the RBAC matrix can grant. Keep this list
 * exhaustive — `assertCan` is wildcard-resistant: anything not listed
 * here is implicitly denied.
 */
export type Action =
  // User admin
  | "user.create"
  | "user.deactivate"
  | "user.activate"
  | "audit.read"
  | "audit.verify"
  // Projects
  | "project.create"
  | "project.update"
  | "project.delete"
  | "project.member.manage"
  | "project.list-all"
  // Daily reports
  | "report.create"
  | "report.update"
  | "report.sign"
  | "report.addendum.create"
  // Photos, remarks, materials
  | "photo.upload"
  | "photo.delete"
  | "remark.create"
  | "material.create"
  | "material.resolve";

export interface Resource {
  /** True when the acting user is a member of the project. */
  projectMember?: boolean;
  /** True when the report has been signed/locked. */
  reportLocked?: boolean;
  /** Author id of the resource — used to enforce "edit own only". */
  authorId?: string;
}

/**
 * Matrix definition. Each entry returns `true` when the action is
 * allowed. Roles default to denied — explicit allow only.
 *
 * The matrix is centralised so it can be audited without grepping
 * across the codebase. New permissions go HERE first; the rest of
 * the app then calls `assertCan`.
 */
const MATRIX: Record<Action, (user: SessionUser, resource?: Resource) => boolean> = {
  // Admin
  "user.create":      (u) => u.role === "BOSS",
  "user.deactivate":  (u) => u.role === "BOSS",
  "user.activate":    (u) => u.role === "BOSS",
  "audit.read":       (u) => u.role === "BOSS",
  "audit.verify":     (u) => u.role === "BOSS",

  // Projects
  "project.create":         (u) => u.role === "BOSS",
  "project.update":         (u) => u.role === "BOSS",
  "project.delete":         (u) => u.role === "BOSS",
  "project.member.manage":  (u) => u.role === "BOSS",
  "project.list-all":       (u) => u.role === "BOSS",

  // Reports
  "report.create": (u, r) =>
    u.role === "BOSS" || (u.role === "WORKER" && r?.projectMember === true),
  "report.update": (u, r) =>
    !r?.reportLocked &&
    (u.role === "BOSS" ||
      (u.role === "WORKER" &&
        r?.projectMember === true &&
        r?.authorId === u.id)),
  "report.sign": (u) => u.role === "BOSS",
  "report.addendum.create": (u, r) =>
    (u.role === "BOSS" || u.role === "WORKER") && r?.projectMember === true,

  // Photos / remarks / materials
  "photo.upload": (u, r) =>
    (u.role === "BOSS" || u.role === "WORKER") &&
    r?.projectMember === true &&
    !r?.reportLocked,
  "photo.delete": (u, r) =>
    u.role === "BOSS" && r?.projectMember === true && !r?.reportLocked,
  "remark.create": (u, r) =>
    (u.role === "BOSS" || u.role === "WORKER" || u.role === "GUEST") &&
    r?.projectMember === true,
  "material.create": (u, r) =>
    (u.role === "BOSS" || u.role === "WORKER") &&
    r?.projectMember === true &&
    !r?.reportLocked,
  "material.resolve": (u, r) =>
    (u.role === "BOSS" || u.role === "WORKER") && r?.projectMember === true,
};

/**
 * Returns true when the user is allowed to perform the action on the
 * given (optional) resource. Use `assertCan` for the throw-on-deny
 * variant from server actions / routes.
 */
export function can(
  user: SessionUser,
  action: Action,
  resource?: Resource,
): boolean {
  const rule = MATRIX[action];
  if (!rule) return false;
  return rule(user, resource);
}

export function assertCan(
  user: SessionUser,
  action: Action,
  resource?: Resource,
): void {
  if (!can(user, action, resource)) {
    throw new ForbiddenError(action);
  }
}

/**
 * Project visibility scope. BOSS sees every project (full oversight of
 * the whole firm); WORKER and GUEST only see projects they are a member
 * of. Kept pure (no DB) so it can be unit-tested and reused both for
 * list filtering and single-project access checks.
 */
export function canAccessProject(role: Role, isMember: boolean): boolean {
  return role === "BOSS" || isMember;
}
