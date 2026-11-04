import { describe, expect, it } from "vitest";
import { MAX_WEATHER_CHARS, WEATHER_CONDITIONS, hasCondition, toggleCondition } from "./weatherChips";

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

describe("toggleCondition: a chip adds its word to the text, or takes it out, and never touches what else was typed", () => {
  it("sets an empty field to the word", () => {
    expect(toggleCondition("", "jasno")).toBe("jasno");
    expect(toggleCondition("  ", "jasno")).toBe("jasno");
  });

  it("adds a second word after a comma, so 'zataženo, déšť' is one tap more", () => {
    expect(toggleCondition("zataženo", "déšť")).toBe("zataženo, déšť");
    expect(toggleCondition("zataženo, ", "déšť")).toBe("zataženo, déšť");
    expect(toggleCondition("zataženo,", "déšť")).toBe("zataženo, déšť");
  });

  it("keeps the person's own words: they are the rest of the text", () => {
    expect(toggleCondition("staveniště rozmoklé", "déšť")).toBe("staveniště rozmoklé, déšť");
    expect(toggleCondition("zataženo, staveniště rozmoklé", "zataženo")).toBe("staveniště rozmoklé");
    expect(toggleCondition("zataženo, staveniště rozmoklé", "mráz")).toBe("zataženo, staveniště rozmoklé, mráz");
  });

  it("takes the word out again, which empties the field when it was the only one", () => {
    expect(toggleCondition("déšť", "déšť")).toBe("");
    expect(toggleCondition("Déšť", "déšť")).toBe("");
    expect(toggleCondition("zataženo, déšť", "déšť")).toBe("zataženo");
    expect(toggleCondition("déšť, zataženo, déšť", "déšť")).toBe("zataženo");
  });

  it("does not add a word that would take the text over the 200 characters the server takes", () => {
    const long = "x".repeat(MAX_WEATHER_CHARS - 3);
    expect(toggleCondition(long, "déšť")).toBe(long);
    const fits = "x".repeat(MAX_WEATHER_CHARS - 2 - "déšť".length);
    expect(toggleCondition(fits, "déšť")).toBe(`${fits}, déšť`);
    expect(toggleCondition(fits, "déšť").length).toBe(MAX_WEATHER_CHARS);
  });

  it("toggles back to what it was for a text that has only chips in it", () => {
    let text = "";
    for (const chip of ["zataženo", "déšť", "silný vítr"]) text = toggleCondition(text, chip);
    expect(text).toBe("zataženo, déšť, silný vítr");
    for (const chip of ["déšť", "zataženo", "silný vítr"]) text = toggleCondition(text, chip);
    expect(text).toBe("");
  });
});
