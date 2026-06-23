"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { getAuditContext } from "@/server/audit-context";
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
  type CreateUserResult,
} from "@/server/services/users";
import { requireAdmin } from "@/server/rbac";

export type CreateUserState =
  | { status: "idle" }
  | { status: "ok"; result: CreateUserResult }
  | { status: "field-error"; fieldErrors: Record<string, string> }
  | { status: "nickname-in-use" }
  | { status: "forbidden" }
  | { status: "error"; message: string };

export async function createUserAction(
  _prev: CreateUserState | undefined,
  data: FormData,
): Promise<CreateUserState> {
  let actor;
  try {
    actor = await requireAdmin();
  } catch {
    return { status: "forbidden" };
  }

  const parsed = createUserSchema.safeParse({
    nickname: String(data.get("nickname") ?? ""),
    displayName: String(data.get("displayName") ?? ""),
    role: String(data.get("role") ?? ""),
    ckaitNumber: ((): string | null => {
      const raw = data.get("ckaitNumber");
      if (raw === null) return null;
      const trimmed = String(raw).trim();
      return trimmed.length === 0 ? null : trimmed;
    })(),
    // HTML checkbox: when checked, value is "true"; when unchecked,
    // the field is absent (data.get returns null) → false.
    isAdmin: data.get("isAdmin") === "true",
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as string | undefined;
      if (field && !fieldErrors[field]) fieldErrors[field] = issue.message;
    }
    return { status: "field-error", fieldErrors };
  }

  try {
    const ctx = await getAuditContext();
    const result = await createUser(parsed.data, ctx, actor.id);
    revalidatePath("/admin/users");
    return { status: "ok", result };
  } catch (err) {
    if (err instanceof NicknameInUseError) {
      return { status: "nickname-in-use" };
    }
    return {
      status: "error",
      message: "Vytvoření uživatele se nezdařilo.",
    };
  }
}

export type UpdateUserState =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "field-error"; fieldErrors: Record<string, string> }
  | { status: "forbidden" }
  | { status: "not-found" }
  | { status: "last-admin" }
  | { status: "error"; message: string };

export async function updateUserAction(
  _prev: UpdateUserState | undefined,
  data: FormData,
): Promise<UpdateUserState> {
  try {
    await requireAdmin();
  } catch {
    return { status: "forbidden" };
  }

  const userId = String(data.get("userId") ?? "").trim();
  if (userId.length === 0) {
    return { status: "error", message: "Chybí ID uživatele." };
  }

  const parsed = updateUserSchema.safeParse({
    displayName: String(data.get("displayName") ?? ""),
    role: String(data.get("role") ?? ""),
    ckaitNumber: ((): string | null => {
      const raw = data.get("ckaitNumber");
      if (raw === null) return null;
      const trimmed = String(raw).trim();
      return trimmed.length === 0 ? null : trimmed;
    })(),
    isAdmin: data.get("isAdmin") === "true",
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as string | undefined;
      if (field && !fieldErrors[field]) fieldErrors[field] = issue.message;
    }
    return { status: "field-error", fieldErrors };
  }

  try {
    const ctx = await getAuditContext();
    await updateUser(userId, parsed.data, ctx);
  } catch (err) {
    if (err instanceof UserNotFoundError) {
      return { status: "not-found" };
    }
    if (err instanceof CannotRemoveLastAdminError) {
      return { status: "last-admin" };
    }
    console.error("[updateUserAction]", err);
    return {
      status: "error",
      message: "Uložení se nezdařilo. Zkuste to znovu.",
    };
  }
  revalidatePath("/admin/users");
  return { status: "ok" };
}

const setActiveSchema = z.object({
  userId: z.string().min(1),
  isActive: z.enum(["1", "0"]),
});

export type SetUserActiveResult =
  | { ok: true }
  | { ok: false; error: string };

export async function setUserActiveAction(
  data: FormData,
): Promise<SetUserActiveResult> {
  try {
    await requireAdmin();
  } catch {
    return { ok: false, error: "Nemáte oprávnění (přihlaste se znovu jako admin)." };
  }
  const parsed = setActiveSchema.safeParse({
    userId: data.get("userId"),
    isActive: data.get("isActive"),
  });
  if (!parsed.success) {
    return { ok: false, error: "Neplatný požadavek." };
  }
  try {
    const ctx = await getAuditContext();
    await setUserActive(
      parsed.data.userId,
      parsed.data.isActive === "1",
      ctx,
    );
  } catch (err) {
    console.error("[setUserActiveAction]", err);
    return {
      ok: false,
      error: "Změna stavu se nezdařila. Zkuste to znovu.",
    };
  }
  revalidatePath("/admin/users");
  return { ok: true };
}

export type DeleteUserResult =
  | { ok: true }
  | { ok: false; error: string };

export async function deleteUserAction(
  data: FormData,
): Promise<DeleteUserResult> {
  let actor;
  try {
    actor = await requireAdmin();
  } catch {
    return { ok: false, error: "Nemáte oprávnění (přihlaste se znovu jako admin)." };
  }
  const userId = String(data.get("userId") ?? "").trim();
  if (userId.length === 0) {
    return { ok: false, error: "Chybí ID uživatele." };
  }
  try {
    const ctx = await getAuditContext();
    await deleteUser(userId, ctx, actor.id);
  } catch (err) {
    if (err instanceof CannotDeleteSelfError) {
      return { ok: false, error: err.message };
    }
    if (err instanceof CannotDeleteSiteManagerError) {
      return { ok: false, error: err.message };
    }
    console.error("[deleteUserAction]", err);
    return {
      ok: false,
      error: "Smazání se nezdařilo. Zkuste to znovu.",
    };
  }
  revalidatePath("/admin/users");
  return { ok: true };
}

export type ResetPasswordResult =
  | { ok: true; generatedPassword: string; nickname: string; displayName: string }
  | { ok: false; error: string };

export async function resetUserPasswordAction(
  data: FormData,
): Promise<ResetPasswordResult> {
  let actor;
  try {
    actor = await requireAdmin();
  } catch {
    return { ok: false, error: "Nemáte oprávnění (přihlaste se znovu jako admin)." };
  }
  const userId = String(data.get("userId") ?? "").trim();
  if (userId.length === 0) {
    return { ok: false, error: "Chybí ID uživatele." };
  }

  // Rate limit per actor — viz ADMIN_PASSWORD_RESET_LIMIT v rate-limit.ts.
  // Bez tohohle by admin mohl náhodným klikáním resetnout hesla a revokovat
  // sessions desítkám uživatelů během minuty.
  const rl = await checkRateLimit({
    ...ADMIN_PASSWORD_RESET_LIMIT,
    key: actor.id,
  });
  if (!rl.allowed) {
    const minutes = Math.ceil(rl.retryAfterMs / 60_000);
    return {
      ok: false,
      error: `Příliš mnoho resetů hesla. Zkuste to znovu za ${minutes} min.`,
    };
  }

  try {
    const ctx = await getAuditContext();
    const { generatedPassword } = await resetUserPasswordByAdmin(
      userId,
      ctx,
      actor.id,
    );
    const target = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { nickname: true, displayName: true },
    });
    revalidatePath("/admin/users");
    return {
      ok: true,
      generatedPassword,
      nickname: target.nickname,
      displayName: target.displayName,
    };
  } catch (err) {
    if (err instanceof UserNotFoundError) {
      return { ok: false, error: "Uživatel nebyl nalezen." };
    }
    if (err instanceof Error && err.message.includes("vlastního hesla")) {
      return { ok: false, error: err.message };
    }
    console.error("[resetUserPasswordAction]", err);
    return {
      ok: false,
      error: "Reset hesla se nezdařil. Zkuste to znovu.",
    };
  }
}
