"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getAuditContext } from "@/server/audit-context";
import { requireBoss } from "@/server/rbac";
import {
  SiteManagerInvalidError,
  createProject,
  createProjectSchema,
  normalizeProjectForm,
} from "@/server/services/projects";

import type { ProjectFormState } from "../form-types";

export async function createProjectAction(
  _prev: ProjectFormState | undefined,
  data: FormData,
): Promise<ProjectFormState> {
  let actor;
  try {
    actor = await requireBoss();
  } catch {
    return { status: "forbidden" };
  }

  const parsed = createProjectSchema.safeParse(normalizeProjectForm(data));
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as string | undefined;
      if (field && !fieldErrors[field]) fieldErrors[field] = issue.message;
    }
    return { status: "field-error", fieldErrors };
  }

  let projectId: string;
  try {
    const ctx = await getAuditContext();
    const project = await createProject(parsed.data, ctx, actor.id);
    projectId = project.id;
  } catch (err) {
    if (err instanceof SiteManagerInvalidError) {
      return { status: "site-manager-invalid" };
    }
    return { status: "error", message: "Založení zakázky se nezdařilo." };
  }

  // redirect() throws NEXT_REDIRECT — keep it outside the try/catch above.
  revalidatePath("/projects");
  redirect(`/projects/${projectId}`);
}
