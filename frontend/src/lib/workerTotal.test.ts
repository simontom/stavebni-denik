import { describe, expect, it } from "vitest";
import { czechPlural } from "./czech";
import { pluralWorkers, workerTotal, workerTotalText } from "./workerTotal";

const row = (trade: string, count: string, names = "") => ({ trade, count, names });

describe("czechPlural", () => {
  it("takes the form of one, of two to four, and of everything else", () => {
    expect(czechPlural(1, "profese", "profese", "profesí")).toBe("profese");
    expect(czechPlural(2, "dům", "domy", "domů")).toBe("domy");
    expect(czechPlural(4, "dům", "domy", "domů")).toBe("domy");
    expect(czechPlural(5, "dům", "domy", "domů")).toBe("domů");
    expect(czechPlural(0, "dům", "domy", "domů")).toBe("domů");
  });
});

describe("pluralWorkers", () => {
  it("has the Czech forms of pracovník for the numbers a site has", () => {
    const forms = [0, 1, 2, 3, 4, 5, 11, 12, 14, 21, 22, 100, 101, 102].map((n) => `${n} ${pluralWorkers(n)}`);
    expect(forms).toEqual([
      "0 pracovníků",
      "1 pracovník",
      "2 pracovníci",
      "3 pracovníci",
      "4 pracovníci",
      "5 pracovníků",
      "11 pracovníků",
      "12 pracovníků",
      "14 pracovníků",
      "21 pracovníků",
      "22 pracovníků",
      "100 pracovníků",
      "101 pracovníků",
      "102 pracovníků",
    ]);
  });
});

describe("workerTotal", () => {
  it("adds the head counts of the trades", () => {
    expect(workerTotal([row("Zedník", "5"), row("Tesař", "3"), row("Betonář", "4")])).toEqual({ total: 12, incomplete: 0 });
  });

  it("counts a trade of 0 as 0, and leading zeros as the number they spell", () => {
    expect(workerTotal([row("Zedník", "0"), row("Tesař", "007"), row("Betonář", " 2 ")])).toEqual({ total: 9, incomplete: 0 });
  });

  it("is 0 for a form nobody has filled in, and a row left completely empty is not a trade", () => {
    expect(workerTotal([])).toEqual({ total: 0, incomplete: 0 });
    expect(workerTotal([row("", "")])).toEqual({ total: 0, incomplete: 0 });
    expect(workerTotal([row("", "", "   ")])).toEqual({ total: 0, incomplete: 0 });
  });

  it("does not count what the save would refuse, and says how many rows that is", () => {
    // a trade without a head count, a count that is not a whole number, a negative one, one with an exponent, one of seven digits
    expect(workerTotal([row("Zedník", "5"), row("Tesař", "")])).toEqual({ total: 5, incomplete: 1 });
    expect(workerTotal([row("Zedník", "5"), row("Tesař", "2.5")])).toEqual({ total: 5, incomplete: 1 });
    expect(workerTotal([row("Zedník", "5"), row("Tesař", "-3")])).toEqual({ total: 5, incomplete: 1 });
    expect(workerTotal([row("Zedník", "5"), row("Tesař", "1e2")])).toEqual({ total: 5, incomplete: 1 });
    expect(workerTotal([row("Zedník", "5"), row("Tesař", "1234567")])).toEqual({ total: 5, incomplete: 1 });
    expect(workerTotal([row("Betonář", "3"), row("Tesař", "x")])).toEqual({ total: 3, incomplete: 1 });
  });

  it("does not count a head count that has no trade, nor a row that has only names: the save refuses both", () => {
    expect(workerTotal([row("Zedník", "5"), row("", "3")])).toEqual({ total: 5, incomplete: 1 });
    expect(workerTotal([row("", "", "Jan Novák")])).toEqual({ total: 0, incomplete: 1 });
  });
});

describe("workerTotalText", () => {
  it("says the total with the plural form that goes with it", () => {
    expect(workerTotalText({ total: 12, incomplete: 0 })).toBe("Celkem: 12 pracovníků");
    expect(workerTotalText({ total: 1, incomplete: 0 })).toBe("Celkem: 1 pracovník");
    expect(workerTotalText({ total: 3, incomplete: 0 })).toBe("Celkem: 3 pracovníci");
    expect(workerTotalText({ total: 0, incomplete: 0 })).toBe("Celkem: 0 pracovníků");
  });

  it("says that some rows are not counted, in the form of the number of rows", () => {
    expect(workerTotalText({ total: 5, incomplete: 1 })).toBe("Celkem: 5 pracovníků (u 1 profese chybí název nebo platný počet)");
    expect(workerTotalText({ total: 5, incomplete: 3 })).toBe("Celkem: 5 pracovníků (u 3 profesí chybí název nebo platný počet)");
    expect(workerTotalText({ total: 5, incomplete: 5 })).toBe("Celkem: 5 pracovníků (u 5 profesí chybí název nebo platný počet)");
  });
});
