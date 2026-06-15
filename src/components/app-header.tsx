import Link from "next/link";

import { SignOutButton } from "@/components/sign-out-button";
import { Badge } from "@/components/ui/badge";
import { env } from "@/lib/env";
import type { SessionUser } from "@/server/rbac";

const ROLE_LABEL: Record<SessionUser["role"], string> = {
  BOSS: "Stavbyvedoucí",
  WORKER: "Pracovník",
  GUEST: "Dozor / TDS",
};

interface Props {
  user: SessionUser;
}

export function AppHeader({ user }: Props) {
  const isBoss = user.role === "BOSS";
  return (
    <header className="border-b bg-card/50 backdrop-blur sticky top-0 z-30">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="text-base font-semibold hover:text-primary"
        >
          {env.appName}
        </Link>

        <nav className="ml-2 hidden gap-1 text-sm sm:flex" aria-label="Hlavní">
          <Link
            href="/projects"
            className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Zakázky
          </Link>
          {isBoss && (
            <>
              <Link
                href="/admin/users"
                className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                Uživatelé
              </Link>
              <Link
                href="/admin/audit"
                className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                Audit log
              </Link>
            </>
          )}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <div className="hidden text-sm sm:flex sm:flex-col sm:items-end sm:leading-tight">
            <span className="font-medium">{user.displayName}</span>
            <Badge variant="secondary" className="text-[10px] uppercase">
              {ROLE_LABEL[user.role]}
            </Badge>
          </div>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
