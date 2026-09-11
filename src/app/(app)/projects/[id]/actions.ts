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
import {
  authorizedPersonSchema,
  createHandoverSchema,
  projectMemberRoleSchema,
} from "@/server/services/legislative-validation";
import {
  createHandover,
  deleteHandover,
  signHandover,
} from "@/server/services/site-handovers";
import {
  addExternalPerson,
  revokePerson,
  updatePerson,
} from "@/server/services/authorized-persons";

const roleSchema = projectMemberRoleSchema;

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

export async function createHandoverAction(
  projectId: string,
  data: FormData,
): Promise<{ error?: string }> {
  const actor = await requireBoss();
  const raw = {
    type: String(data.get("type") ?? ""),
    date: String(data.get("date") ?? ""),
    participants: String(data.get("participants") ?? ""),
    meterStates: String(data.get("meterStates") ?? ""),
    notes: String(data.get("notes") ?? ""),
  };

  const parsed = createHandoverSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Neplatná data" };
  }

  await createHandover(projectId, actor.id, parsed.data);
  revalidatePath(`/projects/${projectId}`);
  return {};
}

export async function signHandoverAction(
  handoverId: string,
  projectId: string,
): Promise<void> {
  const actor = await requireBoss();
  await signHandover(handoverId, actor.id);
  revalidatePath(`/projects/${projectId}`);
}

export async function deleteHandoverAction(
  handoverId: string,
  projectId: string,
): Promise<void> {
  const actor = await requireBoss();
  await deleteHandover(handoverId, actor.id);
  revalidatePath(`/projects/${projectId}`);
}

export async function addAuthorizedPersonAction(
  projectId: string,
  data: FormData,
): Promise<{ error?: string }> {
  await requireBoss();
  const raw = {
    name: String(data.get("name") ?? ""),
    company: String(data.get("company") ?? ""),
    authorization: String(data.get("authorization") ?? ""),
  };

  const parsed = authorizedPersonSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Neplatná data" };
  }

  const ctx = await getAuditContext();
  await addExternalPerson({ projectId, ...parsed.data }, ctx);
  revalidatePath(`/projects/${projectId}`);
  return {};
}

export async function updateAuthorizedPersonAction(
  personId: string,
  projectId: string,
  data: FormData,
): Promise<{ error?: string }> {
  await requireBoss();
  const raw = {
    name: String(data.get("name") ?? ""),
    company: String(data.get("company") ?? ""),
    authorization: String(data.get("authorization") ?? ""),
  };

  const parsed = authorizedPersonSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Neplatná data" };
  }

  const ctx = await getAuditContext();
  await updatePerson(personId, parsed.data, ctx);
  revalidatePath(`/projects/${projectId}`);
  return {};
}

export async function revokeAuthorizedPersonAction(
  personId: string,
  projectId: string,
): Promise<void> {
  await requireBoss();
  const ctx = await getAuditContext();
  await revokePerson(personId, ctx);
  revalidatePath(`/projects/${projectId}`);
}
