/**
 * `pnpm verify:audit` — walks the audit_log hash chain and reports any
 * tampering. Designed to run from cron (daily — see the GitHub Actions
 * workflow `.github/workflows/audit-verify.yml` or a Fly machine
 * schedule) or on demand by BOSS from /admin/audit.
 *
 * Exit codes:
 *   0  chain is intact
 *   1  chain is broken (id of the offending row is logged)
 *   2  unexpected error (DB not reachable, etc.)
 *
 * On a broken chain it also tries to e-mail the BOSS (when SMTP_* /
 * ALERT_EMAIL are configured) and appends the outcome to
 * `${DATA_DIR}/audit-verify.log` for the record shown in the admin UI.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";
import { formatAuditAlert } from "../src/server/audit-alert";
import { verifyAuditChainWithClient } from "../src/server/audit-verify";
import { readSmtpConfig, sendMail } from "../src/server/mailer";

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL must be set.");
    return 2;
  }

  // Dedicated client so the script runs standalone without booting
  // Next.js or importing any `server-only` module.
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    const result = await verifyAuditChainWithClient(prisma);

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

    // Best-effort e-mail alert to the BOSS — never let a mail failure
    // mask the non-zero exit code that signals a broken chain.
    const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "Stavební deník";
    const smtp = readSmtpConfig();
    if (smtp) {
      try {
        await sendMail(smtp, formatAuditAlert(result, { appName }));
        console.error(`[verify-audit] alert e-mail sent to ${smtp.to}`);
      } catch (mailErr) {
        console.error("[verify-audit] failed to send alert e-mail:", mailErr);
      }
    } else {
      console.error(
        "[verify-audit] SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS/" +
          "SMTP_FROM/ALERT_EMAIL) — skipping e-mail alert.",
      );
    }
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[verify-audit] failed:", err);
    process.exit(2);
  });
