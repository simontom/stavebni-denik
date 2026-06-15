"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { auth, signOut, update } from "@/server/auth";
import { getAuditContext } from "@/server/audit-context";
import {
  InvalidCurrentPasswordError,
  PasswordPolicyError,
  changePassword,
} from "@/server/services/users";
import { validatePasswordPolicy } from "@/lib/password-gen";

const schema = z
  .object({
    currentPassword: z.string().min(1, "Vyplňte stávající heslo."),
    newPassword: z.string().min(1, "Vyplňte nové heslo."),
    confirmPassword: z.string().min(1, "Potvrďte nové heslo."),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    path: ["confirmPassword"],
    message: "Hesla se neshodují.",
  });

export type ChangePasswordState = {
  fieldErrors?: Partial<
    Record<"currentPassword" | "newPassword" | "confirmPassword", string>
  >;
  formError?: string;
  policyIssues?: string[];
  success?: boolean;
};

export async function changePasswordAction(
  _prev: ChangePasswordState | undefined,
  data: FormData,
): Promise<ChangePasswordState> {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const parsed = schema.safeParse({
    currentPassword: data.get("currentPassword"),
    newPassword: data.get("newPassword"),
    confirmPassword: data.get("confirmPassword"),
  });
  if (!parsed.success) {
    const fieldErrors: ChangePasswordState["fieldErrors"] = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as keyof NonNullable<
        ChangePasswordState["fieldErrors"]
      >;
      if (field && !fieldErrors[field]) fieldErrors[field] = issue.message;
    }
    return { fieldErrors };
  }

  // Pre-validate policy to surface human messages even before reaching
  // the DB (saves an argon2 verify call).
  const policyIssues = validatePasswordPolicy(parsed.data.newPassword);
  if (policyIssues.length > 0) {
    return { policyIssues };
  }

  try {
    const ctx = await getAuditContext();
    await changePassword(
      session.user.id,
      parsed.data.currentPassword,
      parsed.data.newPassword,
      ctx,
    );
  } catch (err) {
    if (err instanceof InvalidCurrentPasswordError) {
      return {
        fieldErrors: { currentPassword: "Stávající heslo není správné." },
      };
    }
    if (err instanceof PasswordPolicyError) {
      return { policyIssues: err.issues };
    }
    return { formError: "Nepodařilo se změnit heslo. Zkuste to znovu." };
  }

  // Update the JWT in-place so `mustChangePwd` flips to false without
  // forcing the user to log in again.
  await update({ user: { mustChangePwd: false } });
  // Defence in depth: force a fresh login so any leaked old credential
  // is invalidated. Comment out if the UX overhead is unwelcome.
  await signOut({ redirect: false });
  redirect("/login?changed=1");
}
