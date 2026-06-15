import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { auth } from "@/server/auth";

import { ChangePasswordForm } from "./ChangePasswordForm";

export const metadata: Metadata = { title: "Změna hesla" };
export const dynamic = "force-dynamic";

export default async function FirstPasswordChangePage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  // If somehow the user already changed their password, send them home.
  if (!session.user.mustChangePwd) redirect("/");

  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-12">
      <ChangePasswordForm displayName={session.user.displayName} />
    </main>
  );
}
