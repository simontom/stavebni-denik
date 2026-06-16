import type { VerifyResult } from "./audit-hash";

/**
 * Pure helpers that decide whether the audit-verify cron should raise an
 * alert and format the notification e-mail. Kept free of I/O so they can
 * be unit-tested; the actual SMTP send lives in `mailer.ts`.
 */

/** An alert is warranted only when the hash chain is broken. */
export function shouldAlert(result: VerifyResult): boolean {
  return !result.ok;
}

export interface AuditAlertMessage {
  subject: string;
  text: string;
}

/**
 * Build the Czech-language alert e-mail for a failed integrity check.
 */
export function formatAuditAlert(
  result: VerifyResult,
  opts: { appName: string },
): AuditAlertMessage {
  const subject = `[${opts.appName}] Audit log: porušená integrita`;
  const text = [
    "Automatická kontrola integrity audit logu SELHALA.",
    "",
    `Aplikace:               ${opts.appName}`,
    `Čas kontroly:           ${result.checkedAt}`,
    `Zkontrolováno řádků:    ${result.totalRows}`,
    `První porušený řádek:   ${result.brokenAtId?.toString() ?? "neznámý"}`,
    `Důvod:                  ${result.reason ?? "neuvedeno"}`,
    "",
    "Hash chain audit logu byl pravděpodobně pozměněn nebo poškozen.",
    "Záznamy v audit logu jsou append-only a nikdy se nesmí měnit ani",
    "mazat. Okamžitě prověřte databázi a porovnejte ji se zálohami.",
  ].join("\n");

  return { subject, text };
}
