/**
 * What the daily-entry form holds, as plain data: the shape, the empty form, how an entry from the server becomes form
 * values, the check of values read back from a draft, and the decision what to do with a draft when a day is opened.
 * No React in here, so the unit tests cover it.
 */
import type { Draft } from "./draftStore";

export interface WorkerRow {
  trade: string;
  count: string;
  /** The names of the people of this trade, separated by semicolons (the vyhláška asks for them; optional). */
  names: string;
}

/**
 * The text fields a daily entry has besides the day's work (vyhláška 131/2024 Sb., příloha 12, part B). The keys and the
 * order are those of the server (EntryDetails.kt); the labels are the same.
 */
export const DETAIL_FIELDS: { key: string; label: string; placeholder: string }[] = [
  { key: "materials", label: "Dodávky a uskladnění materiálu a zařízení", placeholder: "Co bylo dodáno, uskladněno nebo zabudováno" },
  { key: "machinery", label: "Použité stroje a mechanizace", placeholder: "Stroje a mechanizace nasazené v tento den" },
  { key: "testsAndChecks", label: "Zkoušky, měření a kontroly", placeholder: "Provedené zkoušky, měření a kontroly a jejich výsledek" },
  { key: "safetyNotes", label: "Bezpečnost práce, ochrana životního prostředí a poučení", placeholder: "Poučení pracovníků, bezpečnostní a environmentální opatření" },
  { key: "dustMeasures", label: "Opatření proti prašnosti", placeholder: "Např. kropení, zakrytí, čištění komunikací" },
  { key: "accessibilityMeasures", label: "Opatření pro zajištění přístupnosti", placeholder: "Např. zachování přístupu k okolním objektům" },
  { key: "defects", label: "Závady a jejich odstranění", placeholder: "Zjištěné závady a způsob jejich odstranění" },
  { key: "otherNotes", label: "Ostatní zápisy", placeholder: "Další skutečnosti rozhodné pro stavbu" },
];

export type Details = Record<string, string>;
export const emptyDetails = (): Details => Object.fromEntries(DETAIL_FIELDS.map((d) => [d.key, ""]));

/** Everything the user can edit on the form. */
export interface FormValues {
  workDescription: string;
  workers: WorkerRow[];
  isControlDay: boolean;
  constructionObj: string;
  weatherCondition: string;
  weatherMin: string;
  weatherMax: string;
  lateEntryReason: string;
  details: Details;
}

/** A new entry starts empty: invented defaults would end up in a legal record if nobody noticed them. A fresh object on every call. */
export const emptyForm = (): FormValues => ({
  workDescription: "",
  workers: [{ trade: "", count: "", names: "" }],
  isControlDay: false,
  constructionObj: "",
  weatherCondition: "",
  weatherMin: "",
  weatherMax: "",
  lateEntryReason: "",
  details: emptyDetails(),
});

/**
 * The form as one string: compared with the state it was loaded or last saved in, to know about unsaved changes. Built
 * field by field, so it does not depend on the order in which an object's properties happen to be.
 */
export const keyOf = (v: FormValues): string =>
  JSON.stringify([
    v.workDescription,
    v.workers.map((w) => [w.trade, w.count, w.names]),
    v.isControlDay,
    v.constructionObj,
    v.weatherCondition,
    v.weatherMin,
    v.weatherMax,
    v.lateEntryReason,
    DETAIL_FIELDS.map((d) => v.details[d.key] ?? ""),
  ]);

/** The most trade rows a draft may hold (the server takes 50; this only keeps a damaged draft from becoming a huge form). */
const MAX_DRAFT_ROWS = 200;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const numberText = (value: unknown): string => (typeof value === "number" ? String(value) : "");

/**
 * The form as an entry from the server shows it (`GET /projects/{id}/reports/{day}`). What is missing or of the wrong
 * type becomes empty; for no entry (null) it is the empty form.
 */
export function formFromEntry(data: unknown): FormValues {
  const form = emptyForm();
  if (!isRecord(data)) return form;

  try {
    const trades = typeof data.workersByTrade === "string" ? JSON.parse(data.workersByTrade) : data.workersByTrade;
    if (Array.isArray(trades) && trades.length > 0) {
      form.workers = trades.map((t: { trade?: unknown; count?: unknown; names?: unknown }) => ({
        trade: text(t?.trade),
        count: numberText(t?.count),
        names: Array.isArray(t?.names) ? t.names.filter((n): n is string => typeof n === "string").join("; ") : "",
      }));
    }
  } catch {
    // keep the empty row
  }

  const weather = isRecord(data.weather) ? data.weather : {};
  const details = isRecord(data.details) ? data.details : {};
  return {
    workDescription: text(data.workDescription),
    workers: form.workers,
    isControlDay: Boolean(data.isControlDay),
    constructionObj: text(data.constructionObj),
    weatherCondition: text(weather.condition),
    weatherMin: numberText(weather.tempMin),
    weatherMax: numberText(weather.tempMax),
    lateEntryReason: text(data.lateEntryReason),
    details: {
      ...emptyDetails(),
      ...Object.fromEntries(Object.entries(details).filter(([k, v]) => DETAIL_FIELDS.some((d) => d.key === k) && typeof v === "string")),
    } as Details,
  };
}

/**
 * Checks values read back from a draft (what is in `localStorage` is not to be trusted to have the shape the form needs):
 * the form values, or null when anything is of the wrong type. Details the draft lacks are empty, details the form does
 * not know are dropped.
 */
export function parseFormValues(raw: unknown): FormValues | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.workDescription !== "string" || typeof raw.constructionObj !== "string" || typeof raw.isControlDay !== "boolean") return null;
  if (typeof raw.weatherCondition !== "string" || typeof raw.weatherMin !== "string" || typeof raw.weatherMax !== "string" || typeof raw.lateEntryReason !== "string") return null;

  if (!Array.isArray(raw.workers) || raw.workers.length === 0 || raw.workers.length > MAX_DRAFT_ROWS) return null;
  const workers: WorkerRow[] = [];
  for (const row of raw.workers) {
    if (!isRecord(row) || typeof row.trade !== "string" || typeof row.count !== "string" || typeof row.names !== "string") return null;
    workers.push({ trade: row.trade, count: row.count, names: row.names });
  }

  if (!isRecord(raw.details)) return null;
  const details = emptyDetails();
  for (const field of DETAIL_FIELDS) {
    const value = raw.details[field.key];
    if (value === undefined) continue;
    if (typeof value !== "string") return null;
    details[field.key] = value;
  }

  return {
    workDescription: raw.workDescription,
    workers,
    isControlDay: raw.isControlDay,
    constructionObj: raw.constructionObj,
    weatherCondition: raw.weatherCondition,
    weatherMin: raw.weatherMin,
    weatherMax: raw.weatherMax,
    lateEntryReason: raw.lateEntryReason,
    details,
  };
}

export type DraftDecision = { action: "none" } | { action: "drop" } | { action: "offer"; stale: boolean };

/**
 * What to do with the draft of a day when the day has just been opened and the entry and the person's role are known.
 *  - no draft: nothing;
 *  - a signed entry, or somebody who may not write in the project: the draft must not exist, drop it;
 *  - a draft identical to the stored entry (the save went through, only its answer was lost): nothing to restore, drop it;
 *  - otherwise offer it. `stale` is true when the entry has been saved by somebody else since the draft was typed (its
 *    version differs from the one the draft was typed on): restoring and saving would replace their newer text, so the
 *    person is told.
 *
 * The draft is compared with the entry by the version it was typed on, not by the time it was written: the clock of a
 * phone can be minutes off the server's, and a wrong guess here would throw typed work away.
 */
export function decideDraft(input: { draft: Draft<FormValues> | null; loadedKey: string; loadedUpdatedAt: string | null; canWrite: boolean; isSigned: boolean }): DraftDecision {
  if (input.draft === null) return { action: "none" };
  if (input.isSigned || !input.canWrite) return { action: "drop" };
  if (keyOf(input.draft.values) === input.loadedKey) return { action: "drop" };
  return { action: "offer", stale: input.draft.baseUpdatedAt !== input.loadedUpdatedAt };
}
