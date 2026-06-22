import "server-only";

import { redirect } from "next/navigation";

import { auth } from "@/server/auth";
import {
  ForbiddenError,
  type Role,
  type SessionUser,
} from "@/server/permissions";

/**
 * Re-export the pure RBAC matrix (capability checks, types, errors) so
 * the rest of the app keeps importing from `@/server/rbac`. The matrix
 * itself lives in `permissions.ts` (no `server-only`) so it can be
 * unit-tested in isolation.
 */
export * from "@/server/permissions";

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

/** Stavbyvedoucí (role=BOSS) — operace na zakázkách, podpis deníku. */
export async function requireBoss(): Promise<SessionUser> {
  return requireRole("BOSS");
}

/**
 * App administrátor — správa uživatelů, čtení audit logu. Nezávisí
 * na `role` (admin nemusí být stavbyvedoucí). Per Vyhláška 499/2006
 * §153 musí mít stavbyvedoucí ČKAIT autorizaci — admin ne.
 */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (!user.isAdmin) {
    throw new ForbiddenError("requires isAdmin");
  }
  return user;
}
