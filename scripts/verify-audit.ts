/**
 * `pnpm verify:audit` — walks the audit_log hash chain and reports any
 * tampering. Designed to run from cron (daily) or on demand by BOSS
 * from /admin/audit.
 *
 * Exit codes:
 *   0  chain is intact
 *   1  chain is broken (id of the offending row in the log)
 *   2  unexpected error (DB not reachable, etc.)
 *
 * Result is also appended to `${DATA_DIR}/audit-verify.log` for the
 * historical record visible in the admin UI.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";
import { verifyAuditChain } from "../src/server/audit";

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL must be set.");
    return 2;
  }
  // Construct a dedicated client so the script can run standalone
  // without booting Next.js / its server modules.
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });
  // The verify routine in `audit.ts` uses the singleton from `lib/db.ts`.
  // We can't easily inject this fresh client there, so we just rely on
  // the singleton — it will pick up DATABASE_URL the same way.
  await prisma.$disconnect();

  const result = await verifyAuditChain();

  const dataDir = process.env.DATA_DIR ?? "./.dev-data";
  await fs.mkdir(dataDir, { recursive: true });
  const logPath = path.join(dataDir, "audit-verify.log");
  const line =
    JSON.stringify({
      checkedAt: result.checkedAt,
      ok: result.ok,
      totalRows: result.totalRows,
      brokenAtId: result.brokenAtId ? result.brokenAtId.toString() : null,
      reason: result.reason,
    }) + "\n";
  await fs.appendFile(logPath, line, "utf8");

  if (result.ok) {
    console.log(
      `[verify-audit] OK — ${result.totalRows} rows checked at ${result.checkedAt}`,
    );
    return 0;
  }
  console.error(
    `[verify-audit] BROKEN — first issue at id ${result.brokenAtId}: ${result.reason}`,
  );
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[verify-audit] failed:", err);
    process.exit(2);
  });
