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

// ---------------------------------------------------------------------------------------------------------------------------------
// What the source says. Every `.ts` and `.tsx` file of src/components and src/pages (tests excepted) is read, the string literals
// are taken out (comments are not text of the page), and each class in them is looked at.
// ---------------------------------------------------------------------------------------------------------------------------------

const srcDir = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(`${path}/`);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** The string literals of a source file, without its comments (a word in a comment is not a class). */
export function stringLiterals(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[\s;,{(])\/\/.*$/gm, "$1");
  return [...code.matchAll(/"([^"\n\\]*(?:\\.[^"\n\\]*)*)"|'([^'\n\\]*(?:\\.[^'\n\\]*)*)'|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

interface ParsedClass {
  /** The whole class as written, for the message of a failure. */
  written: string;
  /** The variants before the utility: `hover`, `sm`, `aria-invalid`. */
  variants: string[];
  family: string;
  /** What follows the family: `ink-muted` in `text-ink-muted/80`. */
  name: string;
}

// `border-l-success` is the left border in `success`: the side comes before the plain `border`, or `l-success` would be read as one name.
const FAMILIES = /^(bg|text|border-[xytblrse]|border|ring|outline|divide|placeholder)-([a-z0-9][a-z0-9-]*)(?:\/\d+)?$/;

function parseClass(written: string): ParsedClass | null {
  const parts = written.replace(/^!/, "").split(":");
  const utility = parts.pop() ?? "";
  const m = FAMILIES.exec(utility);
  return m ? { written, variants: parts, family: m[1], name: m[2] } : null;
}

const classesIn = (source: string): ParsedClass[] =>
  stringLiterals(source)
    .flatMap((literal) => literal.split(/\s+/))
    .filter((word) => /^[!a-z][a-z0-9:\-/[\].%]*$/.test(word))
    .map(parseClass)
    .filter((c): c is ParsedClass => c !== null);

/** The tokens of index.css: `--color-gray-300` and the like are Tailwind's palette, not ours. */
const ours = new Set([...tokens.keys()].filter((n) => !/^(gray|red|green|amber|blue|indigo|emerald|purple)-\d+$/.test(n)));

// What a colour family may be followed by when it is not a colour (`text-sm`, `border-solid`, `bg-cover`), or is a colour that is not ours.
const NOT_A_TOKEN: Record<string, RegExp> = {
  text: /^(xs|sm|base|lg|xl|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip|transparent|current|inherit|black|white)$/,
  bg: /^(none|auto|cover|contain|fixed|local|scroll|center|top|bottom|left|right|repeat|no-repeat|transparent|current|inherit|black|white|(clip|origin|blend|linear|radial|conic|gradient)-.+)$/,
  border: /^(x|y|t|b|l|r|s|e|solid|dashed|dotted|double|hidden|none|collapse|separate|spacing-.+|transparent|current|inherit|black|white)$/,
  ring: /^(inset|offset-.+|transparent|current|inherit|black|white)$/,
  outline: /^(none|dashed|dotted|double|solid|offset-.+|transparent|current|inherit|black|white)$/,
  divide: /^(x|y|x-reverse|y-reverse|solid|dashed|dotted|double|none|transparent|current|inherit|black|white)$/,
  placeholder: /^(transparent|current|inherit|black|white)$/,
};

describe("the class names in the source", () => {
  const files = [...sourceFiles(`${srcDir}components/`), ...sourceFiles(`${srcDir}pages/`)];
  const classes = new Map(files.map((file) => [file, classesIn(readFileSync(file, "utf8"))]));

  it("reads the files (and the helper that the shared components take their classes from)", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith("buttonClasses.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("uiClasses.ts"))).toBe(true);
    expect([...classes.values()].flat().length).toBeGreaterThan(500);
  });

  it("has no colour utility with a name that is neither one of the tokens nor a Tailwind keyword (a typo does nothing, silently)", () => {
    const unknown: string[] = [];
    for (const [file, list] of classes) {
      for (const c of list) {
        // A name with a digit is the palette (`gray-300`) or a size (`2xl`): Tailwind knows those, and a wrong one is not a token typo.
        if (/[0-9[]/.test(c.name)) continue;
        const keyword = NOT_A_TOKEN[c.family.startsWith("border") ? "border" : c.family];
        if (ours.has(c.name) || keyword.test(c.name)) continue;
        unknown.push(`${file.slice(srcDir.length)}: ${c.written}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("finds a typo (the check itself can fail)", () => {
    for (const typo of ['className="bg-primry text-surface"', 'cn("text-ink-mutd")', "`border-inpt`", "'hover:bg-primary-hovr'", '"border-l-sucess"']) {
      const found = classesIn(typo).filter((c) => !/[0-9[]/.test(c.name) && !ours.has(c.name) && !NOT_A_TOKEN[c.family.startsWith("border") ? "border" : c.family].test(c.name));
      expect(found.length, typo).toBe(1);
    }
    expect(stringLiterals("// bg-primry in a comment\n/* text-nope */ const a = 1;")).toEqual([]);
  });

  // The pairs the components really put together, read from their class strings instead of a list somebody has to keep up.
  //   - in one string, `text-X` goes with `bg-Y`; a `hover:` or `disabled:` or `aria-invalid:` or `placeholder:` class is judged in its own
  //     state, falling back to the plain one for what it does not set;
  //   - a text colour with no background of its own sits on the surface or on the page, and has to read on both;
  //   - a border in one of our colours is a boundary and has to be 3:1 on both, unless it is the decorative `line`.
  const STATES = new Set(["hover", "focus", "focus-visible", "active", "disabled", "aria-invalid", "placeholder"]);

  interface Pair {
    where: string;
    state: string;
    fg: string;
    bg: string | null;
  }

  function pairsIn(literal: string): { text: Pair[]; borders: string[] } {
    const byState = new Map<string, { text?: string; bg?: string }>();
    const borders: string[] = [];
    for (const word of literal.split(/\s+/)) {
      const c = parseClass(word);
      if (!c || !ours.has(c.name)) continue;
      const state = c.variants.filter((v) => STATES.has(v)).join(":");
      const slot = byState.get(state) ?? {};
      if (c.family === "text") slot.text = c.name;
      else if (c.family === "bg") slot.bg = c.name;
      else if (c.family.startsWith("border") && c.name !== "line") borders.push(c.name);
      byState.set(state, slot);
    }
    const base = byState.get("") ?? {};
    const text: Pair[] = [];
    for (const [state, slot] of byState) {
      const fg = slot.text ?? (state === "placeholder" ? undefined : base.text);
      const bg = slot.bg ?? base.bg;
      // a state that only sets a background (`hover:bg-x`) is judged with the plain text colour on it, and the reverse
      if (fg && (slot.text || slot.bg || state === "")) text.push({ where: literal, state: state || "plain", fg, bg: bg ?? null });
    }
    return { text, borders };
  }

  it("every text colour reads (4.5:1) on the background it is used on, in every state", () => {
    const failures: string[] = [];
    let checked = 0;
    for (const [file, source] of files.map((f) => [f, readFileSync(f, "utf8")] as const)) {
      for (const literal of stringLiterals(source)) {
        for (const pair of pairsIn(literal).text) {
          const backgrounds = pair.bg ? [pair.bg] : ["surface", "page"];
          for (const bg of backgrounds) {
            // `text-current`, palette colours and the like are not tokens: only token pairs are judged
            if (!tokens.has(pair.fg) || !tokens.has(bg)) continue;
            checked++;
            const r = ratio(pair.fg, bg);
            if (r < AA_TEXT) failures.push(`${file.slice(srcDir.length)} [${pair.state}] text-${pair.fg} on bg-${bg}: ${r.toFixed(2)}:1 in "${pair.where}"`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(30);
    expect(failures).toEqual([]);
  });

  it("every border in one of our colours is a visible boundary (3:1) on the surface and on the page", () => {
    const failures: string[] = [];
    let checked = 0;
    for (const [file, source] of files.map((f) => [f, readFileSync(f, "utf8")] as const)) {
      for (const literal of stringLiterals(source)) {
        for (const name of pairsIn(literal).borders) {
          for (const bg of ["surface", "page"]) {
            checked++;
            const r = ratio(name, bg);
            if (r < AA_BOUNDARY) failures.push(`${file.slice(srcDir.length)} border-${name} on ${bg}: ${r.toFixed(2)}:1 in "${literal}"`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
    expect(failures).toEqual([]);
  });

  it("finds a pair that does not read (the check itself can fail)", () => {
    // white on the tinted warning background: 1.3:1
    const bad = pairsIn("bg-warning-soft text-surface").text;
    expect(bad.map((p) => ratio(p.fg, p.bg ?? "surface") < AA_TEXT)).toEqual([true]);
    // a hover colour is judged in its own state, against the plain text colour
    const hover = pairsIn("bg-surface text-ink hover:bg-ink").text;
    expect(hover.some((p) => p.state === "hover" && ratio(p.fg, p.bg ?? "surface") < AA_TEXT)).toBe(true);
    // a text colour alone sits on the surface or the page
    expect(pairsIn("text-ink-muted").text).toEqual([{ where: "text-ink-muted", state: "plain", fg: "ink-muted", bg: null }]);
    // the decorative line is not a boundary; any other colour of border is
    expect(pairsIn("border border-line").borders).toEqual([]);
    expect(pairsIn("border border-input hover:border-danger").borders).toEqual(["input", "danger"]);
  });
});
