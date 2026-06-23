"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getAuditContext } from "@/server/audit-context";
import {
  CannotDeleteSelfError,
  CannotDeleteSiteManagerError,
  NicknameInUseError,
  createUser,
  createUserSchema,
  deleteUser,
  setUserActive,
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
