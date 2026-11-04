import { describe, expect, it } from "vitest";
import { MAX_WEATHER_CHARS, WEATHER_CONDITIONS, conditionFits, hasCondition, toggleCondition } from "./weatherChips";

describe("WEATHER_CONDITIONS", () => {
  it("are the common conditions of a site, each one a short word or two, none twice", () => {
    expect(WEATHER_CONDITIONS).toEqual(expect.arrayContaining(["jasno", "polojasno", "zataženo", "déšť", "sněžení", "bouřka", "mráz", "silný vítr"]));
    expect(new Set(WEATHER_CONDITIONS.map((c) => c.toLowerCase())).size).toBe(WEATHER_CONDITIONS.length);
    for (const c of WEATHER_CONDITIONS) {
      expect(c).toBe(c.trim());
      expect(c).not.toContain(",");
      expect(c.length).toBeLessThan(20);
    }
  });
});

describe("hasCondition: the text names the condition", () => {
  it("is true when the condition is one of the words the text lists, whatever the case and the spacing", () => {
    expect(hasCondition("déšť", "déšť")).toBe(true);
    expect(hasCondition("Déšť", "déšť")).toBe(true);
    expect(hasCondition("zataženo, déšť", "déšť")).toBe(true);
    expect(hasCondition("zataženo ,  déšť , staveniště rozmoklé", "déšť")).toBe(true);
  });

  it("is false for a word that only contains it, and for an empty text", () => {
    expect(hasCondition("přeháňky", "déšť")).toBe(false);
    expect(hasCondition("deštivo", "déšť")).toBe(false);
    expect(hasCondition("polojasno", "jasno")).toBe(false);
    expect(hasCondition("zataženo, silný vítr", "vítr")).toBe(false);
    expect(hasCondition("", "déšť")).toBe(false);
    expect(hasCondition("   ", "déšť")).toBe(false);
  });
});

describe("toggleCondition: a chip changes the text as little as it can", () => {
  it("sets an empty field to the word", () => {
    expect(toggleCondition("", "jasno")).toBe("jasno");
    expect(toggleCondition("  ", "jasno")).toBe("jasno");
  });

  it("adds a word after a comma at the end, so 'zataženo, déšť' is one tap more", () => {
    expect(toggleCondition("zataženo", "déšť")).toBe("zataženo, déšť");
    expect(toggleCondition("zataženo,", "déšť")).toBe("zataženo, déšť");
    expect(toggleCondition("zataženo, ", "déšť")).toBe("zataženo, déšť");
    expect(toggleCondition("staveniště rozmoklé", "déšť")).toBe("staveniště rozmoklé, déšť");
  });

  it("leaves everything else as it was typed: the commas, the spaces, the case and the empty places between commas", () => {
    // the reviewer's example: untidy separators are not tidied by a tap
    expect(toggleCondition("  ,,zataženo ,   mlha ,", "jasno")).toBe("  ,,zataženo ,   mlha , jasno");
    expect(toggleCondition("Zataženo ;  Mlha", "jasno")).toBe("Zataženo ;  Mlha, jasno");
  });

  it("takes out only that word with one comma next to it, and leaves the rest as typed", () => {
    expect(toggleCondition("zataženo, déšť, bouřka", "déšť")).toBe("zataženo, bouřka");
    expect(toggleCondition("zataženo, déšť, bouřka", "bouřka")).toBe("zataženo, déšť");
    expect(toggleCondition("zataženo, déšť, bouřka", "zataženo")).toBe("déšť, bouřka");
    expect(toggleCondition("zataženo, staveniště rozmoklé", "zataženo")).toBe("staveniště rozmoklé");
    expect(toggleCondition("zataženo,   déšť  ,mlha", "déšť")).toBe("zataženo,   mlha");
    expect(toggleCondition("déšť", "déšť")).toBe("");
    expect(toggleCondition("  déšť ", "déšť")).toBe("");
  });

  it("takes out one occurrence, not every spelling of the word (a person who wrote 'Déšť' and 'déšť' meant two things)", () => {
    expect(toggleCondition("Déšť, bouřka, déšť", "déšť")).toBe("bouřka, déšť");
    expect(toggleCondition("zataženo, MRÁZ, mráz", "mráz")).toBe("zataženo, mráz");
  });

  it("keeps what the person typed around the word, and a longer phrase that has the word in it is another word", () => {
    expect(toggleCondition("  ,,zataženo ,   mlha ,", "mlha")).toBe("  ,,zataženo ,   ");
    expect(toggleCondition("ráno mlha, odpoledne déšť", "déšť")).toBe("ráno mlha, odpoledne déšť, déšť");
  });

  it("toggles back to an empty field for a text that has only chips in it", () => {
    let text = "";
    for (const chip of ["zataženo", "déšť", "silný vítr"]) text = toggleCondition(text, chip);
    expect(text).toBe("zataženo, déšť, silný vítr");
    for (const chip of ["déšť", "zataženo", "silný vítr"]) text = toggleCondition(text, chip);
    expect(text).toBe("");
  });

  it("does not add a word that would take the text over the 200 characters the server takes, and says that it does not", () => {
    const long = "x".repeat(MAX_WEATHER_CHARS - 3);
    expect(toggleCondition(long, "déšť")).toBe(long);
    expect(conditionFits(long, "déšť")).toBe(false);
    const fits = "x".repeat(MAX_WEATHER_CHARS - 2 - "déšť".length);
    expect(toggleCondition(fits, "déšť")).toBe(`${fits}, déšť`);
    expect(toggleCondition(fits, "déšť").length).toBe(MAX_WEATHER_CHARS);
    expect(conditionFits(fits, "déšť")).toBe(true);
  });

  it("always lets a word be taken out, also from a text that is at the limit", () => {
    const full = `${"x".repeat(MAX_WEATHER_CHARS - 6)}, déšť`;
    expect(full.length).toBe(MAX_WEATHER_CHARS);
    expect(conditionFits(full, "déšť")).toBe(true);
    expect(toggleCondition(full, "déšť")).toBe("x".repeat(MAX_WEATHER_CHARS - 6));
  });
});
