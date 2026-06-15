"use server";

import { promises as fs } from "node:fs";
import path from "node:path";

import { revalidatePath } from "next/cache";

import { env } from "@/lib/env";
import { verifyAuditChain, type VerifyResult } from "@/server/audit";
import { assertCan, requireUser } from "@/server/rbac";

export type VerifyResultJson = Omit<VerifyResult, "brokenAtId"> & {
  brokenAtId: string | null;
};

/**
 * BOSS-triggered audit verification. Walks the entire chain, persists
 * the result to `${DATA_DIR}/audit-verify.log`, and returns it for the
 * UI to render. Cheap enough to run synchronously while the BOSS waits.
 */
export async function verifyAuditAction(): Promise<VerifyResultJson> {
  const user = await requireUser();
  assertCan(user, "audit.verify");

  const result = await verifyAuditChain();

  await fs.mkdir(env.dataDir, { recursive: true });
  const logPath = path.join(env.dataDir, "audit-verify.log");
  const line =
    JSON.stringify({
      checkedAt: result.checkedAt,
      ok: result.ok,
      totalRows: result.totalRows,
      brokenAtId: result.brokenAtId ? result.brokenAtId.toString() : null,
      reason: result.reason,
      triggeredBy: user.nickname,
    }) + "\n";
  await fs.appendFile(logPath, line, "utf8");

  revalidatePath("/admin/audit");
  return {
    ...result,
    brokenAtId: result.brokenAtId ? result.brokenAtId.toString() : null,
  };
}
