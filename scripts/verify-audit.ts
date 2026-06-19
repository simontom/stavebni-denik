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
 * On a broken chain the script:
 *   * appends an entry to `${DATA_DIR}/audit-verify.log`,
 *   * inserts an `audit.chain_broken` Notification row for every
 *     active BOSS user (in-app bell — works even without SMTP, which
 *     Fly.io doesn't ship with),
 *   * tries to e-mail the BOSS only when SMTP_* / ALERT_EMAIL are
 *     configured (kept as opt-in fallback).
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient, Prisma } from "../src/generated/prisma/client";
import { formatAuditAlert } from "../src/server/audit-alert";
import { verifyAuditChainWithClient } from "../src/server/audit-verify";
import { readSmtpConfig, sendMail } from "../src/server/mailer";

/**
 * Insert a chain_broken notification for every active BOSS user.
 * Inlined here (instead of calling the service) because this script
 * runs standalone with a dedicated PrismaClient and must not depend
 * on `server-only`.
 */
async function notifyBossesOfChainBreak(
  prisma: PrismaClient,
  result: { brokenAtId: bigint | null; reason: string | null; checkedAt: string },
): Promise<number> {
  const recipients = await prisma.user.findMany({
    where: { role: "BOSS", isActive: true, deletedAt: null },
    select: { id: true },
  });
  if (recipients.length === 0) return 0;

  const payload = {
    rowId: result.brokenAtId ? result.brokenAtId.toString() : null,
    reason: result.reason,
    checkedAt: result.checkedAt,
  } satisfies Prisma.InputJsonValue;

  await prisma.notification.createMany({
    data: recipients.map((r) => ({
      recipientId: r.id,
      kind: "audit.chain_broken",
      payload,
      href: "/admin/audit",
    })),
  });
  return recipients.length;
}

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

    // In-app notification fan-out — primary alert path, works without
    // SMTP. We swallow individual notif errors so a DB hiccup on the
    // notif insert can't mask the non-zero exit code.
    try {
      const fanout = await notifyBossesOfChainBreak(prisma, result);
      console.error(
        `[verify-audit] notified ${fanout} BOSS user(s) via in-app bell.`,
      );
    } catch (notifErr) {
      console.error(
        "[verify-audit] failed to write in-app notifications:",
        notifErr,
      );
    }

    // Best-effort e-mail alert to the BOSS — secondary fallback for
    // crews that DO have SMTP available. Mail failure never masks
    // the non-zero exit code or in-app notif fan-out above.
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
        "[verify-audit] SMTP not configured — relying on in-app bell only.",
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
