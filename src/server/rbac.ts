import "server-only";

import { redirect } from "next/navigation";

import { auth } from "@/server/auth";

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

// ---------------------------------------------------------------------------
// Session gates
// ---------------------------------------------------------------------------

export async function requireUser(): Promise<SessionUser> {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }
  return session.user as SessionUser;
}

export async function requireRole(...allowed: Role[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!allowed.includes(user.role)) {
    throw new ForbiddenError(`requires role one of [${allowed.join(", ")}]`);
  }
  return user;
}

export async function requireBoss(): Promise<SessionUser> {
  return requireRole("BOSS");
}

// ---------------------------------------------------------------------------
// Capability matrix
// ---------------------------------------------------------------------------

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

interface Resource {
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
