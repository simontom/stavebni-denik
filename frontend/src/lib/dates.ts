/**
 * Calendar-date helpers for the site diary. The diary is kept in Czech time and the day an entry belongs to is a
 * plain `YYYY-MM-DD` string; none of this goes through the browser's own time zone.
 */

const PRAGUE = "Europe/Prague";

/** Today's date in Prague as `YYYY-MM-DD` (between 00:00 and 02:00 local time UTC is still on the previous day). */
export const pragueToday = (): string => new Intl.DateTimeFormat("sv-SE", { timeZone: PRAGUE }).format(new Date());

/** The last Monday-to-Friday day before [day] (Friday for a Saturday, Sunday or Monday). Public holidays are not considered. */
export function previousWorkingDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Mirrors the server (decision D10): an entry is on time for today and for any day since the previous working day;
 * an earlier day is a late entry and needs a reason. The server decides; this only decides what the form shows.
 */
export const isLateEntryDate = (day: string, today: string = pragueToday()): boolean => ISO_DATE.test(day) && day < previousWorkingDay(today);

/** An entry cannot be made for a day that has not come yet. */
export const isFutureDate = (day: string, today: string = pragueToday()): boolean => ISO_DATE.test(day) && day > today;

// The names are written out here, never taken from the browser's locale: what a person reads in the diary must not depend on the
// language of the phone or on the ICU data it ships with (the PDF does the same, `CzechFormat.kt`). Indexed by `getUTCDay()`.
const WEEKDAYS_SHORT = ["ne", "po", "út", "st", "čt", "pá", "so"];
const WEEKDAYS_LONG = ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"];

/** The parts of a real calendar day written `YYYY-MM-DD`, or null for anything else (also for 2026-02-30). */
function partsOf(day: string): { year: number; month: number; day: number } | null {
  if (!ISO_DATE.test(day)) return null;
  const [year, month, date] = day.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, date));
  // `Date.UTC` reads the years 0 to 99 as 1900 to 1999 and rolls a day that does not exist over into the next month.
  if (year < 100 || check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null;
  return { year, month, day: date };
}

/** `28. 9. 2026` from `2026-09-28`: day, month and year without leading zeros, as a Czech document writes it. Anything else comes back unchanged. */
export function formatDay(day: string): string {
  const parts = partsOf(day);
  return parts ? `${parts.day}. ${parts.month}. ${parts.year}` : day;
}

/** `po` (or `pondělí`) for 2026-09-28. The day of the week of a calendar date is the same in every time zone, so no zone is involved. Empty for anything else. */
export function weekdayOf(day: string, form: "short" | "long" = "short"): string {
  const parts = partsOf(day);
  if (!parts) return "";
  const index = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return (form === "long" ? WEEKDAYS_LONG : WEEKDAYS_SHORT)[index];
}

/** `po 28. 9. 2026` (or `pondělí 28. 9. 2026`): the day with its weekday, for the lists and the head of an entry. Anything else comes back unchanged. */
export function formatDayWithWeekday(day: string, form: "short" | "long" = "short"): string {
  const weekday = weekdayOf(day, form);
  return weekday ? `${weekday} ${formatDay(day)}` : day;
}

/**
 * A moment as the diary prints it: Prague time with its zone, `28. 9. 2026 14:32:07 SELČ (UTC+2)` (the same as the PDF,
 * `CzechFormat.dateTime`). Anything that is not a moment comes back unchanged. The offset is found by comparing the clock in
 * Prague with the instant, so the zone is Prague's whatever the time zone of the device; `Intl` supplies only the digits.
 */
export function formatPragueDateTime(instant: string): string {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return instant;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: PRAGUE,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
  const clock = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offsetHours = Math.round((clock - Math.floor(at.getTime() / 1000) * 1000) / 3_600_000);
  const two = (n: number) => String(n).padStart(2, "0");
  const zone = offsetHours === 2 ? "SELČ" : "SEČ";
  return `${parts.day}. ${parts.month}. ${parts.year} ${two(parts.hour)}:${two(parts.minute)}:${two(parts.second)} ${zone} (UTC+${offsetHours})`;
}
