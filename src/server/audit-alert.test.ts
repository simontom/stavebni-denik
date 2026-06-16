import { describe, expect, it } from "vitest";

import { formatAuditAlert, shouldAlert } from "./audit-alert";
import type { VerifyResult } from "./audit-hash";

const broken: VerifyResult = {
  ok: false,
  totalRows: 42,
  brokenAtId: BigInt(7),
  reason: "row_hash mismatch on id=7: expected ..., stored ...",
  checkedAt: "2026-06-16T08:00:00.000Z",
};

const intact: VerifyResult = {
  ok: true,
  totalRows: 42,
  brokenAtId: null,
  reason: null,
  checkedAt: "2026-06-16T08:00:00.000Z",
};

describe("shouldAlert", () => {
  it("alerts only when the chain is broken", () => {
    expect(shouldAlert(broken)).toBe(true);
    expect(shouldAlert(intact)).toBe(false);
  });
});

describe("formatAuditAlert", () => {
  it("includes the app name, broken row id, count and reason", () => {
    const { subject, text } = formatAuditAlert(broken, {
      appName: "Stavební deník",
    });
    expect(subject).toContain("Stavební deník");
    expect(text).toContain("7");
    expect(text).toContain("42");
    expect(text).toContain("row_hash mismatch");
  });
});
