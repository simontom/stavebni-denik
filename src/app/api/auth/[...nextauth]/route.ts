/**
 * Auth.js v5 catch-all handlers.
 *
 * Force Node runtime — Credentials provider calls argon2 (native binding,
 * not available in the Edge runtime).
 */
import { handlers } from "@/server/auth";

export const runtime = "nodejs";

export const { GET, POST } = handlers;
