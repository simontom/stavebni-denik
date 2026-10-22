/**
 * What the entry page needs to show an entry as a document (a signed entry, or any entry seen by somebody who cannot write):
 * plain data in, plain data out, so the unit tests cover it. No React in here.
 */
import { DETAIL_FIELDS } from "./reportForm";

/** One trade of the day: how many people, and (optionally) who. */
export interface WorkerLine {
  trade: string;
  count: number;
  names: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The trades of an entry as the API sends them (`workersByTrade` is a JSON text; an array is taken as it is). What is damaged
 * is left out rather than guessed at: a trade without a name or without a whole head count is not a line.
 */
export function workersOf(raw: unknown): WorkerLine[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const lines: WorkerLine[] = [];
  for (const row of list) {
    if (!isRecord(row) || typeof row.trade !== "string" || row.trade.trim() === "") continue;
    if (typeof row.count !== "number" || !Number.isInteger(row.count) || row.count < 0) continue;
    const names = Array.isArray(row.names) ? row.names.filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim()) : [];
    lines.push({ trade: row.trade.trim(), count: row.count, names });
  }
  return lines;
}

/** The number of people on site that day: the sum of the trades. */
export const totalWorkers = (lines: WorkerLine[]): number => lines.reduce((sum, line) => sum + line.count, 0);

export interface DetailText {
  key: string;
  label: string;
  text: string;
}

/**
 * The fields of the vyhláška, split into those that say something (in the order of the form, each with its text in full) and
 * the labels of those that do not. A text of nothing but white space says nothing.
 */
export function splitDetails(details: Record<string, string> | null | undefined): { filled: DetailText[]; emptyLabels: string[] } {
  const filled: DetailText[] = [];
  const emptyLabels: string[] = [];
  for (const field of DETAIL_FIELDS) {
    const text = details?.[field.key];
    if (typeof text === "string" && text.trim() !== "") filled.push({ key: field.key, label: field.label, text });
    else emptyLabels.push(field.label);
  }
  return { filled, emptyLabels };
}

/**
 * The one line that names every field with nothing in it ("Bez záznamu: Použité stroje a mechanizace; Zkoušky, měření a kontroly"),
 * or null when every field says something. The labels are those of the form and the PDF; they are separated by semicolons because
 * some of them have a comma in them.
 */
export const emptyDetailsLine = (emptyLabels: string[]): string | null => (emptyLabels.length === 0 ? null : `Bez záznamu: ${emptyLabels.join("; ")}`);

/** `Záznam č. 3` for a signed entry, `bez čísla` for one that has none yet (the number is given at signing). */
export const entryNumberLabel = (sequenceNumber: number | null | undefined): string => (typeof sequenceNumber === "number" ? `Záznam č. ${sequenceNumber}` : "bez čísla");

/** Who signed, in one line: `Jan Novák, ČKAIT 0012345`; the number is left out when there is none. Null when nobody is named. */
export function signerLine(name: string | null | undefined, ckaitNumber: string | null | undefined): string | null {
  const who = name?.trim();
  if (!who) return null;
  const number = ckaitNumber?.trim();
  return number ? `${who}, ČKAIT ${number}` : who;
}
