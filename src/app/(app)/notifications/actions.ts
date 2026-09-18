"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authActionClient } from "@/server/safe-action";
import {
  deleteNotification,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/server/services/notifications";

/** Mark a single notification read. Idempotent. */
export const markNotificationReadAction = authActionClient
  .schema(z.object({ notificationId: z.string() }))
  .action(async ({ parsedInput, ctx }) => {
    await markNotificationRead({
      notificationId: parsedInput.notificationId,
      userId: ctx.user.id,
    });
    revalidatePath("/", "layout");
    return { ok: true };
  });

/** Mark every unread for the current user as read. */
export const markAllNotificationsReadAction = authActionClient.action(async ({ ctx }) => {
  await markAllNotificationsRead(ctx.user.id);
  revalidatePath("/", "layout");
  return { ok: true };
});

/** Hard-delete a notification owned by the caller. */
export const deleteNotificationAction = authActionClient
  .schema(z.object({ notificationId: z.string() }))
  .action(async ({ parsedInput, ctx }) => {
    await deleteNotification({
      notificationId: parsedInput.notificationId,
      userId: ctx.user.id,
    });
    revalidatePath("/", "layout");
    return { ok: true };
  });
