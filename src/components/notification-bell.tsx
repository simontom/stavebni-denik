"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, Check, CheckCheck, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatDateTime } from "@/lib/dates";

import {
  deleteNotificationAction,
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "@/app/(app)/notifications/actions";

export interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

interface Props {
  items: NotificationItem[];
  unreadCount: number;
}

/**
 * Bell trigger + dropdown panel listing the latest 10 notifications.
 * The full archive lives at `/notifications`.
 *
 * The trigger Button itself shows a tiny red badge with the unread
 * count when > 0; opening the panel is a no-op for the read state
 * (only an explicit click on a row marks it read), so a quick peek
 * doesn't lose the heads-up.
 */
export function NotificationBell({ items, unreadCount }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleClick(item: NotificationItem) {
    startTransition(async () => {
      if (!item.readAt) {
        await markNotificationReadAction(item.id);
      }
      if (item.href) {
        setOpen(false);
        router.push(item.href);
      } else {
        router.refresh();
      }
    });
  }

  function handleMarkAll() {
    startTransition(async () => {
      await markAllNotificationsReadAction();
    });
  }

  function handleDelete(id: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    startTransition(async () => {
      await deleteNotificationAction(id);
    });
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="relative inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={
              unreadCount > 0
                ? `Notifikace (${unreadCount} nepřečtených)`
                : "Notifikace"
            }
          />
        }
      >
        <Bell className="size-4" aria-hidden />
        {unreadCount > 0 && (
          <span
            className="absolute top-1 right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground"
            aria-hidden
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[min(20rem,90vw)] p-0"
      >
        <div className="flex items-center justify-between border-b px-3 py-2 text-sm font-medium">
          <span>Notifikace</span>
          {unreadCount > 0 && (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground hover:text-foreground disabled:opacity-50"
              onClick={handleMarkAll}
              disabled={pending}
            >
              <CheckCheck className="size-3" aria-hidden /> Přečíst vše
            </button>
          )}
        </div>

        {items.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">
            Žádné notifikace.
          </p>
        ) : (
          <ul className="max-h-80 overflow-y-auto">
            {items.map((n) => (
              <li
                key={n.id}
                className={
                  "border-b last:border-b-0 " +
                  (n.readAt ? "" : "bg-muted/40")
                }
              >
                <button
                  type="button"
                  onClick={() => handleClick(n)}
                  disabled={pending}
                  className="grid w-full gap-0.5 px-3 py-2 text-left hover:bg-accent disabled:opacity-50"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={
                        n.readAt ? "text-sm" : "text-sm font-medium"
                      }
                    >
                      {n.title}
                    </span>
                    {!n.readAt && (
                      <Check
                        className="size-3 text-primary"
                        aria-label="nepřečtené"
                      />
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{n.body}</p>
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>{formatDateTime(n.createdAt)}</span>
                    <button
                      type="button"
                      onClick={(e) => handleDelete(n.id, e)}
                      disabled={pending}
                      className="inline-flex items-center gap-1 hover:text-destructive disabled:opacity-50"
                      aria-label="Smazat"
                    >
                      <Trash2 className="size-3" aria-hidden /> smazat
                    </button>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="border-t px-3 py-2 text-center text-xs">
          <Button
            variant="ghost"
            size="sm"
            render={<Link href="/notifications" onClick={() => setOpen(false)} />}
          >
            Zobrazit všechny
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
