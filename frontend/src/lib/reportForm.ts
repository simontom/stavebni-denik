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
export const DETAIL_FIELDS: { key: string; label: string; hint?: string; placeholder?: string }[] = [
  {
    key: "materials",
    label: "Dodávky materiálu, výrobků, strojů a zařízení, jejich uskladnění a zabudování",
    hint: "Co bylo dodáno, kde je to uskladněno a kde zabudováno (příloha 12, B.1 d).",
  },
  { key: "machinery", label: "Mechanizace", hint: "Stroje a mechanizace nasazené v tento den (příloha 12, B.1 e)." },
  {
    key: "testsAndChecks",
    label: "Zkoušky, měření a kontroly",
    hint: "Provedené zkoušky, měření a kontroly a jejich výsledek. Sem patří i souhlas se zakrytím prací, které budou zakryty: kdo ho dal a které práce se zakryly (příloha 12, B.2 m).",
  },
  { key: "safetyNotes", label: "Bezpečnost práce, ochrana životního prostředí a poučení", placeholder: "Poučení pracovníků, bezpečnostní a environmentální opatření" },
  { key: "dustMeasures", label: "Opatření proti prašnosti", placeholder: "Např. kropení, zakrytí, čištění komunikací" },
  { key: "accessibilityMeasures", label: "Opatření pro zajištění přístupnosti", placeholder: "Např. zachování přístupu k okolním objektům" },
  { key: "defects", label: "Závady a jejich odstranění", placeholder: "Zjištěné závady a způsob jejich odstranění" },
  {
    key: "workStateChanges",
    label: "Zahájení, přerušení a obnovení prací (data a důvody)",
    placeholder: "Zahájení prací, jejich přerušení (třeba pro počasí nebo technologickou přestávku) a obnovení, s daty a důvody",
  },
  {
    key: "otherNotes",
    label: "Ostatní záznamy",
    hint:
      "Nástupy, provádění prací a ukončení činností poddodavatelů (příloha 12, B.2 c). " +
      "Nepředvídané nálezy podle § 266 odst. 1: čas a okolnosti nálezu, datum, kdy byl oznámen stavebnímu úřadu, a přijatá opatření (příloha 12, B.2 w). " +
      "Další skutečnosti rozhodné pro stavbu.",
  },
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

/**
 * "Jan Novák; Petr Svoboda" as the list the server expects; blanks are left out. Names are separated by semicolons, not
 * commas: a name often has a comma in it ("Ing. Jan Novák, Ph.D.").
 */
export const namesOf = (text: string): string[] =>
  text
    .split(";")
    .map((n) => n.trim())
    .filter((n) => n !== "");

/** A temperature field as the number the server expects, or undefined when it is empty (or no number). */
export const temperatureOf = (value: string): number | undefined => {
  const n = Number.parseFloat(value.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
};

/**
 * The form as the server stores it, and so as a reload shows it: what a save does to the text is done here too (a trade
 * and the texts are trimmed, a head count is the whole number it is, names are rewritten with one separator, empty trade
 * rows are not kept, a temperature is the number it is), but never more than the save does (the day's work and the
 * construction object are stored as typed). Compare two forms through this, never raw: a draft of an entry whose save went
 * through, but whose answer was lost, differs from the stored entry only by this tidying and is not a different text.
 */
export function normalizeForm(v: FormValues): FormValues {
  const rows = v.workers
    .filter((r) => r.trade.trim() !== "" || r.count.trim() !== "" || r.names.trim() !== "")
    .map((r) => {
      const count = r.count.trim();
      return { trade: r.trade.trim(), count: /^\d{1,6}$/.test(count) ? String(Number(count)) : count, names: namesOf(r.names).join("; ") };
    });
  const temperature = (value: string): string => {
    const n = temperatureOf(value);
    return n === undefined ? "" : String(n);
  };
  return {
    workDescription: v.workDescription,
    workers: rows.length > 0 ? rows : [{ trade: "", count: "", names: "" }],
    isControlDay: v.isControlDay,
    constructionObj: v.constructionObj,
    weatherCondition: v.weatherCondition.trim(),
    weatherMin: temperature(v.weatherMin),
    weatherMax: temperature(v.weatherMax),
    lateEntryReason: v.lateEntryReason.trim(),
    details: Object.fromEntries(DETAIL_FIELDS.map((d) => [d.key, (v.details[d.key] ?? "").trim()])),
  };
}

export type DraftDecision = { action: "none" } | { action: "drop" } | { action: "offer"; stale: boolean };

/**
 * What to do with the draft of a day when the day has just been opened and the entry is loaded.
 *  - no draft: nothing;
 *  - a signed entry: the draft must not exist, drop it (whatever the role: the entry says it is signed);
 *  - the person's role is not known ([canWrite] null: the request failed or has not answered): nothing is decided, the draft
 *    stays as it is. A failed request must never delete typed work, and a draft is not offered to somebody whose right to
 *    write is not known;
 *  - somebody whose role is known and may not write in the project: drop it;
 *  - a draft identical to the stored entry (the save went through, only its answer was lost; compared after the tidying the
 *    server does, see [normalizeForm]): nothing to restore, drop it;
 *  - otherwise offer it. `stale` is true when the entry has been saved by somebody else since the draft was typed (its
 *    version differs from the one the draft was typed on): restoring and saving would replace their newer text, so the
 *    person is told.
 *
 * The draft is compared with the entry by the version it was typed on, not by the time it was written: the clock of a
 * phone can be minutes off the server's, and a wrong guess here would throw typed work away.
 */
export function decideDraft(input: {
  draft: Draft<FormValues> | null;
  loaded: FormValues;
  loadedUpdatedAt: string | null;
  canWrite: boolean | null;
  isSigned: boolean;
}): DraftDecision {
  if (input.draft === null) return { action: "none" };
  if (input.isSigned) return { action: "drop" };
  if (input.canWrite === null) return { action: "none" };
  if (!input.canWrite) return { action: "drop" };
  if (keyOf(normalizeForm(input.draft.values)) === keyOf(normalizeForm(input.loaded))) return { action: "drop" };
  return { action: "offer", stale: input.draft.baseUpdatedAt !== input.loadedUpdatedAt };
}
