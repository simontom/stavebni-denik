"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/server/rbac";
import {
  deleteNotification,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/server/services/notifications";

/** Mark a single notification read. Idempotent. */
export async function markNotificationReadAction(
  notificationId: string,
): Promise<void> {
  const user = await requireUser();
  await markNotificationRead({ notificationId, userId: user.id });
  // Bell is in the layout; refreshing the layout requires the leaf
  // path. Use a wildcard so any caller (dashboard, bell dropdown,
  // /notifications page) sees the new count.
  revalidatePath("/", "layout");
}

/** Mark every unread for the current user as read. */
export async function markAllNotificationsReadAction(): Promise<void> {
  const user = await requireUser();
  await markAllNotificationsRead(user.id);
  revalidatePath("/", "layout");
}

/** Hard-delete a notification owned by the caller. */
export async function deleteNotificationAction(
  notificationId: string,
): Promise<void> {
  const user = await requireUser();
  await deleteNotification({ notificationId, userId: user.id });
  revalidatePath("/", "layout");
}
