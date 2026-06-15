import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { auth } from "@/server/auth";

import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Přihlášení" };
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ callbackUrl?: string }>;
}

export default async function LoginPage({ searchParams }: PageProps) {
  const session = await auth();
  const { callbackUrl } = await searchParams;

  // Already logged in — bounce back to wherever they came from (or home).
  if (session?.user) {
    redirect(
      session.user.mustChangePwd
        ? "/first-password-change"
        : callbackUrl || "/",
    );
  }

  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-12">
      <LoginForm callbackUrl={callbackUrl} />
    </main>
  );
}
