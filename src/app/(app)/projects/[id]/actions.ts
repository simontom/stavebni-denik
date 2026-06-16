"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getAuditContext } from "@/server/audit-context";
import { requireBoss } from "@/server/rbac";
import {
  ProjectNotFoundError,
  SiteManagerInvalidError,
  addProjectMember,
  archiveProject,
  createProjectSchema,
  normalizeProjectForm,
  removeProjectMember,
  restoreProject,
  updateProject,
} from "@/server/services/projects";

import type { ProjectFormState } from "../form-types";

const roleSchema = z.enum(["BOSS", "WORKER", "GUEST"]);

/**
 * Edit an existing project. The project id is bound on the server
 * (`updateProjectAction.bind(null, id)`) so the client form does not
 * have to carry — or be able to tamper with — the target id.
 */
export async function updateProjectAction(
  projectId: string,
  _prev: ProjectFormState | undefined,
  data: FormData,
): Promise<ProjectFormState> {
  try {
    await requireBoss();
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

  try {
    const ctx = await getAuditContext();
    await updateProject(projectId, parsed.data, ctx);
  } catch (err) {
    if (err instanceof SiteManagerInvalidError) {
      return { status: "site-manager-invalid" };
    }
    if (err instanceof ProjectNotFoundError) {
      return { status: "not-found" };
    }
    return { status: "error", message: "Uložení změn se nezdařilo." };
  }

  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
  redirect(`/projects/${projectId}`);
}

export async function addMemberAction(data: FormData): Promise<void> {
  const actor = await requireBoss();
  const projectId = String(data.get("projectId") ?? "");
  const userId = String(data.get("userId") ?? "");
  const role = roleSchema.safeParse(data.get("role"));
  if (!projectId || !userId || !role.success) return;

  const ctx = await getAuditContext();
  try {
    await addProjectMember(projectId, userId, role.data, ctx, actor.id);
  } catch {
    // Invalid/inactive user or archived project — silently ignore; the
    // candidate list only ever offers valid users so this is defensive.
  }
  revalidatePath(`/projects/${projectId}`);
}

export async function removeMemberAction(data: FormData): Promise<void> {
  await requireBoss();
  const projectId = String(data.get("projectId") ?? "");
  const userId = String(data.get("userId") ?? "");
  if (!projectId || !userId) return;

  const ctx = await getAuditContext();
  await removeProjectMember(projectId, userId, ctx);
  revalidatePath(`/projects/${projectId}`);
}

export async function archiveProjectAction(data: FormData): Promise<void> {
  await requireBoss();
  const projectId = String(data.get("projectId") ?? "");
  if (!projectId) return;

  const ctx = await getAuditContext();
  try {
    await archiveProject(projectId, ctx);
  } catch {
    return;
  }
  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
  redirect("/projects");
}

export async function restoreProjectAction(data: FormData): Promise<void> {
  await requireBoss();
  const projectId = String(data.get("projectId") ?? "");
  if (!projectId) return;

  const ctx = await getAuditContext();
  try {
    await restoreProject(projectId, ctx);
  } catch {
    return;
  }
  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
  redirect(`/projects/${projectId}`);
}
