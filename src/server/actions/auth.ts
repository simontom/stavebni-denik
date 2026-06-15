"use server";

import { signOut } from "@/server/auth";

/**
 * Sign-out server action. Auth.js's `signOut` performs its own redirect
 * internally, so we don't need to call `redirect()` here.
 */
export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}
