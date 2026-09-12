import "server-only";

import { prisma } from "@/lib/db";
import type { SiteHandover, Prisma } from "@/generated/prisma/client";
import { withAudit, type AuditContext } from "@/server/audit";
import { ForbiddenError } from "@/server/permissions";

export interface HandoverInput {
  type: string;
  date: Date;
  participants: string;
  meterStates: Prisma.JsonValue;
  notes?: string | null;
}

export async function createHandover(projectId: string, actorId: string, data: HandoverInput): Promise<SiteHandover> {
  const ctx: AuditContext = { actor: { id: actorId }, ip: null, userAgent: null };
  return withAudit(
    {
      ctx,
      action: "handover.create",
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
        meterStates: data.meterStates ?? [],
        notes: data.notes,
        createdById: actorId,
      }
    })
  );
}

export async function updateHandover(id: string, actorId: string, data: Partial<HandoverInput>): Promise<SiteHandover> {
  const ctx: AuditContext = { actor: { id: actorId }, ip: null, userAgent: null };
  const before = await prisma.siteHandover.findUnique({ where: { id } });
  
  if (before?.signedAt) {
    throw new HandoverAlreadySignedError();
  }

  return withAudit(
    {
      ctx,
      action: "handover.update",
      entityType: "site_handover",
      resolveEntityId: (h) => h.id,
      before,
    },
    (tx) => tx.siteHandover.update({
      where: { id },
      data: {
        ...(data.type && { type: data.type }),
        ...(data.date && { date: data.date }),
        ...(data.participants && { participants: data.participants }),
        ...(data.meterStates && { meterStates: data.meterStates }),
        ...(data.notes !== undefined && { notes: data.notes }),
      }
    })
  );
}

export async function deleteHandover(id: string, actorId: string): Promise<SiteHandover> {
  const ctx: AuditContext = { actor: { id: actorId }, ip: null, userAgent: null };
  const before = await prisma.siteHandover.findUnique({ where: { id } });
  
  if (before?.signedAt) {
    throw new HandoverAlreadySignedError();
  }

  return withAudit(
    {
      ctx,
      action: "handover.delete",
      entityType: "site_handover",
      resolveEntityId: (h) => h.id,
      before,
    },
    (tx) => tx.siteHandover.update({
      where: { id },
      data: {
        deletedAt: new Date()
      }
    })
  );
}

export class HandoverAlreadySignedError extends Error {
  constructor() {
    super("Předávací protokol je již podepsán a nelze jej upravovat ani smazat.");
    this.name = "HandoverAlreadySignedError";
  }
}

export async function signHandover(id: string, actorId: string): Promise<SiteHandover> {
  const ctx: AuditContext = { actor: { id: actorId }, ip: null, userAgent: null };
  const before = await prisma.siteHandover.findUnique({ where: { id } });

  const actor = await prisma.user.findUnique({ where: { id: actorId } });
  if (actor?.role !== "BOSS") {
    throw new ForbiddenError("report.sign");
  }

  return withAudit(
    {
      ctx,
      action: "handover.sign",
      entityType: "site_handover",
      resolveEntityId: (h) => h.id,
      before,
    },
    (tx) => tx.siteHandover.update({
      where: { id },
      data: {
        signedAt: new Date(),
        signedById: actorId,
      }
    })
  );
}
export async function listHandovers(projectId: string): Promise<SiteHandover[]> {
  return prisma.siteHandover.findMany({
    where: { projectId, deletedAt: null },
    orderBy: { date: 'desc' }
  });
}
