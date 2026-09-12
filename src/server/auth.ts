import "server-only";

import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/crypto";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

import { appendAudit } from "./audit";
import { authConfig } from "./auth.config";
import { LOGIN_IP_LIMIT, LOGIN_NICKNAME_LIMIT, checkRateLimit, resetRateLimit } from "./rate-limit";

/**
 * Distinct error classes — Auth.js v5 surfaces `error.type` in the
 * sign-in result so the login page can render a precise Czech message.
 */
export class InvalidCredentialsError extends CredentialsSignin {
  code = "InvalidCredentials";
}
export class AccountDisabledError extends CredentialsSignin {
  code = "AccountDisabled";
}
export class RateLimitedError extends CredentialsSignin {
  code = "RateLimited";
}

const credentialsSchema = z.object({
  nickname: z.string().min(1, "Vyplňte přihlašovací jméno.").max(64),
  password: z.string().min(1, "Vyplňte heslo.").max(256),
  // Best-effort client IP forwarded by the login form (extracted from
  // request headers in `signIn()` action).
  clientIp: z.string().optional(),
  userAgent: z.string().optional(),
});

/**
 * How often the `jwt` callback verifies the session hasn't been
 * revoked (ms). 30 minutes = max staleness after an admin resets
 * a password or deactivates a user. Cost: one `findUnique` by PK
 * per user per 30 min — negligible.
 */
const SESSION_CHECK_INTERVAL_MS = 30 * 60 * 1000;

export const {
  handlers,
  auth,
  signIn,
  signOut,
  unstable_update: update,
} = NextAuth({
  ...authConfig,
  secret: env.authSecret,
  callbacks: {
    // Inherit the route-level gate from authConfig.
    authorized: authConfig.callbacks!.authorized!,

    /**
     * Extends the base jwt callback with a periodic session-
     * revocation check. The base callback (authConfig) copies
     * user metadata into the token on sign-in; this wrapper adds
     * a DB lookup every SESSION_CHECK_INTERVAL_MS to verify the
     * session row hasn't been revoked.
     */
    async jwt({ token, user, trigger, session: updatedSession }) {
      // Delegate to the base callback for metadata propagation.
      const baseResult = authConfig.callbacks!.jwt!({
        token,
        user,
        trigger,
        session: updatedSession,
        // Auth.js internal — not relevant for our logic but
        // required by the type signature.
        account: null,
      } as Parameters<NonNullable<typeof authConfig.callbacks.jwt>>[0]);
      const resolved = baseResult instanceof Promise ? await baseResult : baseResult;
      if (!resolved || typeof resolved !== "object") return resolved;

      // Periodic revocation check — skip on initial sign-in (user
      // is set) since we just created the session row.
      if (!user && resolved.sessionId) {
        const lastCheck = (resolved.lastRevocationCheck as number | undefined) ?? 0;
        if (Date.now() - lastCheck > SESSION_CHECK_INTERVAL_MS) {
          const sess = await prisma.session.findUnique({
            where: { id: resolved.sessionId as string },
            select: { revokedAt: true },
          });
          if (!sess || sess.revokedAt) {
            // Session was revoked — force sign-out by returning an
            // empty token. Auth.js will clear the cookie.
            logger.info("jwt.session_revoked", {
              sessionId: resolved.sessionId,
            });
            return {} as typeof resolved;
          }
          resolved.lastRevocationCheck = Date.now();
        }
      }

      return resolved;
    },

    // Session callback is unchanged from authConfig.
    session: authConfig.callbacks!.session!,
  },
  providers: [
    Credentials({
      name: "Stavební deník",
      credentials: {
        nickname: { label: "Přihlašovací jméno", type: "text" },
        password: { label: "Heslo", type: "password" },
        clientIp: { label: "client ip", type: "hidden" },
        userAgent: { label: "user agent", type: "hidden" },
      },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) throw new InvalidCredentialsError();
        const { nickname, password, clientIp, userAgent } = parsed.data;

        // Rate limit BEFORE touching the DB to fight credential stuffing.
        const ipKey = clientIp ?? "unknown";
        const ipLimit = await checkRateLimit({ ...LOGIN_IP_LIMIT, key: ipKey });
        if (!ipLimit.allowed) {
          logger.warn("login.rate_limited", { ip: ipKey, nickname, limit: "ip" });
          throw new RateLimitedError();
        }

        const nickLimit = await checkRateLimit({
          ...LOGIN_NICKNAME_LIMIT,
          key: nickname.toLowerCase(),
        });
        if (!nickLimit.allowed) {
          logger.warn("login.rate_limited", { ip: ipKey, nickname, limit: "nickname" });
          throw new RateLimitedError();
        }

        const user = await prisma.user.findUnique({
          where: { nickname },
        });
        if (!user || user.deletedAt || !user.isActive) {
          logger.warn("login.invalid_credentials", {
            ip: ipKey,
            nickname,
            reason: "user_not_found_or_disabled",
          });
          if (!user || user.deletedAt) throw new InvalidCredentialsError();
          throw new AccountDisabledError();
        }

        const ok = await verifyPassword(password, user.passwordHash);
        if (!ok) {
          logger.warn("login.invalid_credentials", {
            ip: ipKey,
            nickname,
            reason: "wrong_password",
          });
          throw new InvalidCredentialsError();
        }

        // Successful login — clear failure counters and persist a
        // session row for revocation + audit visibility.
        await resetRateLimit(LOGIN_NICKNAME_LIMIT.bucket, nickname.toLowerCase());
        await resetRateLimit(LOGIN_IP_LIMIT.bucket, ipKey);

        const session = await prisma.session.create({
          data: {
            userId: user.id,
            expiresAt: new Date(Date.now() + (authConfig.session?.maxAge ?? 43200) * 1000),
            ip: clientIp ?? null,
            userAgent: userAgent ?? null,
          },
        });

        // Audit successful login — store just non-PII metadata + session id,
        // not the credentials. Failures are intentionally not audited to
        // avoid blowing up the chain on credential-stuffing waves;
        // rate-limit attempts table records them instead.
        await appendAudit(
          {
            actor: { id: user.id },
            ip: clientIp ?? null,
            userAgent: userAgent ?? null,
          },
          {
            action: "session.signin",
            entityType: "session",
            entityId: session.id,
            after: {
              userId: user.id,
              nickname: user.nickname,
              role: user.role,
              sessionId: session.id,
            },
          },
        );

        logger.info("login.success", {
          userId: user.id,
          nickname: user.nickname,
          role: user.role,
          sessionId: session.id,
          ip: ipKey,
        });

        return {
          id: user.id,
          nickname: user.nickname,
          displayName: user.displayName,
          role: user.role,
          isAdmin: user.isAdmin,
          mustChangePwd: user.mustChangePwd,
          sessionId: session.id,
        };
      },
    }),
  ],
  events: {
    async signOut(message) {
      // `message` is either `{ session }` (DB) or `{ token }` (JWT).
      const token = "token" in message ? message.token : null;
      const sessionId = token?.sessionId as string | undefined;
      const userId = token?.userId as string | undefined;
      if (!sessionId) return;
      await prisma.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await appendAudit(
        {
          actor: userId ? { id: userId } : null,
          ip: null,
          userAgent: null,
        },
        {
          action: "session.signout",
          entityType: "session",
          entityId: sessionId,
          after: { sessionId, userId: userId ?? null },
        },
      );
      logger.info("logout", { userId: userId ?? "unknown", sessionId });
    },
  },
});
