import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe slice of the Auth.js config — usable from `middleware.ts`,
 * which runs in the Edge runtime and therefore cannot import Node-only
 * modules like `@node-rs/argon2`. The full config (with Credentials
 * provider) lives in `./auth.ts` and extends this base.
 *
 * Pattern adapted from the official Auth.js v5 + Credentials guide.
 */
export const authConfig = {
  pages: {
    signIn: "/login",
    error: "/login",
  },
  session: {
    // Credentials provider requires JWT strategy. We still track every
    // issued session in the `Session` Postgres table for revocation +
    // audit visibility (see `src/server/auth.ts`).
    strategy: "jwt",
    maxAge: 60 * 60 * 12, // 12 h sliding window — typical workday + slack.
    updateAge: 60 * 60, // refresh JWT once per hour at most.
  },
  callbacks: {
    /**
     * Route-level gate. Returning `false` from `authorized` redirects
     * to `pages.signIn`. Server-side `auth()` calls in pages/actions
     * remain the authoritative check.
     */
    authorized({ auth, request }) {
      const isLoggedIn = !!auth?.user;
      const { pathname } = request.nextUrl;

      // Always-public paths.
      if (
        pathname === "/login" ||
        pathname === "/healthz" ||
        pathname.startsWith("/_next") ||
        pathname.startsWith("/favicon")
      ) {
        return true;
      }

      // Force first-time password change before anything else.
      if (isLoggedIn && auth?.user?.mustChangePwd) {
        if (pathname.startsWith("/first-password-change")) return true;
        return Response.redirect(
          new URL("/first-password-change", request.nextUrl),
        );
      }

      if (!isLoggedIn) {
        const callback = encodeURIComponent(pathname + request.nextUrl.search);
        return Response.redirect(
          new URL(`/login?callbackUrl=${callback}`, request.nextUrl),
        );
      }
      return true;
    },

    /**
     * Pass user metadata (role, mustChangePwd, sessionId) from the
     * signIn() result through the JWT into `session.user`.
     */
    jwt({ token, user, trigger, session: updatedSession }) {
      if (user) {
        token.userId = user.id;
        token.role = user.role;
        token.mustChangePwd = user.mustChangePwd;
        token.sessionId = user.sessionId;
        token.nickname = user.nickname;
        token.displayName = user.displayName;
      }
      // Allow `update()` calls (e.g. after password change) to refresh
      // the `mustChangePwd` flag without forcing a fresh login.
      if (trigger === "update" && updatedSession?.user) {
        if (typeof updatedSession.user.mustChangePwd === "boolean") {
          token.mustChangePwd = updatedSession.user.mustChangePwd;
        }
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.userId as string;
      session.user.role = token.role as "BOSS" | "WORKER" | "GUEST";
      session.user.mustChangePwd = Boolean(token.mustChangePwd);
      session.user.sessionId = token.sessionId as string;
      session.user.nickname = token.nickname as string;
      session.user.displayName = token.displayName as string;
      return session;
    },
  },
  providers: [], // populated in src/server/auth.ts
  trustHost: true,
} satisfies NextAuthConfig;
