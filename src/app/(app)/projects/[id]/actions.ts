"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getAuditContext } from "@/server/audit-context";
import { requireBoss } from "@/server/rbac";
import { bossActionClient } from "@/server/safe-action";
import {
  addExternalPerson,
  revokePerson,
  updatePerson,
} from "@/server/services/authorized-persons";
import {
  authorizedPersonSchema,
  createHandoverSchema,
  projectMemberRoleSchema,
} from "@/server/services/legislative-validation";
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
import { createHandover, deleteHandover, signHandover } from "@/server/services/site-handovers";

import type { ProjectFormState } from "../form-types";

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

export const addMemberAction = bossActionClient
  .schema(
    z.object({
      projectId: z.string().min(1),
      userId: z.string().min(1),
      role: roleSchema,
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    try {
      await addProjectMember(
        parsedInput.projectId,
        parsedInput.userId,
        parsedInput.role,
        ctx.auditContext,
        ctx.user.id,
      );
    } catch {
      // Invalid/inactive user or archived project — silently ignore
    }
    revalidatePath(`/projects/${parsedInput.projectId}`);
    return { ok: true };
  });

export const removeMemberAction = bossActionClient
  .schema(
    z.object({
      projectId: z.string().min(1),
      userId: z.string().min(1),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    await removeProjectMember(parsedInput.projectId, parsedInput.userId, ctx.auditContext);
    revalidatePath(`/projects/${parsedInput.projectId}`);
    return { ok: true };
  });

export const archiveProjectAction = bossActionClient
  .schema(z.object({ projectId: z.string().min(1) }))
  .action(async ({ parsedInput, ctx }) => {
    await archiveProject(parsedInput.projectId, ctx.auditContext);
    revalidatePath("/projects");
    revalidatePath(`/projects/${parsedInput.projectId}`);
    redirect("/projects");
  });

export const restoreProjectAction = bossActionClient
  .schema(z.object({ projectId: z.string().min(1) }))
  .action(async ({ parsedInput, ctx }) => {
    await restoreProject(parsedInput.projectId, ctx.auditContext);
    revalidatePath("/projects");
    revalidatePath(`/projects/${parsedInput.projectId}`);
    redirect(`/projects/${parsedInput.projectId}`);
  });

export const createHandoverAction = bossActionClient
  .schema(
    createHandoverSchema.extend({
      projectId: z.string().min(1),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    const { projectId, ...handoverData } = parsedInput;
    const result = await createHandover(projectId, ctx.user.id, handoverData);
    revalidatePath(`/projects/${projectId}`);
    return result;
  });

export const signHandoverAction = bossActionClient
  .schema(
    z.object({
      handoverId: z.string().min(1),
      projectId: z.string().min(1),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    await signHandover(parsedInput.handoverId, ctx.user.id);
    revalidatePath(`/projects/${parsedInput.projectId}`);
    return { ok: true };
  });

export const deleteHandoverAction = bossActionClient
  .schema(
    z.object({
      handoverId: z.string().min(1),
      projectId: z.string().min(1),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    await deleteHandover(parsedInput.handoverId, ctx.user.id);
    revalidatePath(`/projects/${parsedInput.projectId}`);
    return { ok: true };
  });

export const addAuthorizedPersonAction = bossActionClient
  .schema(
    authorizedPersonSchema.extend({
      projectId: z.string().min(1),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    const { projectId, ...personData } = parsedInput;
    const result = await addExternalPerson({ projectId, ...personData }, ctx.auditContext);
    revalidatePath(`/projects/${projectId}`);
    return result;
  });

export const updateAuthorizedPersonAction = bossActionClient
  .schema(
    authorizedPersonSchema.extend({
      personId: z.string().min(1),
      projectId: z.string().min(1),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    const { personId, projectId, ...personData } = parsedInput;
    const result = await updatePerson(personId, personData, ctx.auditContext);
    revalidatePath(`/projects/${projectId}`);
    return result;
  });

export const revokeAuthorizedPersonAction = bossActionClient
  .schema(
    z.object({
      personId: z.string().min(1),
      projectId: z.string().min(1),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    await revokePerson(parsedInput.personId, ctx.auditContext);
    revalidatePath(`/projects/${parsedInput.projectId}`);
    return { ok: true };
  });
