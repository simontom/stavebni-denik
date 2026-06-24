/**
 * Pure, dependency-free CSV helpers (RFC 4180).
 *
 * Lives in `src/lib/` not `src/server/services/` so it can be imported
 * without dragging `@/lib/db` (and its env validation) — unit tests
 * can exercise escaping without bootstrapping the database.
 */

/**
 * RFC 4180 field escape. Wraps in "..." iff contains comma, quote,
 * CR, or LF. Doubles inner quotes.
 *
 * Additionally guards against CSV/formula injection (OWASP "CSV
 * Injection"): a cell whose first character is `=`, `+`, `-`, `@`, a tab
 * or a CR is interpreted as a formula by Excel/Google Sheets. Since the
 * export contains user-controlled free text (work descriptions, visitor
 * names, purposes, notes…), we prefix such cells with a single quote so
 * the spreadsheet renders them as literal text instead of executing them.
 */
export function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Join values into a CSV row (RFC 4180 CRLF). */
export function csvRow(values: unknown[]): string {
  return values.map(csvField).join(",") + "\r\n";
}

/** UTF-8 BOM prefix so Excel auto-detects encoding. */
export const CSV_BOM = "\uFEFF";
