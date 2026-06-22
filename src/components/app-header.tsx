import Link from "next/link";

import { NotificationBell } from "@/components/notification-bell";
import { SignOutButton } from "@/components/sign-out-button";
import { Badge } from "@/components/ui/badge";
import { env } from "@/lib/env";
import type { SessionUser } from "@/server/rbac";
import {
  countUnreadForUser,
  listNotificationsForUser,
} from "@/server/services/notifications";
import { presentNotification } from "@/server/services/notification-presentation";

const ROLE_LABEL: Record<SessionUser["role"], string> = {
  BOSS: "Stavbyvedoucí",
  WORKER: "Pracovník",
  GUEST: "Dozor / TDS",
};

interface Props {
  user: SessionUser;
}

export async function AppHeader({ user }: Props) {
  // Admin menu (Uživatelé + Audit log) viditelné pro app-admin
  // VČETNĚ těch, kteří nejsou stavbyvedoucí. Naopak stavbyvedoucí
  // bez isAdmin admin menu nevidí (typický venkovní stavbyvedoucí).
  const isAdmin = user.isAdmin;

  // Bell payload — newest 10 + unread count. Bounded so the layout
  // render stays cheap on every navigation.
  const [bellRows, unreadCount] = await Promise.all([
    listNotificationsForUser({ userId: user.id, limit: 10 }),
    countUnreadForUser(user.id),
  ]);
  const bellItems = bellRows.map((n) => {
    const presentation = presentNotification(n);
    return {
      id: n.id,
      kind: n.kind,
      title: presentation.title,
      body: presentation.body,
      href: n.href,
      readAt: n.readAt ? n.readAt.toISOString() : null,
      createdAt: n.createdAt.toISOString(),
    };
  });

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
          {isAdmin && (
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

        <div className="ml-auto flex items-center gap-2">
          <NotificationBell items={bellItems} unreadCount={unreadCount} />
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
