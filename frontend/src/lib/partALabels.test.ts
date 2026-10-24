import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DETAIL_FIELDS } from "./reportForm";
import { CORE, LABELS, SECTIONS } from "./projectFields";

/**
 * The screen and the print say the same (backlog C1): the label of a field of the form is the heading of that part in the printed
 * entry, word for word. The PDF is made by the backend, so this reads its sources: a label changed in one place and forgotten in the
 * other fails here. Only the words are looked at; the keys of the fields are never touched (they are part of what a signature covers).
 */
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const backend = (path: string) => read(`../../../backend/src/main/${path}`);

const entryDetailsKt = backend("kotlin/cz/stavebni/denik/services/EntryDetails.kt");
const pdfKt = backend("kotlin/cz/stavebni/denik/services/PdfExportService.kt");
const reportTyp = backend("resources/pdf/report.typ");

describe("the headings of the printed entry are the labels of the form", () => {
  it("the nine text fields: the same key and the same label, in the same order, as EntryDetails.kt", () => {
    const server = [...entryDetailsKt.matchAll(/Field\("(\w+)", "([^"]+)"/g)].map((m) => ({ key: m[1], label: m[2] }));
    expect(server.length).toBe(9);
    expect(DETAIL_FIELDS.map((f) => ({ key: f.key, label: f.label }))).toEqual(server);
  });

  it("B.1 d) and e) are worded as the decree words them", () => {
    const label = (key: string) => DETAIL_FIELDS.find((f) => f.key === key)?.label;
    expect(label("materials")).toBe("Dodávky materiálu, výrobků, strojů a zařízení, jejich uskladnění a zabudování");
    expect(label("machinery")).toBe("Mechanizace");
  });

  it("the identification of part A: the same labels as PdfExportService.PartALabels", () => {
    const block = pdfKt.match(/object PartALabels \{([^}]*)\}/)?.[1] ?? "";
    const kotlin = Object.fromEntries([...block.matchAll(/const val (\w+) = "([^"]+)"/g)].map((m) => [m[1], m[2]]));
    expect(kotlin).toEqual({
      BUILDER: LABELS.builder,
      CONTRACTOR: LABELS.contractor,
      DESIGNER: LABELS.designerName,
      SUBCONTRACTORS: LABELS.subcontractors,
      PERMIT: LABELS.permitNumber,
    });
    // the subcontractors are not a row of `projectInfo`: the template prints them itself
    expect(reportTyp).toContain(`[${LABELS.subcontractors}]`);
  });

  it("the form asks for the seat and the IČO of the four parties and for the číslo jednací of the permit", () => {
    const specs = [...CORE, ...SECTIONS.flatMap((s) => s.fields)];
    const label = (key: string) => specs.find((s) => s.key === key)?.label;
    for (const key of ["builder", "contractor", "designerName", "subcontractors"]) expect(label(key), key).toMatch(/sídlo.*IČO/);
    expect(label("permitNumber")).toBe("Číslo jednací povolení");
  });

  it("the weather is 'Počasí a stav staveniště' on the screen (the form, the document) and in the print", () => {
    const heading = "Počasí a stav staveniště";
    expect(reportTyp).toContain(`=== ${heading}`);
    expect(read("../components/EntryDocument.tsx")).toContain(heading);
    expect(read("../pages/DailyReport.tsx")).toContain(`legend="${heading}"`);
  });

  it("a late entry, and the entries of other persons, are 'záznam' in the print as on the screen", () => {
    expect(reportTyp).toContain("[Pozdní záznam]");
    expect(reportTyp).toContain("=== Záznamy dalších osob");
    expect(reportTyp).not.toMatch(/z[áÁ]pis/i);
  });
});

describe("the prompts say what the decree asks (backlog C1)", () => {
  const hint = (key: string) => DETAIL_FIELDS.find((f) => f.key === key)?.hint ?? "";

  it("B.2 c): the subcontractors, in the words of the decree", () => {
    expect(hint("otherNotes")).toContain("Nástupy, provádění prací a ukončení činností poddodavatelů");
  });

  it("B.2 m): consent to covering up works", () => {
    expect(hint("testsAndChecks")).toContain("souhlas se zakrytím prací");
  });

  it("B.2 w): unforeseen finds (§ 266 odst. 1): the time and circumstances, the date it was reported to the building authority, the measures", () => {
    const text = hint("otherNotes");
    expect(text).toContain("Nepředvídané nálezy podle § 266 odst. 1");
    expect(text).toContain("čas a okolnosti");
    expect(text).toContain("oznámen stavebnímu úřadu");
    expect(text).toContain("přijatá opatření");
  });
});
