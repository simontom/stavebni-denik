import type { Metadata } from "next";
import { CheckCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireUser } from "@/server/rbac";
import { listNotificationsForUser } from "@/server/services/notifications";
import { presentNotification } from "@/server/services/notification-presentation";

import { markAllNotificationsReadAction } from "./actions";
import { NotificationsList } from "./NotificationsList";

export const metadata: Metadata = { title: "Notifikace" };
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function NotificationsPage({ searchParams }: PageProps) {
  const user = await requireUser();
  const sp = await searchParams;
  const unreadOnly =
    typeof sp.filter === "string" && sp.filter === "unread" ? true : false;

  const rows = await listNotificationsForUser({
    userId: user.id,
    unreadOnly,
    limit: 100,
  });
  const items = rows.map((n) => {
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
  const unreadCount = unreadOnly
    ? items.length
    : items.filter((i) => !i.readAt).length;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Notifikace</CardTitle>
            <CardDescription>
              {unreadOnly
                ? "Pouze nepřečtené."
                : "Všechny notifikace, nejnovější první."}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={
                unreadOnly ? "/notifications" : "/notifications?filter=unread"
              }
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
            >
              {unreadOnly ? "Zobrazit vše" : "Pouze nepřečtené"}
            </a>
            {unreadCount > 0 && (
              <form action={markAllNotificationsReadAction}>
                <Button type="submit" variant="outline" size="sm">
                  <CheckCheck className="size-4" aria-hidden /> Přečíst vše (
                  {unreadCount})
                </Button>
              </form>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <NotificationsList items={items} />
        </CardContent>
      </Card>
    </div>
  );
}
