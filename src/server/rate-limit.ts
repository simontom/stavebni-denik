import "server-only";

import { prisma } from "@/lib/db";

/**
 * Tiny Postgres-backed sliding-window rate limiter.
 *
 * Used to throttle the login endpoint per nickname and per IP. We
 * intentionally avoid Redis / external services to keep the Stage-1
 * deploy single-binary.
 *
 * Algorithm:
 *  - Each call inserts an attempt row keyed by `bucket` + `key`.
 *  - We count the number of rows newer than `now - windowMs`.
 *  - When the count exceeds `max`, return `{ allowed: false }`.
 *  - A cheap cleanup deletes rows older than the largest window once
 *    per insert (best-effort, no separate cron needed).
 *
 * The table is created in the same migration as `audit_log` (Stage 3)
 * — for Stage 2 we ship it standalone first.
 */

export interface RateLimitConfig {
  bucket: string;
  key: string;
  windowMs: number;
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export async function checkRateLimit(
  cfg: RateLimitConfig,
): Promise<RateLimitResult> {
  const now = new Date();
  const since = new Date(now.getTime() - cfg.windowMs);

  return await prisma.$transaction(async (tx) => {
    // Best-effort cleanup — drop attempts older than 24 h for any bucket.
    const cleanupCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    await tx.$executeRaw`DELETE FROM rate_limit_attempts WHERE created_at < ${cleanupCutoff}`;

    await tx.$executeRaw`
      INSERT INTO rate_limit_attempts (bucket, "key", created_at)
      VALUES (${cfg.bucket}, ${cfg.key}, ${now})
    `;

    const rows = await tx.$queryRaw<Array<{ created_at: Date }>>`
      SELECT created_at FROM rate_limit_attempts
      WHERE bucket = ${cfg.bucket} AND "key" = ${cfg.key}
        AND created_at >= ${since}
      ORDER BY created_at ASC
    `;

    const count = rows.length;
    if (count <= cfg.max) {
      return {
        allowed: true,
        remaining: cfg.max - count,
        retryAfterMs: 0,
      };
    }

    // Oldest attempt in the window dictates when the limit resets.
    const oldest = rows[0]?.created_at ?? now;
    const retryAfterMs = Math.max(
      0,
      oldest.getTime() + cfg.windowMs - now.getTime(),
    );
    return { allowed: false, remaining: 0, retryAfterMs };
  });
}

/**
 * Resets a key — call after a successful login to wipe the failure
 * counter so a legitimate user is not locked out by an attacker's prior
 * attempts.
 */
export async function resetRateLimit(bucket: string, key: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM rate_limit_attempts WHERE bucket = ${bucket} AND "key" = ${key}`;
}

/**
 * Convenience presets matching the plan's acceptance criteria:
 *   - 5 login attempts per 15 min per nickname
 *   - 20 login attempts per 15 min per IP
 */
export const LOGIN_NICKNAME_LIMIT = {
  bucket: "login:nickname",
  windowMs: 15 * 60 * 1000,
  max: 5,
} as const;

export const LOGIN_IP_LIMIT = {
  bucket: "login:ip",
  windowMs: 15 * 60 * 1000,
  max: 20,
} as const;
