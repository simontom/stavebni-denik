/**
 * The total of the head counts of an entry ("Celkem: 12 pracovníků"), as plain logic so the unit tests cover it. A count is counted
 * when the save would accept it (a whole number of at most six digits, the same rule as the server's and the form's); what the
 * save would refuse is left out of the sum and said in words, so the total never claims more than the entry will say.
 */
import { czechPlural } from "./czech";
import type { WorkerRow } from "./reportForm";

/** The same rule as the form's check before it saves: a whole, non-negative number of at most six digits (0 is a head count). */
const HEAD_COUNT = /^\d{1,6}$/;

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
    if (row.trade.trim() !== "" && HEAD_COUNT.test(count)) total += Number(count);
    else incomplete += 1; // the save refuses it: a count without a trade, a trade without a count, a count that is not a whole number
  }
  return { total, incomplete };
}

/** "Celkem: 12 pracovníků", and when some rows are not counted, "(u 1 profese chybí název nebo platný počet)". */
export function workerTotalText({ total, incomplete }: WorkerTotal): string {
  const base = `Celkem: ${total} ${pluralWorkers(total)}`;
  if (incomplete === 0) return base;
  return `${base} (u ${incomplete} ${incomplete === 1 ? "profese" : "profesí"} chybí název nebo platný počet)`;
}
