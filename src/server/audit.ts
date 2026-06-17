import "server-only";

import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import {
  GENESIS_HASH,
  computeRowHash,
  type AuditAction,
  type AuditPayload,
  type VerifyResult,
} from "@/server/audit-hash";
import { verifyAuditChainWithClient } from "@/server/audit-verify";

// Re-export the pure hashing/verification surface so existing imports
// from `@/server/audit` keep working after the crypto core was extracted
// into `audit-hash.ts` (dependency-free and unit-testable).
export { canonicalJSON, sha256Hex } from "@/server/audit-hash";
export type { AuditAction, VerifyResult } from "@/server/audit-hash";

/**
 * Normalise a nullable JSON value for Prisma. Prisma 7 distinguishes SQL
 * NULL (`Prisma.JsonNull`) from a literal JSON value for nullable JSON
 * columns, so we map null/undefined explicitly rather than passing `null`.
 */
function toJsonInput(
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null || value === undefined
    ? Prisma.JsonNull
    : (value as Prisma.InputJsonValue);
}

/**
 * Context carried into `withAudit()` — captured at request entry by
 * `getAuditContext()` (server-action / route-handler glue).
 */
export interface AuditContext {
  actor: { id: string } | null;
  ip: string | null;
  userAgent: string | null;
}

interface WithAuditOptions<T> {
  ctx: AuditContext;
  action: AuditAction;
  entityType: string;
  /** Resolve the entity id from the operation result. */
  resolveEntityId: (result: T) => string;
  /** Snapshot of the entity BEFORE the mutation (null for inserts). */
  before?: unknown;
  /**
   * Optional projection of the result to limit what is written to the
   * audit table. Defaults to the raw result. Use it to strip secrets
   * like `passwordHash` — they must never appear in audit JSON.
   */
  projectAfter?: (result: T) => unknown;
}

/**
 * Wraps a Prisma mutation in an audit-logged transaction.
 *
 * Guarantees:
 *  - The mutation and the audit-log insert succeed/fail atomically.
 *  - `prev_hash` is sourced via `SELECT ... ORDER BY id DESC LIMIT 1`
 *    inside the same transaction, with `FOR UPDATE` on the last row —
 *    this serializes concurrent appends and prevents two writers from
 *    forking the chain.
 *  - `row_hash` covers a canonical JSON of the action payload + prev.
 */
export async function withAudit<T>(
  options: WithAuditOptions<T>,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const result = await fn(tx);

    // Lock the chain tail so concurrent transactions queue instead of
    // forking. Postgres `FOR UPDATE` on the most recent row is enough
    // — the next insert will wait for our commit.
    const tail = await tx.$queryRaw<Array<{ row_hash: string }>>`
      SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1 FOR UPDATE
    `;
    const prevHash = tail[0]?.row_hash ?? GENESIS_HASH;

    const after = options.projectAfter
      ? options.projectAfter(result)
      : result;

    // Hash the SAME timestamp we persist. `ts` is part of the hashed
    // payload, so the value written to the `ts` column must be byte-for-byte
    // the one fed into the hash — otherwise the verifier (which recomputes
    // from the stored `ts`) would never match. We therefore generate it here
    // instead of relying on the column's `DEFAULT CURRENT_TIMESTAMP`.
    const ts = new Date();
    const payload: AuditPayload = {
      action: options.action,
      entityType: options.entityType,
      entityId: options.resolveEntityId(result),
      actorId: options.ctx.actor?.id ?? null,
      before: options.before ?? null,
      after,
      ip: options.ctx.ip,
      userAgent: options.ctx.userAgent,
      prevHash,
      ts: ts.toISOString(),
    };
    const rowHash = computeRowHash(payload);

    await tx.auditLog.create({
      data: {
        ts,
        actorId: payload.actorId,
        action: payload.action,
        entityType: payload.entityType,
        entityId: payload.entityId,
        before: toJsonInput(payload.before),
        after: toJsonInput(payload.after),
        ip: payload.ip,
        userAgent: payload.userAgent,
        prevHash,
        rowHash,
      },
    });

    return result;
  });
}

/**
 * Standalone audit append — used for "event-only" actions (sign-in,
 * sign-out, etc.) where there is no domain mutation to wrap. Uses the
 * same chain-locking strategy as `withAudit`.
 */
export async function appendAudit<E>(
  ctx: AuditContext,
  payload: {
    action: AuditAction;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: E;
  },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const tail = await tx.$queryRaw<Array<{ row_hash: string }>>`
      SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1 FOR UPDATE
    `;
    const prevHash = tail[0]?.row_hash ?? GENESIS_HASH;

    // See `withAudit`: the persisted `ts` must equal the hashed `ts`.
    const ts = new Date();
    const fullPayload: AuditPayload = {
      action: payload.action,
      entityType: payload.entityType,
      entityId: payload.entityId,
      actorId: ctx.actor?.id ?? null,
      before: payload.before ?? null,
      after: payload.after ?? null,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      prevHash,
      ts: ts.toISOString(),
    };
    const rowHash = computeRowHash(fullPayload);

    await tx.auditLog.create({
      data: {
        ts,
        actorId: fullPayload.actorId,
        action: fullPayload.action,
        entityType: fullPayload.entityType,
        entityId: fullPayload.entityId,
        before: toJsonInput(fullPayload.before),
        after: toJsonInput(fullPayload.after),
        ip: fullPayload.ip,
        userAgent: fullPayload.userAgent,
        prevHash,
        rowHash,
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Walk the entire `audit_log` hash chain using the app's Prisma
 * singleton. Thin wrapper around `verifyAuditChainWithClient` (which
 * holds the shared, dependency-free verification logic). Cheap enough
 * to run synchronously from the admin UI or a daily cron.
 */
export async function verifyAuditChain(batchSize = 500): Promise<VerifyResult> {
  return verifyAuditChainWithClient(prisma, batchSize);
}

/**
 * Return the `rowHash` of the most recent audit-log row, or the
 * GENESIS hash if the log is still empty. The PDF export embeds this
 * hash in its per-page footer so the document is anchored back to a
 * specific position of the tamper-evident chain.
 */
export async function getLatestAuditHash(): Promise<string> {
  const tail = await prisma.auditLog.findFirst({
    orderBy: { id: "desc" },
    select: { rowHash: true },
  });
  return tail?.rowHash ?? GENESIS_HASH;
}
