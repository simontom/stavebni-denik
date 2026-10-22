import { describe, expect, it } from "vitest";
import { CORE, SECTIONS, emptyProjectFields, limitOf, projectFieldsOf, projectFieldsProblem, projectPayload } from "./projectFields";

const allSpecs = [...CORE, ...SECTIONS.flatMap((s) => s.fields)];

describe("the fields of a project (the identification of the diary, příloha 12 part A)", () => {
  it("ask for the author's supervision, with the number of its authorisation (A e)", () => {
    const keys = allSpecs.map((s) => s.key);
    expect(keys).toContain("authorSupervisionName");
    expect(keys).toContain("authorSupervisionAuthorization");
    expect(allSpecs.find((s) => s.key === "authorSupervisionName")?.label).toBe("Autorský dozor projektanta");
  });

  it("have a form value, an empty value and a place in the request for every field that is asked", () => {
    const empty = emptyProjectFields();
    const payload = projectPayload(empty);
    for (const spec of allSpecs) {
      expect(Object.keys(empty)).toContain(spec.key);
      expect(Object.keys(payload)).toContain(spec.key);
    }
    expect(Object.keys(empty).sort()).toEqual(Object.keys(payload).sort());
  });

  it("send what is empty as nothing and what is typed trimmed, and read a project back into the form", () => {
    const values = { ...emptyProjectFields(), name: "Stavba", authorSupervisionName: "  Ing. arch. Petr Dozor ", authorSupervisionAuthorization: "  " };
    const payload = projectPayload(values);
    expect(payload.authorSupervisionName).toBe("Ing. arch. Petr Dozor");
    expect(payload.authorSupervisionAuthorization).toBeNull();
    const back = projectFieldsOf({ name: "Stavba", authorSupervisionName: "Ing. arch. Petr Dozor", authorSupervisionAuthorization: null });
    expect(back.authorSupervisionName).toBe("Ing. arch. Petr Dozor");
    expect(back.authorSupervisionAuthorization).toBe("");
  });

  it("limit the author's supervision like the server does: 500 characters for who, 200 for the authorisation", () => {
    const base = { ...emptyProjectFields(), name: "S", address: "A", cadastralArea: "K", parcelNumbers: "1", builder: "B", contractor: "Z" };
    const who = allSpecs.find((s) => s.key === "authorSupervisionName")!;
    const number = allSpecs.find((s) => s.key === "authorSupervisionAuthorization")!;
    expect(limitOf(who)).toBe(500);
    expect(limitOf(number)).toBe(200);
    expect(projectFieldsProblem({ ...base, authorSupervisionName: "x".repeat(500), authorSupervisionAuthorization: "y".repeat(200) })).toBeNull();
    expect(projectFieldsProblem({ ...base, authorSupervisionName: "x".repeat(501) })).toContain("Autorský dozor projektanta");
    expect(projectFieldsProblem({ ...base, authorSupervisionAuthorization: "y".repeat(201) })).toContain("Číslo autorizace autorského dozoru");
  });
});
