import { beforeEach, describe, expect, it, vi } from "vitest";

import { type AuditRow, verifyAuditRows } from "./audit-hash";

/**
 * Regression test for the tamper-evident audit log write path.
 *
 * The hash chain covers a `ts` field. Earlier, `withAudit`/`appendAudit`
 * hashed `new Date().toISOString()` but never persisted that value — the
 * `ts` column was filled by `DEFAULT CURRENT_TIMESTAMP`, a *different*
 * timestamp. The verifier (which recomputes from the stored `ts`) then
 * found a `row_hash` mismatch on the very first row, so every chain was
 * reported as broken (only surfaced once the integration suite ran
 * against a real Postgres).
 *
 * This test mocks the Prisma layer, captures exactly what gets written
 * to `auditLog.create`, and feeds it back through `verifyAuditRows`. If
 * the persisted `ts` ever diverges from the hashed one again, the chain
 * fails to verify here — no Docker required.
 */
const h = vi.hoisted(() => {
  const JSON_NULL = { __isPrismaJsonNull: true } as const;
  const created: Array<Record<string, unknown>> = [];
  return { JSON_NULL, created };
});

vi.mock("@/generated/prisma/client", () => ({
  Prisma: { JsonNull: h.JSON_NULL },
}));

vi.mock("@/lib/db", () => {
  const tx = {
    // The append path locks the chain tail to source `prev_hash`.
    $queryRaw: async () =>
      h.created.length === 0
        ? []
        : [{ row_hash: h.created[h.created.length - 1].rowHash as string }],
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        h.created.push(data);
      },
    },
  };
  return {
    prisma: {
      $transaction: async (fn: (client: unknown) => Promise<unknown>) =>
        fn(tx),
    },
  };
});

// Imported AFTER the mocks above (hoisted) so the module under test binds
// to the fakes rather than the real DB / generated client.
import { appendAudit, withAudit, type AuditContext } from "./audit";

const ctx: AuditContext = {
  actor: { id: "tester" },
  ip: "127.0.0.1",
  userAgent: "vitest-unit",
};

/** Map the captured `auditLog.create` payloads to verifier rows. */
function capturedRows(): AuditRow[] {
  return h.created.map((d, i) => ({
    id: BigInt(i + 1),
    ts: d.ts as Date,
    actor_id: (d.actorId as string | null) ?? null,
    action: d.action as string,
    entity_type: d.entityType as string,
    entity_id: d.entityId as string,
    before: d.before === h.JSON_NULL ? null : d.before,
    after: d.after === h.JSON_NULL ? null : d.after,
    ip: (d.ip as string | null) ?? null,
    user_agent: (d.userAgent as string | null) ?? null,
    prev_hash: d.prevHash as string,
    row_hash: d.rowHash as string,
  }));
}

describe("audit write path persists the hashed ts", () => {
  beforeEach(() => {
    h.created.length = 0;
  });

  it("appendAudit writes a chain that verifies clean", async () => {
    for (let i = 0; i < 3; i++) {
      await appendAudit(ctx, {
        action: "session.signin",
        entityType: "session",
        entityId: `s${i}`,
        after: { index: i },
      });
    }

    expect(h.created).toHaveLength(3);
    // The exact Date used for hashing must be the one persisted.
    expect(h.created[0].ts).toBeInstanceOf(Date);

    const result = verifyAuditRows(capturedRows());
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(3);
    expect(result.brokenAtId).toBeNull();
  });

  it("withAudit writes a row that verifies clean", async () => {
    await withAudit(
      {
        ctx,
        action: "user.create",
        entityType: "user",
        resolveEntityId: (r: { id: string }) => r.id,
      },
      async () => ({ id: "u1", nickname: "bob" }),
    );

    expect(h.created).toHaveLength(1);
    expect(h.created[0].ts).toBeInstanceOf(Date);

    const result = verifyAuditRows(capturedRows());
    expect(result.ok).toBe(true);
  });
});
