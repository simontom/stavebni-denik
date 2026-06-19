import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Pure, dependency-free core of the tamper-evident audit log.
 *
 * This module intentionally imports nothing from the database, Next.js,
 * or `server-only` so it can be unit-tested under plain Node and reused
 * from standalone scripts (the verify cron) without booting the app.
 *
 * The DB-bound wrappers live in `audit.ts` (`withAudit`/`appendAudit`)
 * and `audit-verify.ts` (`verifyAuditChainWithClient`).
 */

export const GENESIS_HASH = "0".repeat(64);

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
  | "material.resolve"
  | "material.rollover";

/**
 * Stripped-down audit row used both for hashing and for surfacing in
 * the admin UI. Values are normalised through `canonicalJSON` before
 * being hashed.
 */
export interface AuditPayload {
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

/**
 * Shape of a persisted `audit_log` row as returned by raw SQL
 * (snake_case column names). Used by the chain verifier.
 */
export interface AuditRow {
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
}

export interface VerifyResult {
  ok: boolean;
  totalRows: number;
  /** Id of the first row that broke the chain (null when ok=true). */
  brokenAtId: bigint | null;
  reason: string | null;
  checkedAt: string;
}

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

/** Hash a canonical audit payload into the row's `row_hash`. */
export function computeRowHash(payload: AuditPayload): string {
  return sha256Hex(canonicalJSON(payload));
}

/**
 * Rebuild the canonical payload from a persisted row and hash it. The
 * result must equal the stored `row_hash` for an untampered row.
 */
export function recomputeRowHash(r: AuditRow): string {
  return computeRowHash({
    action: r.action as AuditAction,
    entityType: r.entity_type,
    entityId: r.entity_id,
    actorId: r.actor_id,
    before: r.before ?? null,
    after: r.after ?? null,
    ip: r.ip,
    userAgent: r.user_agent,
    prevHash: r.prev_hash,
    ts: r.ts.toISOString(),
  });
}

/**
 * Constant-time string comparison so timing leaks from the verification
 * cron never reveal partial hash collisions to anyone watching latency.
 */
export function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/**
 * Verify a single row against the expected `prevHash` (the previous
 * row's `row_hash`, or `GENESIS_HASH` for the first row). Returns a
 * human-readable failure reason, or `null` when the row is intact.
 *
 * Shared by both the in-memory verifier (`verifyAuditRows`) and the
 * streaming DB verifier so there is a single source of truth.
 */
export function checkChainRow(
  expectedPrevHash: string,
  r: AuditRow,
): string | null {
  if (!hashesEqual(r.prev_hash, expectedPrevHash)) {
    return `prev_hash mismatch on id=${r.id}: expected ${expectedPrevHash}, got ${r.prev_hash}`;
  }
  const recomputed = recomputeRowHash(r);
  if (!hashesEqual(recomputed, r.row_hash)) {
    return `row_hash mismatch on id=${r.id}: expected ${recomputed}, stored ${r.row_hash}`;
  }
  return null;
}

/**
 * Pure verification over an in-memory, id-ascending array of rows.
 * Returns the first broken row's id (if any). Used directly by unit
 * tests; the production path streams from Postgres in batches via
 * `verifyAuditChainWithClient` but applies the identical per-row check.
 */
export function verifyAuditRows(rows: readonly AuditRow[]): VerifyResult {
  let lastHash = GENESIS_HASH;
  let totalRows = 0;

  for (const r of rows) {
    totalRows++;
    const reason = checkChainRow(lastHash, r);
    if (reason) {
      return {
        ok: false,
        totalRows,
        brokenAtId: r.id,
        reason,
        checkedAt: new Date().toISOString(),
      };
    }
    lastHash = r.row_hash;
  }

  return {
    ok: true,
    totalRows,
    brokenAtId: null,
    reason: null,
    checkedAt: new Date().toISOString(),
  };
}
