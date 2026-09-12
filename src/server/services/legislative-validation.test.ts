import { describe, expect, it } from "vitest";
import {
  createHandoverSchema,
  authorizedPersonSchema,
  projectMemberRoleSchema,
} from "./legislative-validation";

describe("legislative-validation — projectMemberRoleSchema", () => {
  it("accepts valid project roles including INVESTOR", () => {
    expect(projectMemberRoleSchema.parse("BOSS")).toBe("BOSS");
    expect(projectMemberRoleSchema.parse("WORKER")).toBe("WORKER");
    expect(projectMemberRoleSchema.parse("INSPECTOR")).toBe("INSPECTOR");
    expect(projectMemberRoleSchema.parse("INVESTOR")).toBe("INVESTOR");
  });

  it("rejects unknown or invalid roles", () => {
    expect(() => projectMemberRoleSchema.parse("ADMIN")).toThrow();
    expect(() => projectMemberRoleSchema.parse("GUEST")).toThrow();
    expect(() => projectMemberRoleSchema.parse("")).toThrow();
  });
});

describe("legislative-validation — createHandoverSchema", () => {
  it("validates and parses complete handover data with meter states", () => {
    const raw = {
      type: "Předání staveniště zhotoviteli",
      date: "2026-09-11",
      participants: "Ing. Jan Novák (objednatel), Petr Svoboda (zhotovitel)",
      meterStates: JSON.stringify([
        { name: "Elektřina VT", number: "12345", value: "100 kWh" },
        { name: "Voda", number: "VOD-99", value: "45 m3" },
      ]),
      notes: "Staveniště předáno bez závad.",
    };

    const parsed = createHandoverSchema.parse(raw);
    expect(parsed.type).toBe("Předání staveniště zhotoviteli");
    expect(parsed.date).toBeInstanceOf(Date);
    expect(parsed.participants).toBe(raw.participants);
    expect(parsed.meterStates).toEqual([
      { name: "Elektřina VT", number: "12345", value: "100 kWh" },
      { name: "Voda", number: "VOD-99", value: "45 m3" },
    ]);
    expect(parsed.notes).toBe("Staveniště předáno bez závad.");
  });

  it("requires type, date, and participants", () => {
    expect(() =>
      createHandoverSchema.parse({
        type: "",
        date: "2026-09-11",
        participants: "A, B",
      }),
    ).toThrow();

    expect(() =>
      createHandoverSchema.parse({
        type: "Předání",
        date: "invalid-date",
        participants: "A, B",
      }),
    ).toThrow();

    expect(() =>
      createHandoverSchema.parse({
        type: "Předání",
        date: "2026-09-11",
        participants: "",
      }),
    ).toThrow();
  });

  it("handles null or empty meterStates gracefully", () => {
    const parsed = createHandoverSchema.parse({
      type: "Dílčí předání",
      date: "2026-09-11",
      participants: "Účastníci",
      meterStates: "",
    });
    expect(parsed.meterStates).toBeNull();
  });
});

describe("legislative-validation — authorizedPersonSchema", () => {
  it("validates external person data", () => {
    const valid = authorizedPersonSchema.parse({
      name: "Ing. Arch. Petr Černý",
      company: "Architekti s.r.o.",
      authorization: "Autorský dozor projektanta",
    });
    expect(valid.name).toBe("Ing. Arch. Petr Černý");
    expect(valid.company).toBe("Architekti s.r.o.");
    expect(valid.authorization).toBe("Autorský dozor projektanta");
  });

  it("requires non-empty name and trims inputs", () => {
    expect(() => authorizedPersonSchema.parse({ name: "   " })).toThrow();
    const trimmed = authorizedPersonSchema.parse({
      name: "  Jan Novák  ",
      company: "  ",
      authorization: " Dozor ",
    });
    expect(trimmed.name).toBe("Jan Novák");
    expect(trimmed.company).toBeUndefined();
    expect(trimmed.authorization).toBe("Dozor");
  });
});
