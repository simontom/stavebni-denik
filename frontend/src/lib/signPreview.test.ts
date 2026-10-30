import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IDENTIFICATION_KEYS, describeChanges, isSignPreview, labelOfIdentificationKey, shortDigest, viewOf, type PartA, type SignPreview } from "./signPreview";

const DIGEST = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

const identification = (over: Record<string, string | null> = {}): Record<string, string | null> => ({
  ...Object.fromEntries(IDENTIFICATION_KEYS.map((key) => [key, null])),
  name: "Bytový dům Zelená",
  address: "Zelená 1, Brno",
  cadastralArea: "Brno-střed",
  parcelNumbers: "12/3",
  builder: "Stavebník a.s., Brno, IČO 1",
  contractor: "Zhotovitel s.r.o., Brno, IČO 2",
  permitDate: "2026-03-15",
  subcontractors: "Elektro s.r.o.\nVoda a.s.",
  ...over,
});

const partA = (over: Partial<PartA> = {}): PartA => ({
  identification: identification(),
  siteManager: { userId: "u1", name: "Jan Stavbyvedoucí", ckaitNumber: "0012345" },
  members: [
    { userId: "u1", name: "Jan Stavbyvedoucí", role: "BOSS", ckaitNumber: "0012345", scope: "Celé dílo" },
    { userId: "u2", name: "Marie Zástupce", role: "BOSS", ckaitNumber: "0099999", scope: null },
    { userId: "u3", name: "Ing. Dozor", role: "INSPECTOR", ckaitNumber: null, scope: "Technický dozor stavebníka" },
  ],
  authorizedPersons: [{ id: "a1", name: "Ing. Petr Černý", company: "Architekti s.r.o.", authorization: "Autorský dozor" }],
  projectId: "p1",
  ...over,
});

describe("what the sign dialog reads out of part A", () => {
  const view = viewOf(partA());

  it("has every field the signature covers, in the order of the form, and says so when one is empty", () => {
    expect(view.facts.map((f) => f.key)).toEqual(IDENTIFICATION_KEYS);
    const byKey = Object.fromEntries(view.facts.map((f) => [f.key, f]));
    expect(byKey.name).toMatchObject({ label: "Název stavby", value: "Bytový dům Zelená", multiline: false });
    expect(byKey.permitNumber.value, "an empty field is empty, not left out").toBeNull();
    // a day is a day as a Czech document writes it
    expect(byKey.permitDate.value).toBe("15. 3. 2026");
    // the lists keep their lines
    expect(byKey.subcontractors).toMatchObject({ value: "Elektro s.r.o.\nVoda a.s.", multiline: true });
    // a text of blanks says nothing
    expect(viewOf(partA({ identification: identification({ tdsName: "   " }) })).facts.find((f) => f.key === "tdsName")!.value).toBeNull();
  });

  it("uses the words of the project form for the labels", () => {
    expect(labelOfIdentificationKey("builder")).toBe("Stavebník (název a sídlo, IČO)");
    expect(labelOfIdentificationKey("permitNumber")).toBe("Číslo jednací povolení");
    expect(labelOfIdentificationKey("somethingNew")).toBe("somethingNew");
  });

  it("names the site manager, the managers and the supervision with their number and scope", () => {
    expect(view.siteManager).toEqual({ name: "Jan Stavbyvedoucí", ckait: "ČKAIT 0012345" });
    expect(view.managers).toEqual([
      { name: "Jan Stavbyvedoucí", ckait: "ČKAIT 0012345", scope: "Celé dílo", isSiteManager: true },
      { name: "Marie Zástupce", ckait: "ČKAIT 0099999", scope: null, isSiteManager: false },
    ]);
    expect(view.supervisors).toEqual([{ name: "Ing. Dozor", ckait: "bez čísla ČKAIT", scope: "Technický dozor stavebníka", isSiteManager: false }]);
  });

  it("lists the authorised persons with their function", () => {
    expect(view.authorizedPersons).toEqual([{ name: "Ing. Petr Černý", company: "Architekti s.r.o.", function: "Autorský dozor" }]);
  });

  it("shows a short digest: eight characters and an ellipsis", () => {
    expect(shortDigest(DIGEST)).toBe("a1b2c3d4…");
  });
});

describe("what changed between the part A that was shown and the one that is there now", () => {
  const before = partA();

  it("says nothing when nothing differs", () => {
    expect(describeChanges(before, partA())).toEqual([]);
  });

  it("names a changed field of the identification by its label (an empty text and no text are the same)", () => {
    expect(describeChanges(before, partA({ identification: identification({ contractor: "Jiný zhotovitel", contractNumber: "SML-1" }) }))).toEqual([
      "Údaje o stavbě: Zhotovitel (název a sídlo, IČO), Číslo smlouvy",
    ]);
    expect(describeChanges(before, partA({ identification: identification({ tdsName: "  " }) }))).toEqual([]);
  });

  it("names the person whose scope changed, and the persons who came and went", () => {
    const after = partA({
      members: [
        { userId: "u1", name: "Jan Stavbyvedoucí", role: "BOSS", ckaitNumber: "0012345", scope: "Jen přístavba" },
        { userId: "u4", name: "Eva Nová", role: "INSPECTOR", ckaitNumber: null, scope: null },
        { userId: "u3", name: "Ing. Dozor", role: "INSPECTOR", ckaitNumber: null, scope: "Technický dozor stavebníka" },
      ],
    });
    expect(describeChanges(before, after)).toEqual([
      "Změna u osoby Jan Stavbyvedoucí: rozsah oprávnění a odpovědnosti",
      "Přibyla osoba Eva Nová (technický dozor)",
      "Ubyla osoba Marie Zástupce",
    ]);
  });

  it("names the authorised persons who came and went, and the site manager who was replaced", () => {
    const after = partA({
      siteManager: { userId: "u2", name: "Marie Zástupce", ckaitNumber: "0099999" },
      authorizedPersons: [{ id: "a2", name: "Ing. Nový", company: null, authorization: null }],
    });
    expect(describeChanges(before, after)).toEqual(["Hlavní stavbyvedoucí", "Přibyla pověřená osoba Ing. Nový", "Ubyla pověřená osoba Ing. Petr Černý"]);
  });
});

describe("a body is a preview only when it is one", () => {
  const preview: SignPreview = { partASha256: DIGEST, partA: partA() };

  it("accepts what the server sends", () => {
    expect(isSignPreview(preview)).toBe(true);
    expect(isSignPreview(JSON.parse(JSON.stringify(preview)))).toBe(true);
  });

  it("refuses anything else, so nothing that is not part A is shown or signed on", () => {
    for (const bad of [
      null,
      undefined,
      "x",
      [],
      {},
      { partASha256: DIGEST },
      { ...preview, partASha256: "abc" },
      { ...preview, partASha256: DIGEST.toUpperCase() },
      { ...preview, partA: null },
      { ...preview, partA: { ...preview.partA, members: null } },
      { ...preview, partA: { ...preview.partA, siteManager: null } },
    ]) {
      expect(isSignPreview(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("the screen shows every field that the signature covers", () => {
  it("has a label for each key of the identification of the signed text (PartASnapshot.kt), and no other", () => {
    const source = readFileSync(fileURLToPath(new URL("../../../backend/src/main/kotlin/cz/stavebni/denik/services/PartASnapshot.kt", import.meta.url)), "utf8");
    const server = [...source.matchAll(/IdentificationField\("(\w+)"/g)].map((m) => m[1]);
    expect(server.length).toBe(19);
    expect(IDENTIFICATION_KEYS).toEqual(server);
  });
});
