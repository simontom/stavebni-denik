import { describe, expect, it } from "vitest";
import type { Draft } from "./draftStore";
import { DETAIL_FIELDS, decideDraft, emptyDetails, emptyForm, formFromEntry, keyOf, namesOf, normalizeForm, parseFormValues, temperatureOf, type FormValues } from "./reportForm";

const filled = (): FormValues => ({
  workDescription: "Betonáž stropu",
  workers: [
    { trade: "Betonář", count: "3", names: "Ing. Jan Novák, Ph.D.; Petr Svoboda" },
    { trade: "Tesař", count: "0", names: "" },
  ],
  isControlDay: true,
  constructionObj: "SO-101",
  weatherCondition: "zataženo",
  weatherMin: "8.5",
  weatherMax: "15",
  lateEntryReason: "Deník byl na jiné stavbě",
  details: { ...emptyDetails(), materials: "Beton C25/30", defects: "Trhlina v omítce" },
});

describe("the detail fields, which are the server's (EntryDetails.kt) in its order", () => {
  it("are the nine fields of the vyhláška, the start and interruption of work among them (příloha 12 B.2 b)", () => {
    expect(DETAIL_FIELDS.map((d) => d.key)).toEqual([
      "materials",
      "machinery",
      "testsAndChecks",
      "safetyNotes",
      "dustMeasures",
      "accessibilityMeasures",
      "defects",
      "workStateChanges",
      "otherNotes",
    ]);
    expect(DETAIL_FIELDS.find((d) => d.key === "workStateChanges")?.label).toBe("Zahájení, přerušení a obnovení prací (data a důvody)");
  });

  it("keep a draft that was typed before the start-and-interruption field existed, with that field empty", () => {
    const stored = JSON.parse(JSON.stringify(filled())) as { details: Record<string, string> };
    delete stored.details.workStateChanges;
    const parsed = parseFormValues(stored)!;
    expect(parsed.details.workStateChanges).toBe("");
    expect(parsed.details.materials).toBe("Beton C25/30");
  });

  it("carry the start and interruption of work through the entry, the key and the tidying like every other field", () => {
    const entry = { details: { workStateChanges: "  Zahájeno 28. 9. 2026, přerušeno pro déšť  " } };
    const form = formFromEntry(entry);
    expect(form.details.workStateChanges).toBe("  Zahájeno 28. 9. 2026, přerušeno pro déšť  ");
    expect(normalizeForm(form).details.workStateChanges).toBe("Zahájeno 28. 9. 2026, přerušeno pro déšť");
    expect(keyOf({ ...emptyForm(), details: { ...emptyDetails(), workStateChanges: "x" } })).not.toBe(keyOf(emptyForm()));
  });
});

describe("keyOf, which tells whether the form has unsaved changes", () => {
  it("is the same for the same content however the properties are ordered", () => {
    const a = filled();
    const reordered = {
      details: { ...a.details },
      lateEntryReason: a.lateEntryReason,
      weatherMax: a.weatherMax,
      weatherMin: a.weatherMin,
      weatherCondition: a.weatherCondition,
      constructionObj: a.constructionObj,
      isControlDay: a.isControlDay,
      workers: a.workers.map((w) => ({ names: w.names, count: w.count, trade: w.trade })),
      workDescription: a.workDescription,
    } satisfies FormValues;
    expect(keyOf(reordered)).toBe(keyOf(a));
  });

  it("changes with every field", () => {
    const base = keyOf(filled());
    const changes: Partial<FormValues>[] = [
      { workDescription: "x" },
      { workers: [{ trade: "Betonář", count: "4", names: "" }] },
      { isControlDay: false },
      { constructionObj: "SO-102" },
      { weatherCondition: "jasno" },
      { weatherMin: "9" },
      { weatherMax: "16" },
      { lateEntryReason: "jiný důvod" },
      { details: { ...emptyDetails(), materials: "Cihly" } },
    ];
    for (const change of changes) expect(keyOf({ ...filled(), ...change })).not.toBe(base);
    expect(keyOf({ ...filled(), details: { ...filled().details, otherNotes: "a" } })).not.toBe(base);
  });

  it("tells a trade's names from the next trade's trade", () => {
    const a: FormValues = {
      ...emptyForm(),
      workers: [
        { trade: "a", count: "1", names: "b" },
        { trade: "c", count: "", names: "" },
      ],
    };
    const b: FormValues = {
      ...emptyForm(),
      workers: [
        { trade: "a", count: "1", names: "" },
        { trade: "b", count: "c", names: "" },
      ],
    };
    expect(keyOf(a)).not.toBe(keyOf(b));
  });
});

describe("emptyForm", () => {
  it("is empty (nothing invented), with one empty trade row, and every call gives a fresh object", () => {
    const form = emptyForm();
    expect(form.workDescription).toBe("");
    expect(form.workers).toEqual([{ trade: "", count: "", names: "" }]);
    expect(Object.keys(form.details)).toEqual(DETAIL_FIELDS.map((d) => d.key));
    expect(Object.values(form.details).every((v) => v === "")).toBe(true);
    form.workers.push({ trade: "x", count: "1", names: "" });
    form.details.materials = "changed";
    expect(emptyForm().workers).toHaveLength(1);
    expect(emptyForm().details.materials).toBe("");
  });
});

describe("formFromEntry, the form as the server's entry shows it", () => {
  it("reads every field of an entry", () => {
    const form = formFromEntry({
      workDescription: "Betonáž stropu",
      workersByTrade: JSON.stringify([
        { trade: "Betonář", count: 3, names: ["Ing. Jan Novák, Ph.D.", "Petr Svoboda"] },
        { trade: "Tesař", count: 0 },
      ]),
      isControlDay: true,
      constructionObj: "SO-101",
      weather: { condition: "zataženo", tempMin: 8.5, tempMax: 15 },
      lateEntryReason: "Deník byl na jiné stavbě",
      details: { materials: "Beton C25/30", defects: "Trhlina v omítce" },
    });
    expect(keyOf(form)).toBe(
      keyOf({
        ...filled(),
        workers: [
          { trade: "Betonář", count: "3", names: "Ing. Jan Novák, Ph.D.; Petr Svoboda" },
          { trade: "Tesař", count: "0", names: "" },
        ],
      }),
    );
  });

  it("takes the workers as a list as well as the JSON text the server sends", () => {
    expect(formFromEntry({ workersByTrade: [{ trade: "Zedník", count: 2 }] }).workers).toEqual([{ trade: "Zedník", count: "2", names: "" }]);
  });

  it.each([
    ["no workers", { workersByTrade: "[]" }],
    ["workers that are no JSON", { workersByTrade: "{oops" }],
    ["workers that are no list", { workersByTrade: "{}" }],
    ["no workers field", {}],
  ])("keeps the one empty trade row for %s", (_name, entry) => {
    expect(formFromEntry(entry).workers).toEqual([{ trade: "", count: "", names: "" }]);
  });

  it("ignores values of the wrong type and details the form does not know", () => {
    const form = formFromEntry({
      workDescription: 5,
      constructionObj: null,
      weather: { condition: 1, tempMin: "8" },
      details: { materials: 7, unknownKey: "x", machinery: "Bagr" },
    });
    expect(form.workDescription).toBe("");
    expect(form.constructionObj).toBe("");
    expect(form.weatherCondition).toBe("");
    expect(form.weatherMin).toBe("");
    expect(form.details.materials).toBe("");
    expect(form.details.machinery).toBe("Bagr");
    expect(Object.keys(form.details)).toEqual(DETAIL_FIELDS.map((d) => d.key));
  });

  it("gives the empty form for no entry", () => {
    expect(keyOf(formFromEntry(null))).toBe(keyOf(emptyForm()));
    expect(keyOf(formFromEntry(undefined))).toBe(keyOf(emptyForm()));
    expect(keyOf(formFromEntry("text"))).toBe(keyOf(emptyForm()));
  });
});

describe("parseFormValues, the check of what a draft holds", () => {
  it("accepts what the form itself produces, unchanged", () => {
    const form = filled();
    expect(parseFormValues(JSON.parse(JSON.stringify(form)))).toEqual(form);
    expect(keyOf(parseFormValues(JSON.parse(JSON.stringify(form)))!)).toBe(keyOf(form));
  });

  it("fills in a detail the draft does not have and drops one it should not have", () => {
    const stored = JSON.parse(JSON.stringify(filled())) as Record<string, unknown>;
    stored.details = { materials: "Beton", unknownKey: "x" };
    const parsed = parseFormValues(stored)!;
    expect(parsed.details.materials).toBe("Beton");
    expect(Object.keys(parsed.details)).toEqual(DETAIL_FIELDS.map((d) => d.key));
    expect(parsed.details.defects).toBe("");
  });

  it.each([
    ["null", null],
    ["a number", 5],
    ["a list", []],
    ["a missing description", { ...filled(), workDescription: undefined }],
    ["a description that is no text", { ...filled(), workDescription: 5 }],
    ["a control day that is no flag", { ...filled(), isControlDay: "yes" }],
    ["workers that are no list", { ...filled(), workers: "none" }],
    ["no workers at all", { ...filled(), workers: [] }],
    ["a worker row with a number for a count", { ...filled(), workers: [{ trade: "a", count: 3, names: "" }] }],
    ["a worker row that is no object", { ...filled(), workers: ["a"] }],
    ["details that are no object", { ...filled(), details: "x" }],
    ["a detail that is no text", { ...filled(), details: { ...emptyDetails(), materials: 5 } }],
    ["more trades than anybody writes", { ...filled(), workers: Array.from({ length: 201 }, () => ({ trade: "a", count: "1", names: "" })) }],
  ])("refuses %s", (_name, stored) => {
    expect(parseFormValues(stored)).toBeNull();
  });
});

describe("decideDraft, what to do with a draft when the day is opened", () => {
  const loaded = filled();
  const edited: FormValues = { ...filled(), workDescription: "Betonáž stropu a schodiště" };
  const draft = (values: FormValues, baseUpdatedAt: string | null): Draft<FormValues> => ({
    version: 1,
    userId: "u",
    projectId: "p",
    day: "2026-10-16",
    baseUpdatedAt,
    savedAt: "2026-10-16T12:00:00.000Z",
    values,
  });
  const decide = (over: Partial<Parameters<typeof decideDraft>[0]> = {}) =>
    decideDraft({ draft: draft(edited, "v1"), loaded, loadedUpdatedAt: "v1", canWrite: true, isSigned: false, ...over });

  it("does nothing when there is no draft", () => {
    expect(decide({ draft: null })).toEqual({ action: "none" });
  });

  it("offers a draft that holds changes the stored entry does not have", () => {
    expect(decide()).toEqual({ action: "offer", stale: false });
  });

  it("offers a draft for a day that has no entry, when it holds anything", () => {
    expect(decide({ draft: draft(edited, null), loaded: emptyForm(), loadedUpdatedAt: null })).toEqual({ action: "offer", stale: false });
  });

  it("does not offer, and drops, a draft that is identical to the stored entry (a save whose answer was lost)", () => {
    expect(decide({ draft: draft(filled(), "v1") })).toEqual({ action: "drop" });
    expect(decide({ draft: draft(emptyForm(), null), loaded: emptyForm(), loadedUpdatedAt: null })).toEqual({ action: "drop" });
  });

  it("treats a draft as identical when it differs only by what the server tidies up, so no false warning is shown", () => {
    // Typed: a trailing space after the trade, "Jan;Petr" without a space, an empty trade row, a count with a leading zero,
    // a temperature with a comma. Stored (and loaded): the same entry as the server keeps it.
    const stored: FormValues = {
      ...emptyForm(),
      workDescription: "Betonáž",
      workers: [{ trade: "Zedník", count: "3", names: "Jan; Petr" }],
      weatherCondition: "zataženo",
      weatherMin: "8.5",
    };
    const typed: FormValues = {
      ...stored,
      workers: [
        { trade: "Zedník ", count: "03", names: "Jan;Petr" },
        { trade: "", count: "", names: "" },
      ],
      weatherCondition: "zataženo ",
      weatherMin: "8,5",
    };
    // The entry was saved in between (its version moved on): without the tidying this would be offered as "stale".
    expect(decide({ draft: draft(typed, null), loaded: stored, loadedUpdatedAt: "v2" })).toEqual({ action: "drop" });
    // A real difference is still offered.
    expect(decide({ draft: draft({ ...typed, workDescription: "Betonáž a bednění" }, null), loaded: stored, loadedUpdatedAt: "v2" })).toEqual({ action: "offer", stale: true });
  });

  it("says the draft is stale when the entry was saved by somebody else after it was typed, and still offers it", () => {
    expect(decide({ loadedUpdatedAt: "v2" })).toEqual({ action: "offer", stale: true });
    // The day had no entry when the draft was typed, and somebody has created it since.
    expect(decide({ draft: draft(edited, null), loadedUpdatedAt: "v1" })).toEqual({ action: "offer", stale: true });
  });

  it("never keeps a draft of a signed entry", () => {
    expect(decide({ isSigned: true })).toEqual({ action: "drop" });
    expect(decide({ isSigned: true, canWrite: null })).toEqual({ action: "drop" });
  });

  it("never keeps a draft of somebody whose role is known and may not write in the project", () => {
    expect(decide({ canWrite: false })).toEqual({ action: "drop" });
  });

  it("leaves a draft alone while the role is not known (the request failed or has not answered): it is neither offered nor dropped", () => {
    expect(decide({ canWrite: null })).toEqual({ action: "none" });
    // Not even one that would be dropped for being identical: nothing is decided without the role.
    expect(decide({ canWrite: null, draft: draft(filled(), "v1") })).toEqual({ action: "none" });
  });

  it("has nothing to drop when there is no draft, whatever the role or the state of the entry", () => {
    expect(decide({ draft: null, canWrite: false, isSigned: true })).toEqual({ action: "none" });
    expect(decide({ draft: null, canWrite: null })).toEqual({ action: "none" });
  });
});

describe("namesOf and temperatureOf, as the save reads the form", () => {
  it("namesOf splits at semicolons, trims, and leaves blanks out", () => {
    expect(namesOf("Jan;Petr")).toEqual(["Jan", "Petr"]);
    expect(namesOf(" Ing. Jan Novák, Ph.D. ;; Petr Svoboda ; ")).toEqual(["Ing. Jan Novák, Ph.D.", "Petr Svoboda"]);
    expect(namesOf("  ")).toEqual([]);
  });

  it("temperatureOf reads a comma as a decimal point and an empty or unreadable field as nothing", () => {
    expect(temperatureOf("8,5")).toBe(8.5);
    expect(temperatureOf("-3")).toBe(-3);
    expect(temperatureOf("")).toBeUndefined();
    expect(temperatureOf("abc")).toBeUndefined();
  });
});

describe("normalizeForm, the form as the server stores it", () => {
  it("trims a trade and a head count, rewrites the names with one separator, and drops empty trade rows", () => {
    const form: FormValues = {
      ...emptyForm(),
      workers: [
        { trade: "Zedník ", count: " 003", names: "Jan;Petr" },
        { trade: "", count: "", names: "" },
        { trade: "Tesař", count: "0", names: " ; " },
      ],
    };
    expect(normalizeForm(form).workers).toEqual([
      { trade: "Zedník", count: "3", names: "Jan; Petr" },
      { trade: "Tesař", count: "0", names: "" },
    ]);
  });

  it("keeps one empty trade row when every row is empty (what a loaded entry without workers shows)", () => {
    const form: FormValues = {
      ...emptyForm(),
      workers: [
        { trade: " ", count: "", names: "" },
        { trade: "", count: "", names: "" },
      ],
    };
    expect(normalizeForm(form).workers).toEqual([{ trade: "", count: "", names: "" }]);
  });

  it("trims the weather text, the late-entry reason and every detail (the server does), and writes a temperature as the number it is", () => {
    const form: FormValues = {
      ...emptyForm(),
      weatherCondition: " zataženo ",
      weatherMin: "8,50",
      weatherMax: "15",
      lateEntryReason: " Deník byl jinde ",
      details: { ...emptyDetails(), materials: "  Beton  ", defects: "   " },
    };
    const normalized = normalizeForm(form);
    expect(normalized.weatherCondition).toBe("zataženo");
    expect(normalized.weatherMin).toBe("8.5");
    expect(normalized.weatherMax).toBe("15");
    expect(normalized.lateEntryReason).toBe("Deník byl jinde");
    expect(normalized.details.materials).toBe("Beton");
    expect(normalized.details.defects).toBe("");
  });

  it("leaves the day's work and the construction object as they are (the server does not trim them)", () => {
    const normalized = normalizeForm({ ...emptyForm(), workDescription: "  Betonáž \n", constructionObj: " SO-101 " });
    expect(normalized.workDescription).toBe("  Betonáž \n");
    expect(normalized.constructionObj).toBe(" SO-101 ");
  });

  it("is idempotent, and does not change what it is given", () => {
    const form = filled();
    const before = JSON.stringify(form);
    expect(keyOf(normalizeForm(normalizeForm(form)))).toBe(keyOf(normalizeForm(form)));
    expect(JSON.stringify(form)).toBe(before);
  });
});
