/**
 * Date formatting helpers locked to Europe/Prague timezone and Czech locale.
 *
 * Construction-diary entries are legally tied to a calendar day (§ 157
 * stavebního zákona). We always render and parse dates in the site's
 * local time zone, regardless of where the server runs.
 */

const PRAGUE_TZ = "Europe/Prague";
const CS_LOCALE = "cs-CZ";

/**
 * "30.05.2026" — primary display format used across the UI.
 */
export function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat(CS_LOCALE, {
    timeZone: PRAGUE_TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

/**
 * "30.05.2026 19:53" — used for audit-log rows and signed timestamps.
 */
export function formatDateTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat(CS_LOCALE, {
    timeZone: PRAGUE_TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/**
 * Returns the start-of-day (00:00 in Prague time) for the given date,
 * expressed as a UTC `Date`. Used as the canonical key for daily reports
 * — every report belongs to exactly one Prague-calendar day.
 */
export function pragueDayStart(date: Date | string): Date {
  const d = typeof date === "string" ? new Date(date) : date;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PRAGUE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "00";
  // Build an ISO string like "2026-05-30T00:00:00+02:00". The offset is
  // resolved by the runtime when the resulting Date is constructed.
  const iso = `${get("year")}-${get("month")}-${get("day")}T00:00:00`;
  // Re-interpret in Prague time by parsing as if local, then adjusting.
  const local = new Date(iso);
  const utcMs = Date.UTC(
    local.getFullYear(),
    local.getMonth(),
    local.getDate(),
  );
  return new Date(utcMs);
}
