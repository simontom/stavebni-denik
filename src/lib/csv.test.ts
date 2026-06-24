import { describe, expect, it } from "vitest";

import { csvField, csvRow, CSV_BOM } from "./csv";

describe("csvField — RFC 4180 escaping", () => {
  it("returns empty string for null/undefined", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("returns plain value when no special chars", () => {
    expect(csvField("hello")).toBe("hello");
    expect(csvField(42)).toBe("42");
    expect(csvField(true)).toBe("true");
  });

  it("wraps in quotes when field contains a comma", () => {
    expect(csvField("a, b")).toBe('"a, b"');
  });

  it("wraps and doubles inner quotes", () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it("wraps when field contains CR or LF", () => {
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
    expect(csvField("line1\r\nline2")).toBe('"line1\r\nline2"');
  });

  it("handles Czech diacritics without altering bytes", () => {
    // Cesky diakritika — fungovat musi bez escapování, BOM zajisti
    // Excel/Sheets aby správně detekly UTF-8.
    expect(csvField("Žluťoučký kůň úpěl")).toBe("Žluťoučký kůň úpěl");
  });

  it("prefixes formula-injection payloads with a single quote", () => {
    // Leading =, +, -, @, tab or CR would be executed as a formula.
    expect(csvField("=1+1")).toBe("'=1+1");
    expect(csvField("+1")).toBe("'+1");
    expect(csvField("-1")).toBe("'-1");
    expect(csvField("@SUM(A1)")).toBe("'@SUM(A1)");
    // A leading tab is also a formula trigger; it gets the quote prefix
    // (and a bare tab needs no RFC 4180 quoting).
    expect(csvField("\tx")).toBe("'\tx");
  });

  it("combines the formula guard with RFC 4180 quoting", () => {
    // `=cmd|...,x` is both a formula AND contains a comma → guard prefix
    // first, then wrap the whole cell in quotes.
    expect(csvField("=cmd,x")).toBe(`"'=cmd,x"`);
  });

  it("does not touch safe values that merely contain the chars", () => {
    // Only a LEADING dangerous char triggers the guard.
    expect(csvField("a=b")).toBe("a=b");
    expect(csvField("1-2")).toBe("1-2");
  });
});

describe("csvRow", () => {
  it("joins fields with commas and terminates with CRLF", () => {
    expect(csvRow(["a", "b", "c"])).toBe("a,b,c\r\n");
  });

  it("escapes each field independently", () => {
    expect(csvRow(["a,b", 'c"d', "e\nf"])).toBe('"a,b","c""d","e\nf"\r\n');
  });

  it("empty array → just CRLF", () => {
    expect(csvRow([])).toBe("\r\n");
  });
});

describe("CSV_BOM", () => {
  it("is the U+FEFF code point", () => {
    expect(CSV_BOM).toBe("\uFEFF");
    expect(CSV_BOM.length).toBe(1);
    expect(CSV_BOM.charCodeAt(0)).toBe(0xfeff);
  });
});
