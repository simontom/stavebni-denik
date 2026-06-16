import { describe, expect, it } from "vitest";

import {
  GENESIS_HASH,
  type AuditRow,
  canonicalJSON,
  computeRowHash,
  hashesEqual,
  recomputeRowHash,
  sha256Hex,
  verifyAuditRows,
} from "./audit-hash";

/**
 * Build a valid audit row whose `row_hash` is computed exactly the way
 * the verifier recomputes it, so an untampered chain verifies clean.
 */
function makeRow(
  id: number,
  prevHash: string,
  overrides: Partial<AuditRow> = {},
): AuditRow {
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

function buildChain(length: number): AuditRow[] {
  const rows: AuditRow[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= length; i++) {
    const row = makeRow(i, prev);
    rows.push(row);
    prev = row.row_hash;
  }
  return rows;
}

describe("canonicalJSON", () => {
  it("sorts object keys at every nesting level", () => {
    expect(canonicalJSON({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJSON({ x: { d: 1, c: 2 } })).toBe('{"x":{"c":2,"d":1}}');
  });

  it("is independent of insertion order", () => {
    expect(canonicalJSON({ b: 1, a: 2 })).toBe(canonicalJSON({ a: 2, b: 1 }));
  });

  it("preserves array order", () => {
    expect(canonicalJSON({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  it("serializes Date as ISO-8601 and bigint as a decimal string", () => {
    expect(canonicalJSON({ d: new Date("2026-01-01T00:00:00.000Z") })).toBe(
      '{"d":"2026-01-01T00:00:00.000Z"}',
    );
    expect(canonicalJSON({ n: BigInt(10) })).toBe('{"n":"10"}');
  });

  it("drops undefined properties and maps null", () => {
    expect(canonicalJSON({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJSON(null)).toBe("null");
  });
});

describe("sha256Hex", () => {
  it("matches known SHA-256 vectors", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("computeRowHash", () => {
  it("is deterministic and order-independent for the payload", () => {
    const a = computeRowHash({
      action: "user.create",
      entityType: "user",
      entityId: "u1",
      actorId: null,
      before: null,
      after: { nickname: "bob", role: "WORKER" },
      ip: null,
      userAgent: null,
      prevHash: GENESIS_HASH,
      ts: "2026-01-01T00:00:00.000Z",
    });
    const b = computeRowHash({
      ts: "2026-01-01T00:00:00.000Z",
      prevHash: GENESIS_HASH,
      userAgent: null,
      ip: null,
      after: { role: "WORKER", nickname: "bob" },
      before: null,
      actorId: null,
      entityId: "u1",
      entityType: "user",
      action: "user.create",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("hashesEqual", () => {
  it("compares equal-length hex strings", () => {
    expect(hashesEqual(GENESIS_HASH, GENESIS_HASH)).toBe(true);
    expect(hashesEqual(sha256Hex("a"), sha256Hex("a"))).toBe(true);
    expect(hashesEqual(sha256Hex("a"), sha256Hex("b"))).toBe(false);
  });

  it("returns false for differing lengths", () => {
    expect(hashesEqual("abcd", "abcdef")).toBe(false);
  });
});

describe("verifyAuditRows", () => {
  it("accepts an intact chain", () => {
    const result = verifyAuditRows(buildChain(3));
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(3);
    expect(result.brokenAtId).toBeNull();
  });

  it("treats an empty log as valid", () => {
    const result = verifyAuditRows([]);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(0);
  });

  it("detects a tampered payload (row_hash mismatch)", () => {
    const chain = buildChain(3);
    // Mutate the stored content of row 2 without recomputing its hash —
    // exactly what a DB admin editing a row would leave behind.
    chain[1] = { ...chain[1], after: { nickname: "EVIL" } };

    const result = verifyAuditRows(chain);
    expect(result.ok).toBe(false);
    expect(result.brokenAtId).toBe(BigInt(2));
    expect(result.reason).toContain("row_hash mismatch");
  });

  it("detects a broken link (prev_hash mismatch)", () => {
    const chain = buildChain(3);
    // Keep row 2's row_hash intact but point its prev_hash elsewhere.
    chain[1] = { ...chain[1], prev_hash: GENESIS_HASH };

    const result = verifyAuditRows(chain);
    expect(result.ok).toBe(false);
    expect(result.brokenAtId).toBe(BigInt(2));
    expect(result.reason).toContain("prev_hash mismatch");
  });

  it("flags the first row when its prev_hash is not the genesis", () => {
    const row = makeRow(1, sha256Hex("not-genesis"));
    const result = verifyAuditRows([row]);
    expect(result.ok).toBe(false);
    expect(result.brokenAtId).toBe(BigInt(1));
  });
});
