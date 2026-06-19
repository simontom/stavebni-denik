import "server-only";

import { Prisma, type Notification } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

/**
 * Per-user in-app notifications.
 *
 * Notifications are UI state, not domain mutations: they don't go
 * through `withAudit`, hard-deletes are allowed, and a user
 * unilaterally controls their own read state. The forensic audit
 * log keeps the underlying event (e.g. 'audit.chain.verify-failed')
 * — notifications are just a heads-up that's cheaper than SMTP for
 * a small construction firm.
 *
 * `kind` strings are stable enough for the UI to switch on:
 *   * `audit.chain_broken`  — verify-audit script found a tamper.
 *   * `report.signed`       — a daily report was signed (BOSS notif).
 * The actual rendering (icon / wording / deep link) is in
 * `src/app/(app)/notifications/notification-card.tsx`.
 */

export type NotificationKind =
  | "audit.chain_broken"
  | "report.signed";

export interface NotificationView {
  id: string;
  kind: NotificationKind;
  payload: unknown;
  href: string | null;
  readAt: Date | null;
  createdAt: Date;
}

function toView(n: Notification): NotificationView {
  return {
    id: n.id,
    kind: n.kind as NotificationKind,
    payload: n.payload,
    href: n.href,
    readAt: n.readAt,
    createdAt: n.createdAt,
  };
}

/** Cast a typed object into Prisma's JSON input type. */
function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/**
 * Append a single notification. No-op when `recipientId` doesn't
 * resolve (the FK would throw); we silently skip so the calling
 * context (cron / verify-audit) doesn't crash on stale recipients.
 *
 * Returns the created notification id, or null when the recipient
 * was missing.
 */
export async function notifyUser(opts: {
  recipientId: string;
  kind: NotificationKind;
  payload: Record<string, unknown>;
  href?: string | null;
}): Promise<string | null> {
  try {
    const n = await prisma.notification.create({
      data: {
        recipientId: opts.recipientId,
        kind: opts.kind,
        payload: asJson(opts.payload),
        href: opts.href ?? null,
      },
      select: { id: true },
    });
    return n.id;
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2003"
    ) {
      // Foreign-key violation = stale recipient id; skip.
      return null;
    }
    throw err;
  }
}

/**
 * Broadcast a notification to every active user with one of the
 * given roles. Used by `verify-audit` to alert all BOSS users when
 * the chain breaks.
 */
export async function notifyByRole(opts: {
  roles: Array<"BOSS" | "WORKER" | "GUEST">;
  kind: NotificationKind;
  payload: Record<string, unknown>;
  href?: string | null;
}): Promise<number> {
  const recipients = await prisma.user.findMany({
    where: {
      role: { in: opts.roles },
      isActive: true,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (recipients.length === 0) return 0;

  await prisma.notification.createMany({
    data: recipients.map((r) => ({
      recipientId: r.id,
      kind: opts.kind,
      payload: asJson(opts.payload),
      href: opts.href ?? null,
    })),
  });
  return recipients.length;
}

const DEFAULT_LIMIT = 50;

/** Newest-first listing of the recipient's own notifications. */
export async function listNotificationsForUser(opts: {
  userId: string;
  unreadOnly?: boolean;
  limit?: number;
}): Promise<NotificationView[]> {
  const rows = await prisma.notification.findMany({
    where: {
      recipientId: opts.userId,
      ...(opts.unreadOnly ? { readAt: null } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limit ?? DEFAULT_LIMIT, 200),
  });
  return rows.map(toView);
}

/** Cheap unread count for the bell badge. */
export async function countUnreadForUser(userId: string): Promise<number> {
  return prisma.notification.count({
    where: { recipientId: userId, readAt: null },
  });
}

/**
 * Mark a notification read. Refuses to touch other users' rows even
 * with a known id — the where clause matches both id AND
 * recipientId. Returns true if the row was updated.
 */
export async function markNotificationRead(opts: {
  notificationId: string;
  userId: string;
}): Promise<boolean> {
  const result = await prisma.notification.updateMany({
    where: {
      id: opts.notificationId,
      recipientId: opts.userId,
      readAt: null,
    },
    data: { readAt: new Date() },
  });
  return result.count > 0;
}

/** Mark every unread notification for the user as read. */
export async function markAllNotificationsRead(userId: string): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { recipientId: userId, readAt: null },
    data: { readAt: new Date() },
  });
  return result.count;
}

/**
 * Hard-delete a single notification owned by the caller.
 * Idempotent — does nothing if the row doesn't exist or doesn't
 * belong to the user.
 */
export async function deleteNotification(opts: {
  notificationId: string;
  userId: string;
}): Promise<boolean> {
  const result = await prisma.notification.deleteMany({
    where: { id: opts.notificationId, recipientId: opts.userId },
  });
  return result.count > 0;
}
