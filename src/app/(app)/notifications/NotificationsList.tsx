"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Check, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";

import {
  deleteNotificationAction,
  markNotificationReadAction,
} from "./actions";

export interface NotificationListItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

interface Props {
  items: NotificationListItem[];
}

/**
 * Notification table on /notifications. Each row is rendered as a
 * single tap-friendly button: tap → mark read → either deep-link
 * (when `href` is set) or just refresh.
 */
export function NotificationsList({ items }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Žádné notifikace.
      </p>
    );
  }

  function activate(item: NotificationListItem) {
    startTransition(async () => {
      if (!item.readAt) await markNotificationReadAction(item.id);
      if (item.href) router.push(item.href);
      else router.refresh();
    });
  }

  function remove(id: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    startTransition(async () => {
      await deleteNotificationAction(id);
    });
  }

  return (
    <ul className="flex flex-col divide-y">
      {items.map((n) => (
        <li
          key={n.id}
          className={n.readAt ? "py-3" : "bg-muted/40 py-3"}
        >
          <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <button
              type="button"
              onClick={() => activate(n)}
              disabled={pending}
              className="flex flex-1 flex-col gap-0.5 text-left disabled:opacity-50"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={
                    n.readAt
                      ? "text-sm"
                      : "text-sm font-medium text-foreground"
                  }
                >
                  {n.title}
                </span>
                {!n.readAt && (
                  <Badge variant="secondary" className="text-[10px]">
                    nepřečtené
                  </Badge>
                )}
                {n.href && (
                  <Badge variant="outline" className="text-[10px]">
                    detail →
                  </Badge>
                )}
              </div>
              {n.body && (
                <p className="text-sm text-muted-foreground">{n.body}</p>
              )}
              <span className="text-xs text-muted-foreground">
                {formatDateTime(n.createdAt)}
              </span>
            </button>
            <div className="flex items-center gap-1 self-end sm:self-start">
              {!n.readAt && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    startTransition(async () => {
                      await markNotificationReadAction(n.id);
                    })
                  }
                  disabled={pending}
                >
                  <Check className="size-4" aria-hidden /> Přečteno
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={(e) => remove(n.id, e)}
                disabled={pending}
                aria-label="Smazat notifikaci"
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </div>
          </div>
        </li>
      ))}
      <li className="pt-3 text-xs text-muted-foreground">
        <Link href="/" className="hover:underline">
          Zpět na úvod
        </Link>
      </li>
    </ul>
  );
}
