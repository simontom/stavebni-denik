import "server-only";

import { prisma } from "@/lib/db";
import type { SiteHandover } from "@/generated/prisma/client";
import { withAudit, type AuditContext } from "@/server/audit";

export async function createHandover(projectId: string, actorId: string, data: any): Promise<SiteHandover> {
  const ctx: AuditContext = { actor: { id: actorId }, ip: null, userAgent: null };
  return withAudit(
    {
      ctx,
      action: "handover.create" as any,
      entityType: "site_handover",
      resolveEntityId: (h) => h.id,
      before: null,
    },
    (tx) => tx.siteHandover.create({
      data: {
        projectId,
        type: data.type,
        date: data.date,
        participants: data.participants,
        meterStates: data.meterStates,
        notes: data.notes,
      }
    })
  );
}

export async function updateHandover(id: string, actorId: string, data: any): Promise<SiteHandover> {
  const ctx: AuditContext = { actor: { id: actorId }, ip: null, userAgent: null };
  const before = await prisma.siteHandover.findUnique({ where: { id } });
  
  return withAudit(
    {
      ctx,
      action: "handover.update" as any,
      entityType: "site_handover",
      resolveEntityId: (h) => h.id,
      before,
    },
    (tx) => tx.siteHandover.update({
      where: { id },
      data: {
        type: data.type,
        date: data.date,
        participants: data.participants,
        meterStates: data.meterStates,
        notes: data.notes,
      }
    })
  );
}

export async function deleteHandover(id: string, actorId: string): Promise<SiteHandover> {
  const ctx: AuditContext = { actor: { id: actorId }, ip: null, userAgent: null };
  const before = await prisma.siteHandover.findUnique({ where: { id } });
  
  return withAudit(
    {
      ctx,
      action: "handover.delete" as any,
      entityType: "site_handover",
      resolveEntityId: (h) => h.id,
      before,
    },
    (tx) => tx.siteHandover.update({
      where: { id },
      data: { deletedAt: new Date() }
    })
  );
}

export async function signHandover(id: string, actorId: string): Promise<SiteHandover> {
  const handover = await prisma.siteHandover.findUnique({ where: { id } });
  if (!handover) throw new Error("Not found");
  
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: handover.projectId, userId: actorId } }
  });
  if (!member || member.role !== "BOSS") {
    throw new Error("Must be BOSS");
  }

  const ctx: AuditContext = { actor: { id: actorId }, ip: null, userAgent: null };
  
  return withAudit(
    {
      ctx,
      action: "handover.sign" as any,
      entityType: "site_handover",
      resolveEntityId: (h) => h.id,
      before: handover,
    },
    (tx) => tx.siteHandover.update({
      where: { id },
      data: { signedAt: new Date() }
    })
  );
}
export async function listHandovers(projectId: string): Promise<SiteHandover[]> {
  return prisma.siteHandover.findMany({
    where: { projectId, deletedAt: null },
    orderBy: { date: 'desc' }
  });
}
