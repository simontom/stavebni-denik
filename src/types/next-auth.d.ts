/**
 * Module augmentation for Auth.js v5.
 *
 * We extend `User`, `Session`, and `JWT` with our domain claims so that
 * `await auth()` in server components returns typed `session.user.role`
 * etc. without any casts.
 */

import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    id: string;
    nickname: string;
    displayName: string;
    role: "BOSS" | "WORKER" | "GUEST";
    isAdmin: boolean;
    mustChangePwd: boolean;
    /** Server-side session row id (Postgres `Session.id`). */
    sessionId: string;
  }

  interface Session {
    user: {
      id: string;
      nickname: string;
      displayName: string;
      role: "BOSS" | "WORKER" | "GUEST";
      isAdmin: boolean;
      mustChangePwd: boolean;
      sessionId: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    nickname?: string;
    displayName?: string;
    role?: "BOSS" | "WORKER" | "GUEST";
    isAdmin?: boolean;
    mustChangePwd?: boolean;
    sessionId?: string;
  }
}

export {};
