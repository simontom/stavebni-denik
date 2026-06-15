import "server-only";

import { prisma } from "@/lib/db";

export interface AuditListFilters {
  action?: string;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: bigint | null;
}

export interface AuditRow {
  id: string;
  ts: Date;
  actorId: string | null;
  actorNickname: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  ip: string | null;
  userAgent: string | null;
  prevHash: string;
  rowHash: string;
}

/**
 * Page through `audit_log` newest-first with optional filters. Returns
 * up to `limit` rows and the next cursor. Used by the admin UI.
 */
export async function listAuditEntries(
  filters: AuditListFilters,
): Promise<{ rows: AuditRow[]; nextCursor: string | null }> {
  const limit = Math.min(filters.limit ?? 50, 200);

  // Build WHERE clauses safely via Prisma's findMany filters.
  const where = {
    ...(filters.action && { action: filters.action }),
    ...(filters.entityType && { entityType: filters.entityType }),
    ...(filters.entityId && { entityId: filters.entityId }),
    ...(filters.actorId && { actorId: filters.actorId }),
    ...((filters.from || filters.to) && {
      ts: {
        ...(filters.from && { gte: filters.from }),
        ...(filters.to && { lte: filters.to }),
      },
    }),
    ...(filters.cursor !== undefined &&
      filters.cursor !== null && { id: { lt: filters.cursor } }),
  };

  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: { id: "desc" },
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;

  // Bulk-load actor display names for the rendered subset.
  const actorIds = Array.from(
    new Set(trimmed.map((r) => r.actorId).filter((v): v is string => !!v)),
  );
  const actors = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, nickname: true },
      })
    : [];
  const nicknameById = new Map(actors.map((a) => [a.id, a.nickname]));

  return {
    rows: trimmed.map((r) => ({
      id: r.id.toString(),
      ts: r.ts,
      actorId: r.actorId,
      actorNickname: r.actorId ? nicknameById.get(r.actorId) ?? null : null,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      before: r.before,
      after: r.after,
      ip: r.ip,
      userAgent: r.userAgent,
      prevHash: r.prevHash,
      rowHash: r.rowHash,
    })),
    nextCursor: hasMore
      ? trimmed[trimmed.length - 1]!.id.toString()
      : null,
  };
}

/** Distinct actions present in the log — populates the filter dropdown. */
export async function listAuditActions(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ action: string }>>`
    SELECT DISTINCT action FROM audit_log ORDER BY action ASC
  `;
  return rows.map((r) => r.action);
}
