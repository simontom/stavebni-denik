import { describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";
import { GENESIS_HASH, type AuditRow, recomputeRowHash } from "./audit-hash";
import { verifyAuditChainWithClient } from "./audit-verify";

function makeRow(id: number, prevHash: string, overrides: Partial<AuditRow> = {}): AuditRow {
  const row: AuditRow = {
    id: BigInt(id),
    ts: new Date("2026-01-01T10:00:00.000Z"),
    actor_id: "user_1",
    action: "user.create",
    entity_type: "user",
    entity_id: `u${id}`,
    before: null,
    after: { nickname: `bob${id}` },
    ip: "127.0.0.1",
    user_agent: "vitest",
    prev_hash: prevHash,
    row_hash: "",
    ...overrides,
  };
  row.row_hash = recomputeRowHash(row);
  return row;
}

describe("verifyAuditChainWithClient", () => {
  it("verifies an intact chain without logging error", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const rows = [makeRow(1, GENESIS_HASH)];

    const db = {
      $queryRaw: vi.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([]),
    };

    const result = await verifyAuditChainWithClient(db);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(1);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("logs error when a broken row is detected", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const row = makeRow(1, GENESIS_HASH);
    // Corrupt row_hash
    row.row_hash = "deadbeef";

    const db = {
      $queryRaw: vi.fn().mockResolvedValueOnce([row]),
    };

    const result = await verifyAuditChainWithClient(db);
    expect(result.ok).toBe(false);
    expect(result.brokenAtId).toBe(BigInt(1));
    expect(result.reason).toContain("row_hash mismatch");

    expect(errorSpy).toHaveBeenCalledWith("audit.chain_broken", {
      brokenAtId: BigInt(1),
      reason: result.reason,
    });
    errorSpy.mockRestore();
  });
});
