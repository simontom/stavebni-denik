import NextAuth from "next-auth";

import { authConfig } from "@/server/auth.config";

/**
 * Edge proxy (Next.js 16+; renamed from "middleware" in v16) — runs on
 * every request, gates access to protected routes via the `authorized`
 * callback in `auth.config.ts`. Pure JWT verification, no Node-only
 * imports.
 */
const { auth } = NextAuth(authConfig);

export default auth;

export const config = {
  // Don't run on the auth API itself, static assets, or anything that
  // serves binary/file payloads. The `authorized` callback further
  // refines which routes are public vs. protected.
  matcher: [
    "/((?!api/auth|_next/static|_next/image|favicon\\.ico|robots\\.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff|woff2|map)$).*)",
  ],
};
