import "server-only";

import { headers } from "next/headers";

import { auth } from "@/server/auth";

import type { AuditContext } from "./audit";

/**
 * Captures the audit context at the request boundary. Call this once
 * from the entry point of any server action / route handler that
 * eventually performs a `withAudit(...)` mutation, and forward the
 * resulting object down the stack.
 *
 * We extract:
 *   - `actor.id` from the current session (null for unauthenticated
 *     mutations like initial admin seed via CLI).
 *   - `ip` from `x-forwarded-for` (only the leftmost entry, which is
 *     the originating client per the standard) or `x-real-ip`.
 *   - `userAgent` from the `user-agent` header.
 */
export async function getAuditContext(): Promise<AuditContext> {
  const [session, h] = await Promise.all([auth(), headers()]);
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    h.get("x-real-ip") ??
    null;
  return {
    actor: session?.user ? { id: session.user.id } : null,
    ip,
    userAgent: h.get("user-agent") ?? null,
  };
}

/**
 * System actor — used by CLI scripts, cron jobs and the seeder where
 * we still want to attach IP/UA-less audit rows. Falsy `actor` here
 * means: "no human in the loop".
 */
export const SYSTEM_AUDIT_CONTEXT: AuditContext = {
  actor: null,
  ip: null,
  userAgent: "system",
};
