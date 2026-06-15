"use server";

import { headers } from "next/headers";
import { AuthError } from "next-auth";
import { z } from "zod";

import { signIn } from "@/server/auth";

/**
 * Next.js signals redirects from server actions via a special error
 * whose `digest` starts with `NEXT_REDIRECT`. We must re-throw it so
 * the framework actually performs the navigation.
 */
function isRedirectError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const digest = (err as unknown as { digest?: unknown }).digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

const formSchema = z.object({
  nickname: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  callbackUrl: z.string().optional(),
});

export type LoginState = {
  error?: "InvalidCredentials" | "AccountDisabled" | "RateLimited" | "Unknown";
  message?: string;
};

/**
 * Login server action. Drives the form via `useActionState`.
 *
 * Forwards the client IP / User-Agent into `authorize()` so the
 * rate-limiter and the `Session` row both get accurate values.
 */
export async function loginAction(
  _prev: LoginState | undefined,
  data: FormData,
): Promise<LoginState> {
  const parsed = formSchema.safeParse({
    nickname: data.get("nickname"),
    password: data.get("password"),
    callbackUrl: data.get("callbackUrl"),
  });
  if (!parsed.success) {
    return { error: "InvalidCredentials" };
  }

  const h = await headers();
  // `x-forwarded-for` may carry multiple comma-separated entries — keep
  // only the originating client.
  const clientIp =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    h.get("x-real-ip") ??
    undefined;
  const userAgent = h.get("user-agent") ?? undefined;

  try {
    await signIn("credentials", {
      nickname: parsed.data.nickname.toLowerCase(),
      password: parsed.data.password,
      clientIp,
      userAgent,
      redirectTo: parsed.data.callbackUrl || "/",
    });
    // `signIn` calls `redirect()` on success.
    return {};
  } catch (err) {
    // Next.js's redirect from signIn is signalled by a special error
    // that we must re-throw to actually navigate.
    if (isRedirectError(err)) throw err;
    if (err instanceof AuthError) {
      const code = (err as AuthError & { code?: string }).code;
      if (code === "InvalidCredentials") {
        return { error: "InvalidCredentials" };
      }
      if (code === "AccountDisabled") {
        return { error: "AccountDisabled" };
      }
      if (code === "RateLimited") {
        return { error: "RateLimited" };
      }
    }
    return { error: "Unknown" };
  }
}

