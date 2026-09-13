import "server-only";

import { createSafeActionClient } from "next-safe-action";

import { getAuditContext } from "@/server/audit-context";
import { requireAdmin, requireBoss, requireUser } from "@/server/rbac";

export const actionClient = createSafeActionClient({
  handleServerError: (e) => {
    console.error("Action error:", e);
    return "Při zpracování požadavku došlo k chybě.";
  },
});

export const authActionClient = actionClient.use(async ({ next }) => {
  const user = await requireUser();
  const auditContext = await getAuditContext();
  return next({ ctx: { user, auditContext } });
});

export const adminActionClient = actionClient.use(async ({ next }) => {
  const user = await requireAdmin();
  const auditContext = await getAuditContext();
  return next({ ctx: { user, auditContext } });
});

export const bossActionClient = actionClient.use(async ({ next }) => {
  const user = await requireBoss();
  const auditContext = await getAuditContext();
  return next({ ctx: { user, auditContext } });
});
