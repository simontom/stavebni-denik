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
