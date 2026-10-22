import { afterEach, describe, expect, it } from "vitest";
import { formatDay, formatDayWithWeekday, formatPragueDateTime, weekdayOf } from "./dates";

describe("formatDay", () => {
  it("writes a day as a Czech document does, without leading zeros", () => {
    expect(formatDay("2026-09-28")).toBe("28. 9. 2026");
    expect(formatDay("2026-01-05")).toBe("5. 1. 2026");
    expect(formatDay("2024-02-29")).toBe("29. 2. 2024");
    expect(formatDay("2026-12-31")).toBe("31. 12. 2026");
  });

  it("gives back what is not a real calendar day, unchanged", () => {
    for (const bad of ["", "abc", "2026-02-30", "2026-13-01", "2026-00-10", "2023-02-29", "2026-9-28", "2026-09-28T10:00:00Z", "0099-01-01"]) {
      expect(formatDay(bad), bad).toBe(bad);
    }
  });
});

describe("weekdayOf", () => {
  it("names the day of the week, short and long, for a whole week", () => {
    const week = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
    expect(week.map((d) => weekdayOf(d))).toEqual(["po", "út", "st", "čt", "pá", "so", "ne"]);
    expect(week.map((d) => weekdayOf(d, "long"))).toEqual(["pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota", "neděle"]);
  });

  it("knows the leap day, the turn of the year and a distant day", () => {
    expect(weekdayOf("2024-02-29")).toBe("čt");
    expect(weekdayOf("2026-12-31")).toBe("čt");
    expect(weekdayOf("2027-01-01")).toBe("pá");
    expect(weekdayOf("2000-01-01")).toBe("so");
  });

  it("is empty for what is not a day", () => {
    expect(weekdayOf("")).toBe("");
    expect(weekdayOf("2026-02-30")).toBe("");
  });
});

describe("formatDayWithWeekday", () => {
  it("puts the weekday before the date", () => {
    expect(formatDayWithWeekday("2026-09-28")).toBe("po 28. 9. 2026");
    expect(formatDayWithWeekday("2026-10-04")).toBe("ne 4. 10. 2026");
    expect(formatDayWithWeekday("2026-09-28", "long")).toBe("pondělí 28. 9. 2026");
  });

  it("gives back what is not a day, unchanged", () => {
    expect(formatDayWithWeekday("2026-02-30")).toBe("2026-02-30");
    expect(formatDayWithWeekday("nonsense")).toBe("nonsense");
  });
});

describe("a calendar day does not depend on the time zone of the device", () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it("is the same day, the same weekday and the same moment in Prague in every zone", () => {
    const seen = new Set<number>();
    for (const zone of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati", "Asia/Tokyo", "Pacific/Pago_Pago", "Europe/Prague"]) {
      process.env.TZ = zone;
      // The guard: the zone really changed (otherwise this test would pass without testing anything).
      seen.add(new Date("2026-09-28T12:00:00Z").getHours());
      expect(formatDayWithWeekday("2026-09-28"), zone).toBe("po 28. 9. 2026");
      expect(formatDayWithWeekday("2026-10-04", "long"), zone).toBe("neděle 4. 10. 2026");
      expect(formatPragueDateTime("2026-09-28T22:05:00Z"), zone).toBe("29. 9. 2026 00:05:00 SELČ (UTC+2)");
    }
    expect(seen.size, "the process really took on the other time zones").toBeGreaterThan(3);
  });
});

describe("formatPragueDateTime", () => {
  it("prints Prague time with its zone, as the PDF does", () => {
    expect(formatPragueDateTime("2026-09-28T12:32:07.123Z")).toBe("28. 9. 2026 14:32:07 SELČ (UTC+2)");
    expect(formatPragueDateTime("2026-11-02T12:32:07Z")).toBe("2. 11. 2026 13:32:07 SEČ (UTC+1)");
  });

  it("takes an instant with an offset, and one without seconds, as the server writes them", () => {
    expect(formatPragueDateTime("2026-09-28T14:32:07+02:00")).toBe("28. 9. 2026 14:32:07 SELČ (UTC+2)");
    expect(formatPragueDateTime("2026-09-28T12:32Z")).toBe("28. 9. 2026 14:32:00 SELČ (UTC+2)");
    expect(formatPragueDateTime("2026-09-28T12:32:07.123456Z")).toBe("28. 9. 2026 14:32:07 SELČ (UTC+2)");
  });

  it("is on the next day in Prague when it is late in the evening in UTC", () => {
    expect(formatPragueDateTime("2026-09-28T22:05:00Z")).toBe("29. 9. 2026 00:05:00 SELČ (UTC+2)");
    expect(formatPragueDateTime("2026-12-31T23:59:59Z")).toBe("1. 1. 2027 00:59:59 SEČ (UTC+1)");
  });

  it("changes the zone at the moment the clocks change", () => {
    expect(formatPragueDateTime("2026-10-25T00:59:59Z")).toBe("25. 10. 2026 02:59:59 SELČ (UTC+2)");
    expect(formatPragueDateTime("2026-10-25T01:00:00Z")).toBe("25. 10. 2026 02:00:00 SEČ (UTC+1)");
    expect(formatPragueDateTime("2026-03-29T00:59:59Z")).toBe("29. 3. 2026 01:59:59 SEČ (UTC+1)");
    expect(formatPragueDateTime("2026-03-29T01:00:00Z")).toBe("29. 3. 2026 03:00:00 SELČ (UTC+2)");
  });

  it("gives back what is not a moment, unchanged", () => {
    expect(formatPragueDateTime("nonsense")).toBe("nonsense");
    expect(formatPragueDateTime("")).toBe("");
  });
});
