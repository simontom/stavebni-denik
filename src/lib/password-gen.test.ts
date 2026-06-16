import { describe, expect, it } from "vitest";

import {
  DEFAULT_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  generatePassword,
  validatePasswordPolicy,
} from "./password-gen";

describe("generatePassword", () => {
  it("defaults to DEFAULT_PASSWORD_LENGTH characters", () => {
    expect(generatePassword()).toHaveLength(DEFAULT_PASSWORD_LENGTH);
  });

  it("honours a custom length at or above the minimum", () => {
    expect(generatePassword(20)).toHaveLength(20);
    expect(generatePassword(MIN_PASSWORD_LENGTH)).toHaveLength(
      MIN_PASSWORD_LENGTH,
    );
  });

  it("throws below the minimum length", () => {
    expect(() => generatePassword(MIN_PASSWORD_LENGTH - 1)).toThrow();
  });

  it("always satisfies the policy and avoids ambiguous characters", () => {
    for (let i = 0; i < 200; i++) {
      const pw = generatePassword();
      expect(validatePasswordPolicy(pw)).toEqual([]);
      // No visually ambiguous characters (i, l, o, I, L, O, 0, 1).
      expect(pw).not.toMatch(/[iloILO01]/);
    }
  });

  it("produces different passwords across calls", () => {
    const set = new Set(Array.from({ length: 50 }, () => generatePassword()));
    expect(set.size).toBe(50);
  });
});

describe("validatePasswordPolicy", () => {
  it("returns no issues for a compliant password", () => {
    expect(validatePasswordPolicy("Abcd3fgh!jkmn")).toEqual([]);
  });

  it("flags too-short passwords", () => {
    expect(validatePasswordPolicy("Ab3!").length).toBeGreaterThan(0);
  });

  it("flags each missing character class", () => {
    expect(validatePasswordPolicy("abcdefghijkl")).toContain(
      "Heslo musí obsahovat alespoň jedno velké písmeno.",
    );
    expect(validatePasswordPolicy("ABCDEFGHIJKL")).toContain(
      "Heslo musí obsahovat alespoň jedno malé písmeno.",
    );
    expect(validatePasswordPolicy("Abcdefghijkl")).toContain(
      "Heslo musí obsahovat alespoň jednu číslici.",
    );
    expect(validatePasswordPolicy("Abcdefghijk3")).toContain(
      "Heslo musí obsahovat alespoň jeden speciální znak.",
    );
  });
});
