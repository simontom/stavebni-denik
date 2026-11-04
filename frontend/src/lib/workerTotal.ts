/**
 * The total of the head counts of an entry ("Celkem: 12 pracovníků"), as plain logic so the unit tests cover it. A count is counted
 * when the save would accept it: a whole number from 0 to 100 000 for a trade, the rule of the server (`DailyReportService`) and of the form's own
 * check before it saves (`isHeadCount`); what the save would refuse is left out of the sum and said in words, so the total does not add up a
 * number that the entry could not say. (The server has other rules about the rows, such as no more names than workers; they do not change a sum.)
 */
import { czechPlural } from "./czech";
import type { WorkerRow } from "./reportForm";

/** The most workers the server takes for one trade (`DailyReportService`: a head count from 0 to 100 000). */
export const MAX_HEAD_COUNT = 100_000;

/** Digits only (no sign, no point, no exponent), at most seven of them so that leading zeros are no problem; the size is checked below. */
const DIGITS = /^\d{1,7}$/;

/** A head count the server accepts: a whole number from 0 to 100 000, written in digits (0 is a head count, `007` is 7). */
export const isHeadCount = (text: string): boolean => {
  const t = text.trim();
  return DIGITS.test(t) && Number(t) <= MAX_HEAD_COUNT;
};

export interface WorkerTotal {
  /** The sum of the head counts that the save would accept. */
  total: number;
  /** Rows that say something (a trade, a count or names) but lack a trade or a head count that the save would accept: not in the sum. */
  incomplete: number;
}

/** `pracovník`, `pracovníci` or `pracovníků`, as the number says. */
export const pluralWorkers = (n: number): string => czechPlural(n, "pracovník", "pracovníci", "pracovníků");

export function workerTotal(rows: readonly WorkerRow[]): WorkerTotal {
  let total = 0;
  let incomplete = 0;
  for (const row of rows) {
    const count = row.count.trim();
    if (row.trade.trim() === "" && count === "" && row.names.trim() === "") continue; // a row left empty is not a trade
    if (row.trade.trim() !== "" && isHeadCount(count)) total += Number(count);
    else incomplete += 1; // the save refuses it: a count without a trade, a trade without a count, a count that is not a whole number or is over the limit
  }
  return { total, incomplete };
}

/** "Celkem: 12 pracovníků", and when some rows are not counted, "(u 1 profese chybí název nebo platný počet)". */
export function workerTotalText({ total, incomplete }: WorkerTotal): string {
  const base = `Celkem: ${total} ${pluralWorkers(total)}`;
  if (incomplete === 0) return base;
  return `${base} (u ${incomplete} ${incomplete === 1 ? "profese" : "profesí"} chybí název nebo platný počet)`;
}
