"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getAuditContext } from "@/server/audit-context";
import {
  NicknameInUseError,
  createUser,
  createUserSchema,
  setUserActive,
  type CreateUserResult,
} from "@/server/services/users";
import { requireBoss } from "@/server/rbac";

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
    actor = await requireBoss();
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

export async function setUserActiveAction(data: FormData): Promise<void> {
  await requireBoss();
  const parsed = setActiveSchema.safeParse({
    userId: data.get("userId"),
    isActive: data.get("isActive"),
  });
  if (!parsed.success) return;
  const ctx = await getAuditContext();
  await setUserActive(
    parsed.data.userId,
    parsed.data.isActive === "1",
    ctx,
  );
  revalidatePath("/admin/users");
}
