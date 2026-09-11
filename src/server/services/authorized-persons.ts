import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { withAudit, type AuditContext } from "@/server/audit";
import { prisma } from "@/lib/db";

export interface AddExternalPersonInput {
  projectId: string;
  name: string;
  company?: string;
  authorization?: string;
}

export interface UpdatePersonInput {
  name: string;
  company?: string;
  authorization?: string;
}

export async function addExternalPerson(
  input: AddExternalPersonInput,
  ctx: AuditContext,
) {
  return withAudit<any>(
    {
      ctx,
      action: "project.update" as any,
      entityType: "AuthorizedPerson",
      resolveEntityId: (p) => p.id,
    },
    async (tx) => {
      return tx.authorizedPerson.create({
        data: {
          projectId: input.projectId,
          name: input.name,
          company: input.company,
          authorization: input.authorization,
        },
      });
    },
  );
}

export async function updatePerson(
  id: string,
  input: UpdatePersonInput,
  ctx: AuditContext,
) {
  return withAudit<any>(
    {
      ctx,
      action: "project.update" as any,
      entityType: "AuthorizedPerson",
      resolveEntityId: (p) => p.id,
    },
    async (tx) => {
      return tx.authorizedPerson.update({
        where: { id },
        data: {
          name: input.name,
          company: input.company,
          authorization: input.authorization,
        },
      });
    },
  );
}

export async function revokePerson(id: string, ctx: AuditContext) {
  return withAudit<any>(
    {
      ctx,
      action: "project.update" as any,
      entityType: "AuthorizedPerson",
      resolveEntityId: (p) => p.id,
    },
    async (tx) => {
      return tx.authorizedPerson.update({
        where: { id },
        data: {
          revokedAt: new Date(),
        },
      });
    },
  );
}

export async function syncSystemMember(
  tx: Prisma.TransactionClient,
  projectId: string,
  userId: string,
  action: "add" | "remove",
) {
  if (action === "add") {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    await tx.authorizedPerson.create({
      data: {
        projectId,
        linkedUserId: userId,
        name: user.displayName,
      },
    });
  } else {
    // Soft revoke all linked for this user and project
    await tx.authorizedPerson.updateMany({
      where: {
        projectId,
        linkedUserId: userId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
  }
}
