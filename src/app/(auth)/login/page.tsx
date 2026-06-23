import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { HardHat, ShieldCheck } from "lucide-react";

import { env } from "@/lib/env";
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
    <main className="grid min-h-svh place-items-center bg-gradient-to-br from-background via-background to-accent/30 px-4 py-8">
      <div className="grid w-full max-w-5xl items-center gap-10 lg:grid-cols-[1fr_auto] lg:gap-16">
        {/* Hero — schované na malých displejích, ať se vejde formulář bez scrollu */}
        <section className="hidden flex-col gap-5 lg:flex">
          <div className="flex items-center gap-3">
            <div className="grid size-12 place-items-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
              <HardHat className="size-6" aria-hidden />
            </div>
            <div>
              <h1 className="text-2xl font-semibold leading-tight">
                {env.appName}
              </h1>
              <p className="text-sm text-muted-foreground">
                Elektronický stavební deník
              </p>
            </div>
          </div>

          <p className="max-w-md text-pretty text-base text-muted-foreground">
            Vedení deníku dle <strong>§ 157 stavebního zákona</strong> a{" "}
            <strong>vyhlášky 499/2006&nbsp;Sb.</strong> Denní záznamy z mobilu,
            fotky s GPS a počasím, podpis stavbyvedoucího, archivace 10 let.
          </p>

          <ul className="grid gap-3 text-sm">
            <li className="flex items-start gap-3">
              <ShieldCheck
                className="mt-0.5 size-5 shrink-0 text-primary"
                aria-hidden
              />
              <span>
                <strong>Append-only audit log</strong> s hash-chainem —
                změny v deníku jsou kryptograficky doložitelné.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <ShieldCheck
                className="mt-0.5 size-5 shrink-0 text-primary"
                aria-hidden
              />
              <span>
                <strong>Offline-friendly</strong> — fotky se zpracují
                v telefonu, server zatíží jen finální upload.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <ShieldCheck
                className="mt-0.5 size-5 shrink-0 text-primary"
                aria-hidden
              />
              <span>
                <strong>PDF export & tisk</strong> pro kontrolu úřadu
                nebo investora.
              </span>
            </li>
          </ul>
        </section>

        {/* Brand bar pro mobily (lg:hidden) — drží spirit hero stránky aniž by zabralo místo */}
        <div className="flex items-center gap-3 lg:hidden">
          <div className="grid size-10 place-items-center rounded-lg bg-primary text-primary-foreground shadow shadow-primary/20">
            <HardHat className="size-5" aria-hidden />
          </div>
          <div>
            <p className="text-base font-semibold leading-tight">
              {env.appName}
            </p>
            <p className="text-xs text-muted-foreground">
              Elektronický stavební deník
            </p>
          </div>
        </div>

        <LoginForm callbackUrl={callbackUrl} />
      </div>
    </main>
  );
}
