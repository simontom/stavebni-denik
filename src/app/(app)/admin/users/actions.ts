"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { ADMIN_PASSWORD_RESET_LIMIT, checkRateLimit } from "@/server/rate-limit";
import {
  CannotDeleteSelfError,
  CannotDeleteSiteManagerError,
  CannotRemoveLastAdminError,
  NicknameInUseError,
  UserNotFoundError,
  createUser,
  createUserSchema,
  deleteUser,
  resetUserPasswordByAdmin,
  setUserActive,
  updateUser,
  updateUserSchema,
} from "@/server/services/users";
import { adminActionClient } from "@/server/safe-action";

import { returnServerError } from "next-safe-action";

export const createUserAction = adminActionClient
  .schema(createUserSchema)
  .action(async ({ parsedInput, ctx }) => {
    try {
      const result = await createUser(parsedInput, ctx.auditContext, ctx.user.id);
      revalidatePath("/admin/users");
      return result;
    } catch (err) {
      if (err instanceof NicknameInUseError) {
        returnServerError("Toto přihlašovací jméno je již obsazené.");
      }
      throw err;
    }
  });

export const updateUserAction = adminActionClient
  .schema(
    updateUserSchema.extend({
      userId: z.string(),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    try {
      const { userId, ...data } = parsedInput;
      await updateUser(userId, data, ctx.auditContext);
      revalidatePath("/admin/users");
      return { ok: true };
    } catch (err) {
      if (err instanceof UserNotFoundError) {
        return returnServerError("Uživatel nebyl nalezen.");
      }
      if (err instanceof CannotRemoveLastAdminError) {
        return returnServerError(
          "Nelze odebrat poslednímu adminovi flag — aplikace by zůstala bez správce.",
        );
      }
      throw err;
    }
  });

export const setUserActiveAction = adminActionClient
  .schema(z.object({ userId: z.string(), isActive: z.boolean() }))
  .action(async ({ parsedInput, ctx }) => {
    await setUserActive(parsedInput.userId, parsedInput.isActive, ctx.auditContext);
    revalidatePath("/admin/users");
    return { ok: true };
  });

export const deleteUserAction = adminActionClient
  .schema(z.object({ userId: z.string() }))
  .action(async ({ parsedInput, ctx }) => {
    try {
      await deleteUser(parsedInput.userId, ctx.auditContext, ctx.user.id);
      revalidatePath("/admin/users");
      return { ok: true };
    } catch (err) {
      if (err instanceof CannotDeleteSelfError || err instanceof CannotDeleteSiteManagerError) {
        return returnServerError(err.message);
      }
      throw err; // Let handleServerError catch unknown errors
    }
  });

export const resetPasswordAction = adminActionClient
  .schema(z.object({ userId: z.string() }))
  .action(async ({ parsedInput, ctx }) => {
    const target = await prisma.user.findUniqueOrThrow({
      where: { id: parsedInput.userId },
      select: { nickname: true, displayName: true },
    });

    const rl = await checkRateLimit({
      ...ADMIN_PASSWORD_RESET_LIMIT,
      key: ctx.user.id,
    });
    if (!rl.allowed) {
      const minutes = Math.ceil(rl.retryAfterMs / 60_000);
      return returnServerError(`Příliš mnoho resetů hesla. Zkuste to znovu za ${minutes} min.`);
    }

    const { generatedPassword } = await resetUserPasswordByAdmin(
      parsedInput.userId,
      ctx.auditContext,
      ctx.user.id,
    );
    revalidatePath("/admin/users");
    return {
      generatedPassword,
      nickname: target.nickname,
      displayName: target.displayName,
    };
  });

export const resetUserPasswordAction = resetPasswordAction;
