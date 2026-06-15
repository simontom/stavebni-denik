import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

const GENESIS_HASH = "0".repeat(64);

/**
 * Canonical JSON serializer for hash-chain payloads.
 *
 * Requirements:
 *  - Object keys are sorted alphabetically at every nesting level.
 *  - Arrays preserve their order (they are part of the payload).
 *  - `Date` values are converted to ISO-8601 strings.
 *  - `BigInt` values are converted to decimal strings.
 *  - `undefined` properties are dropped (same as JSON.stringify), so
 *    callers must not rely on their presence to alter the hash.
 *
 * Two equivalent payloads MUST produce byte-identical serializations.
 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
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

export type AuditAction =
  | "user.create"
  | "user.update"
  | "user.deactivate"
  | "user.activate"
  | "user.password-change"
  | "session.signin"
  | "session.signout"
  // Forward-looking actions used in Stages 4-6. Kept here so the
  // string union stays exhaustive and easy to extend.
  | "project.create"
  | "project.update"
  | "project.delete"
  | "project.member.add"
  | "project.member.remove"
  | "report.create"
  | "report.update"
  | "report.sign"
  | "report.addendum.create"
  | "photo.upload"
  | "photo.delete"
  | "remark.create"
  | "material.create"
  | "material.resolve";

/**
 * Stripped-down audit row used both for hashing and for surfacing in
 * the admin UI. Values are normalised through `canonicalJSON` before
 * being hashed.
 */
interface AuditPayload {
  action: AuditAction;
  entityType: string;
  entityId: string;
  actorId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  userAgent: string | null;
  prevHash: string;
  ts: string; // ISO timestamp captured at hash time
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
      ts: new Date().toISOString(),
    };
    const rowHash = sha256Hex(canonicalJSON(payload));

    await tx.auditLog.create({
      data: {
        actorId: payload.actorId,
        action: payload.action,
        entityType: payload.entityType,
        entityId: payload.entityId,
        before: payload.before as Prisma.InputJsonValue | null,
        after: payload.after as Prisma.InputJsonValue | null,
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
      ts: new Date().toISOString(),
    };
    const rowHash = sha256Hex(canonicalJSON(fullPayload));

    await tx.auditLog.create({
      data: {
        actorId: fullPayload.actorId,
        action: fullPayload.action,
        entityType: fullPayload.entityType,
        entityId: fullPayload.entityId,
        before: fullPayload.before as Prisma.InputJsonValue | null,
        after: fullPayload.after as Prisma.InputJsonValue | null,
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

export interface VerifyResult {
  ok: boolean;
  totalRows: number;
  /** Id of the first row that broke the chain (null when ok=true). */
  brokenAtId: bigint | null;
  reason: string | null;
  checkedAt: string;
}

/**
 * Streams through `audit_log` in id order and recomputes the chain.
 * Cheap to run from a cron job; ~10 µs per row of pure crypto +
 * Postgres seq-scan on a clustered index.
 */
export async function verifyAuditChain(
  batchSize = 500,
): Promise<VerifyResult> {
  let totalRows = 0;
  let lastHash = GENESIS_HASH;
  let cursor: bigint | null = null;

  while (true) {
    const rows: Array<{
      id: bigint;
      ts: Date;
      actor_id: string | null;
      action: string;
      entity_type: string;
      entity_id: string;
      before: unknown;
      after: unknown;
      ip: string | null;
      user_agent: string | null;
      prev_hash: string;
      row_hash: string;
    }> = cursor === null
      ? await prisma.$queryRaw`
          SELECT id, ts, actor_id, action, entity_type, entity_id,
                 before, after, ip, user_agent, prev_hash, row_hash
          FROM audit_log ORDER BY id ASC LIMIT ${batchSize}
        `
      : await prisma.$queryRaw`
          SELECT id, ts, actor_id, action, entity_type, entity_id,
                 before, after, ip, user_agent, prev_hash, row_hash
          FROM audit_log WHERE id > ${cursor}
          ORDER BY id ASC LIMIT ${batchSize}
        `;

    if (rows.length === 0) break;

    for (const r of rows) {
      totalRows++;

      if (!hashesEqual(r.prev_hash, lastHash)) {
        return {
          ok: false,
          totalRows,
          brokenAtId: r.id,
          reason: `prev_hash mismatch on id=${r.id}: expected ${lastHash}, got ${r.prev_hash}`,
          checkedAt: new Date().toISOString(),
        };
      }

      const recomputed = sha256Hex(
        canonicalJSON({
          action: r.action,
          entityType: r.entity_type,
          entityId: r.entity_id,
          actorId: r.actor_id,
          before: r.before ?? null,
          after: r.after ?? null,
          ip: r.ip,
          userAgent: r.user_agent,
          prevHash: r.prev_hash,
          ts: r.ts.toISOString(),
        } satisfies AuditPayload),
      );

      if (!hashesEqual(recomputed, r.row_hash)) {
        return {
          ok: false,
          totalRows,
          brokenAtId: r.id,
          reason: `row_hash mismatch on id=${r.id}: expected ${recomputed}, stored ${r.row_hash}`,
          checkedAt: new Date().toISOString(),
        };
      }

      lastHash = r.row_hash;
      cursor = r.id;
    }
  }

  return {
    ok: true,
    totalRows,
    brokenAtId: null,
    reason: null,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Constant-time string comparison so timing leaks from the verification
 * cron never reveal partial hash collisions to anyone watching latency.
 */
function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
