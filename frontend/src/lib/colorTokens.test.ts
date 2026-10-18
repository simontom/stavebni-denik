/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The files are read from disk: Vitest turns a stylesheet imported with `?raw` into an empty string.
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const css = read("../index.css");

/**
 * The colour tokens of the application (`@theme` in index.css) against WCAG 2.2 AA: text pairs at least 4.5:1 (1.4.3) and the
 * boundary of a field or a button at least 3:1 (1.4.11). The tokens are read from the stylesheet itself, so a change to one of
 * them that breaks the contrast fails here. (A Vitest test cannot see the real pixels: what is checked is the pairs that the
 * components in components/ui/ put together, listed below.)
 */

const AA_TEXT = 4.5;
const AA_BOUNDARY = 3;

type Rgb = [number, number, number];

/** `--color-<name>: #rrggbb;` of the `@theme` block, by name. */
function parseTokens(source: string): Map<string, Rgb> {
  const theme = /@theme\s*\{([\s\S]*?)\n\}/.exec(source);
  if (!theme) throw new Error("index.css has no @theme block");
  const tokens = new Map<string, Rgb>();
  for (const m of theme[1].matchAll(/--color-([a-z0-9-]+):\s*#([0-9a-fA-F]{6})\s*;/g)) {
    const n = parseInt(m[2], 16);
    tokens.set(m[1], [(n >> 16) & 255, (n >> 8) & 255, n & 255]);
  }
  return tokens;
}

/** Relative luminance (WCAG 2.2, 1.4.3). */
function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const tokens = parseTokens(css);
const token = (name: string): Rgb => {
  const value = tokens.get(name);
  if (!value) throw new Error(`index.css defines no --color-${name}`);
  return value;
};
const ratio = (fg: string, bg: string) => contrast(token(fg), token(bg));

describe("the contrast function", () => {
  it("knows the reference values", () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5);
    // #767676 on white is the darkest-needed gray of the WCAG examples: 4.54:1
    expect(contrast([0x76, 0x76, 0x76], [255, 255, 255])).toBeCloseTo(4.54, 2);
    // The three colours the review found too weak (backlog B3): gray-300 border, white on emerald-600, red-500 text.
    expect(contrast([0xd1, 0xd5, 0xdb], [255, 255, 255])).toBeCloseTo(1.47, 2);
    expect(contrast([255, 255, 255], [0x05, 0x96, 0x69])).toBeCloseTo(3.77, 2);
    expect(contrast([0xef, 0x44, 0x44], [255, 255, 255])).toBeCloseTo(3.76, 2);
  });

  it("reads every token from the stylesheet", () => {
    for (const name of ["page", "surface", "ink", "ink-muted", "line", "input", "focus", "primary", "danger", "success"]) {
      expect(tokens.has(name), name).toBe(true);
    }
  });
});

describe("text", () => {
  const body: [string, string][] = [
    // body text and secondary text on the surface of a card and on the page behind it
    ["ink", "surface"],
    ["ink", "page"],
    ["ink-muted", "surface"],
    ["ink-muted", "page"],
    ["ink-muted", "neutral-soft"],
    // links
    ["primary-ink", "surface"],
    ["primary-ink", "page"],
    ["primary-ink", "primary-soft"],
    // an error message, a warning, a confirmation: on the surface and on the tinted banner
    ["danger-ink", "surface"],
    ["danger-ink", "danger-soft"],
    ["success-ink", "surface"],
    ["success-ink", "success-soft"],
    ["warning-ink", "surface"],
    ["warning-ink", "warning-soft"],
    ["info-ink", "surface"],
    ["info-ink", "info-soft"],
    ["neutral-ink", "neutral-soft"],
  ];
  it.each(body)("%s on %s is at least 4.5:1", (fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  // white text on a solid background: every button
  const solid = ["primary", "primary-hover", "danger", "danger-hover", "success", "success-hover"];
  it.each(solid)("white text on %s is at least 4.5:1", (bg) => {
    expect(ratio("surface", bg)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("every tone that has a soft background has ink that reads on it and on the surface", () => {
    const tones = [...tokens.keys()].filter((n) => n.endsWith("-soft")).map((n) => n.slice(0, -"-soft".length));
    expect(tones.length).toBeGreaterThanOrEqual(5);
    for (const tone of tones) {
      expect(tokens.has(`${tone}-ink`), `${tone}-ink exists`).toBe(true);
      expect(ratio(`${tone}-ink`, `${tone}-soft`), `${tone}-ink on ${tone}-soft`).toBeGreaterThanOrEqual(AA_TEXT);
      expect(ratio(`${tone}-ink`, "surface"), `${tone}-ink on the surface`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});

describe("boundaries of fields and buttons, and the focus ring", () => {
  const boundaries: [string, string][] = [
    ["input", "surface"],
    ["input", "page"],
    ["input", "neutral-soft"],
    ["focus", "surface"],
    ["focus", "page"],
    // an accent line of a banner against the page
    ["warning", "surface"],
    ["info", "surface"],
    ["danger", "surface"],
  ];
  it.each(boundaries)("%s on %s is at least 3:1", (fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(AA_BOUNDARY);
  });

  it("the transitional gray-300 (still spelled by pages that are not converted yet) is a visible border too", () => {
    expect(ratio("gray-300", "surface")).toBeGreaterThanOrEqual(AA_BOUNDARY);
    expect(ratio("gray-300", "page")).toBeGreaterThanOrEqual(AA_BOUNDARY);
  });

  it("the decorative line may stay light: it carries no information", () => {
    // Documented, not required: this only fails if `line` was made as dark as a border, which would make every card heavy.
    expect(ratio("line", "surface")).toBeLessThan(AA_BOUNDARY);
  });
});

describe("the components use only tokens that exist", () => {
  const uiDir = fileURLToPath(new URL("../components/ui/", import.meta.url));
  const sources: Record<string, string> = Object.fromEntries(
    readdirSync(uiDir)
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => [f, readFileSync(`${uiDir}${f}`, "utf8")]),
  );
  // A semantic colour utility: `bg-danger-soft`, `text-ink-muted/80`, `border-input`, `hover:bg-primary-hover`
  const ours = new Set([...tokens.keys()].filter((n) => !/^(gray|red|green|amber|blue|indigo|emerald|purple)-\d+$/.test(n)));
  const prefixes = ["ink", "primary", "danger", "success", "warning", "info", "neutral", "surface", "page", "line", "input", "focus"];

  it("finds the components", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(0);
  });

  it("has no colour utility that names a token the stylesheet lacks (a typo would silently do nothing)", () => {
    const unknown: string[] = [];
    for (const [file, source] of Object.entries(sources)) {
      for (const m of source.matchAll(/\b(?:bg|text|border|ring|outline|divide|placeholder|fill|stroke|accent|caret)-([a-z]+(?:-[a-z]+)*)(?:\/\d+)?\b/g)) {
        const name = m[1];
        if (!prefixes.some((p) => name === p || name.startsWith(`${p}-`))) continue;
        if (!ours.has(name)) unknown.push(`${file}: ${m[0]}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});
