import { describe, expect, it } from "vitest";
import { emptyDetailsLine, entryNumberLabel, signerLine, splitDetails, totalWorkers, workersOf } from "./entryDocument";
import { DETAIL_FIELDS } from "./reportForm";

describe("workersOf", () => {
  it("reads the trades as the API sends them, a JSON text, with and without names", () => {
    const raw = JSON.stringify([
      { trade: "Zedník", count: 4, names: ["Jan Novák", " Ing. Petr Svoboda, Ph.D. "] },
      { trade: "Železář", count: 3 },
    ]);
    expect(workersOf(raw)).toEqual([
      { trade: "Zedník", count: 4, names: ["Jan Novák", "Ing. Petr Svoboda, Ph.D."] },
      { trade: "Železář", count: 3, names: [] },
    ]);
  });

  it("keeps a trade with no people (a count of 0 is a statement) and counts the total", () => {
    const lines = workersOf([
      { trade: "Tesař", count: 0 },
      { trade: "Zedník", count: 4 },
      { trade: "Elektrikář", count: 2 },
    ]);
    expect(lines.map((l) => l.count)).toEqual([0, 4, 2]);
    expect(totalWorkers(lines)).toBe(6);
  });

  it("leaves out what is damaged instead of guessing", () => {
    expect(workersOf("not json")).toEqual([]);
    expect(workersOf("{}")).toEqual([]);
    expect(workersOf(null)).toEqual([]);
    expect(workersOf(undefined)).toEqual([]);
    expect(
      workersOf([
        { trade: "  ", count: 3 },
        { trade: "Bez počtu" },
        { trade: "Zlomek", count: 1.5 },
        { trade: "Záporný", count: -1 },
        { trade: "Textový počet", count: "3" },
        "řetězec",
        null,
        { trade: "Dobrý", count: 2, names: [3, "", "  ", "Karel"] },
      ]),
    ).toEqual([{ trade: "Dobrý", count: 2, names: ["Karel"] }]);
  });

  it("has a total of nothing for no trades", () => {
    expect(totalWorkers([])).toBe(0);
  });
});

describe("splitDetails", () => {
  it("prints the filled fields in full, in the order of the form, and names the empty ones", () => {
    const long = "Beton C25/30 XC1, 24 m3.\nDodávka 8:30, druhá 13:15.\n" + "x".repeat(4000);
    const { filled, emptyLabels } = splitDetails({ machinery: "Autojeřáb 40 t", materials: long });

    expect(filled.map((f) => f.key)).toEqual(["materials", "machinery"]);
    expect(filled[0].text, "the text is whole, not cut or tidied").toBe(long);
    expect(filled[0].label).toBe(DETAIL_FIELDS[0].label);
    expect(emptyLabels).toEqual(DETAIL_FIELDS.filter((f) => f.key !== "materials" && f.key !== "machinery").map((f) => f.label));
    expect(filled.length + emptyLabels.length, "every field is in one list or the other").toBe(DETAIL_FIELDS.length);
  });

  it("takes a text of nothing but white space, and a missing key, for no text", () => {
    const { filled, emptyLabels } = splitDetails({ materials: "  \n\t ", machinery: "", safetyNotes: "Poučení proběhlo" });
    expect(filled.map((f) => f.key)).toEqual(["safetyNotes"]);
    expect(emptyLabels).toHaveLength(DETAIL_FIELDS.length - 1);
  });

  it("ignores a key the form does not know", () => {
    const { filled, emptyLabels } = splitDetails({ somethingElse: "x" });
    expect(filled).toEqual([]);
    expect(emptyLabels).toHaveLength(DETAIL_FIELDS.length);
  });

  it("handles no details at all", () => {
    expect(splitDetails(undefined).filled).toEqual([]);
    expect(splitDetails(null).emptyLabels).toHaveLength(DETAIL_FIELDS.length);
  });
});

describe("emptyDetailsLine", () => {
  it("is one line, with the labels separated by semicolons (some of them have commas)", () => {
    const line = emptyDetailsLine(["Použité stroje a mechanizace", "Zkoušky, měření a kontroly"]);
    expect(line).toBe("Bez záznamu: Použité stroje a mechanizace; Zkoušky, měření a kontroly");
    expect(line).not.toContain("\n");
  });

  it("is nothing when every field says something", () => {
    expect(emptyDetailsLine([])).toBeNull();
  });

  it("names all nine fields of an empty entry", () => {
    const line = emptyDetailsLine(splitDetails({}).emptyLabels)!;
    for (const field of DETAIL_FIELDS) expect(line, field.key).toContain(field.label);
  });
});

describe("entryNumberLabel", () => {
  it("says the number of a signed entry and that a draft has none", () => {
    expect(entryNumberLabel(7)).toBe("Záznam č. 7");
    expect(entryNumberLabel(null)).toBe("bez čísla");
    expect(entryNumberLabel(undefined)).toBe("bez čísla");
  });
});

describe("signerLine", () => {
  it("names the signer with the ČKAIT number", () => {
    expect(signerLine("Jan Stavbyvedoucí", "0012345")).toBe("Jan Stavbyvedoucí, ČKAIT 0012345");
    expect(signerLine("  Jan  ", " 0012345 ")).toBe("Jan, ČKAIT 0012345");
  });

  it("leaves the number out when there is none, and is null when nobody is named", () => {
    expect(signerLine("Jan", null)).toBe("Jan");
    expect(signerLine("Jan", "  ")).toBe("Jan");
    expect(signerLine(null, "0012345")).toBeNull();
    expect(signerLine("", "0012345")).toBeNull();
  });
});
