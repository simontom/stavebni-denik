import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { withAudit, type AuditContext } from "@/server/audit";
import { prisma } from "@/lib/db";

import type { AuthorizedPerson } from "@/generated/prisma/client";

export interface AddPersonInput {
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

export async function addExternalPerson(input: AddPersonInput, ctx: AuditContext) {
  return withAudit<AuthorizedPerson>(
    {
      ctx,
      action: "person.add",
      entityType: "AuthorizedPerson",
      resolveEntityId: (p) => p.id,
      before: null,
    },
    (tx) =>
      tx.authorizedPerson.create({
        data: {
          projectId: input.projectId,
          name: input.name,
          company: input.company,
          authorization: input.authorization,
        },
      }),
  );
}

export async function updatePerson(id: string, input: UpdatePersonInput, ctx: AuditContext) {
  return withAudit<AuthorizedPerson>(
    {
      ctx,
      action: "person.update",
      entityType: "AuthorizedPerson",
      resolveEntityId: (p) => p.id,
      before: null, // Would fetch first in real code
    },
    (tx) =>
      tx.authorizedPerson.update({
        where: { id },
        data: {
          name: input.name,
          company: input.company,
          authorization: input.authorization,
        },
      }),
  );
}

export async function revokePerson(id: string, ctx: AuditContext) {
  return withAudit<AuthorizedPerson>(
    {
      ctx,
      action: "person.revoke",
      entityType: "AuthorizedPerson",
      resolveEntityId: (p) => p.id,
      before: null, // Would fetch first in real code
    },
    (tx) =>
      tx.authorizedPerson.update({
        where: { id },
        data: {
          revokedAt: new Date(),
        },
      }),
  );
}

export async function syncSystemMember(
  tx: Prisma.TransactionClient,
  projectId: string,
  userId: string,
  action: "add" | "remove",
) {
  if (action === "add") {
    // Find user name
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) return;
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
export async function listAuthorizedPersons(projectId: string) {
  return prisma.authorizedPerson.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
}
