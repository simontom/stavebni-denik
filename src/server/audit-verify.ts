import {
  GENESIS_HASH,
  checkChainRow,
  type AuditRow,
  type VerifyResult,
} from "./audit-hash";

// Type-only import — erased at runtime, so this module stays free of
// `server-only` / Next.js side effects and can be used from the verify
// cron script (run via `tsx`) as well as from server actions.
import type { PrismaClient } from "../generated/prisma/client";

/** Minimal slice of PrismaClient that the verifier needs. */
type RawQueryClient = Pick<PrismaClient, "$queryRaw">;

/**
 * Streams through `audit_log` in id order (in batches) and recomputes
 * the hash chain, applying the same per-row check as the pure
 * `verifyAuditRows`. Returns the id of the first broken row, if any.
 *
 * Accepts the Prisma client as a parameter so it can run against the
 * app singleton (server actions), a standalone client (cron script), or
 * a Testcontainers-backed client (integration tests).
 *
 * Cheap to run: ~10 µs per row of crypto plus a clustered-index scan.
 */
export async function verifyAuditChainWithClient(
  db: RawQueryClient,
  batchSize = 500,
): Promise<VerifyResult> {
  let totalRows = 0;
  let lastHash = GENESIS_HASH;
  let cursor: bigint | null = null;

  for (;;) {
    const rows: AuditRow[] =
      cursor === null
        ? await db.$queryRaw<AuditRow[]>`
            SELECT id, ts, actor_id, action, entity_type, entity_id,
                   before, after, ip, user_agent, prev_hash, row_hash
            FROM audit_log ORDER BY id ASC LIMIT ${batchSize}
          `
        : await db.$queryRaw<AuditRow[]>`
            SELECT id, ts, actor_id, action, entity_type, entity_id,
                   before, after, ip, user_agent, prev_hash, row_hash
            FROM audit_log WHERE id > ${cursor}
            ORDER BY id ASC LIMIT ${batchSize}
          `;

    if (rows.length === 0) break;

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
