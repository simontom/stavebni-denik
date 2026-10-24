import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ROLE_LABELS } from "./api";

/**
 * The words of the interface (PROJECT.md, "Words of the interface"): one glossary, applied everywhere a person can read it.
 * The test parses the shipped source (every `.ts` and `.tsx` file of `src` that is not a test) and fails on a word the glossary
 * rules out and on an English label. What it looks at is what a person can see: the text between tags and the string
 * literals (attributes included: `placeholder`, `aria-label`, `title`). Comments, imports, type names, class lists and
 * `console` calls are not looked at, and nor is a string that is only a code (`"BOSS"` in `role === "BOSS"` is the key the
 * server uses and is never shown).
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(`${path}/`);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

interface Visible {
  file: string;
  line: number;
  text: string;
  /** Between tags (always shown), as against a literal (may be a code, a path). */
  jsx: boolean;
}

/** A class list: every word is a utility (`text-ink`, `md:grid-cols-2`, `w-[9rem]`) and at least one has a hyphen, a colon, a bracket or a slash. */
const isClassList = (text: string) => text.split(/\s+/).every((token) => /^[a-z0-9[\]:!/_.\-%#@&>*+(),']+$/.test(token)) && /[-:[/]/.test(text);

/** The text between tags and the string literals of one source file. */
function visibleStrings(file: string, source: string): Visible[] {
  const found: Visible[] = [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const add = (node: ts.Node, text: string, jsx: boolean) => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length < 3) return;
    found.push({ file: file.slice(SRC.length), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: clean, jsx });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isLiteralTypeNode(node)) return;
    if (ts.isCallExpression(node) && /^console\./.test(node.expression.getText(sf))) return;
    if (ts.isJsxAttribute(node) && /^(className|class)$/.test(node.name.getText(sf))) return;
    if (ts.isJsxText(node)) add(node, node.getText(sf), true);
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (!isClassList(node.text)) add(node, node.text, false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const files = sourceFiles(SRC);
const strings = files.flatMap((file) => visibleStrings(file, readFileSync(file, "utf8")));
const where = (v: Visible) => `${v.file}:${v.line}: ${v.text}`;

describe("the words of the interface", () => {
  it("scans the whole source (this test would pass on nothing otherwise)", () => {
    expect(files.length).toBeGreaterThan(30);
    expect(strings.length).toBeGreaterThan(500);
  });

  it("shows the roles in Czech", () => {
    expect(ROLE_LABELS).toEqual({ BOSS: "Stavbyvedoucí", WORKER: "Pracovník", INSPECTOR: "Technický dozor", INVESTOR: "Stavebník" });
  });

  it("never writes an English role name where a person reads it", () => {
    const bad = strings.filter((v) => /\b(BOSS|WORKER|INSPECTOR|INVESTOR)\b/.test(v.text) && (v.jsx || /\s/.test(v.text))).map(where);
    expect(bad).toEqual([]);
  });

  it("says stavebník, never investor", () => {
    // "INVESTOR" is the key the server uses for the role; "Investor" and any sentence that has the word in it are what a person would read
    expect(strings.filter((v) => /investor/i.test(v.text) && v.text !== "INVESTOR" && !/^INVESTOR_[A-Z]+$/.test(v.text)).map(where)).toEqual([]);
  });

  it("says záznam, never zápis (the entry, a late entry, the entries of other persons)", () => {
    expect(strings.filter((v) => /z[áÁ]pis/i.test(v.text)).map(where)).toEqual([]);
  });

  it("calls a day of inspection Kontrolní den", () => {
    expect(strings.filter((v) => /stavební kontrola/i.test(v.text)).map(where)).toEqual([]);
    expect(strings.some((v) => v.text === "Kontrolní den")).toBe(true);
  });

  it("has no English label (nor a code name in brackets after a Czech one)", () => {
    const english = /\b(the|and|failed|error|please|with|for|not|is|of|upload|loading|click|invalid|submit|cancel)\b/i;
    const bad = strings.filter((v) => /\s/.test(v.text) && english.test(v.text) && !/^\/|\$\{/.test(v.text)).map(where);
    expect(bad).toEqual([]);
    expect(strings.filter((v) => /\((nickname|displayName|password|login)\)/.test(v.text)).map(where)).toEqual([]);
  });

  it("says Audit, never 'audit log' (nor an inflected 'audit logu')", () => {
    expect(strings.filter((v) => /audit\s+log/i.test(v.text)).map(where)).toEqual([]);
  });

  it("never calls the stavbyvedoucí 'vedoucí projektu'", () => {
    expect(strings.filter((v) => /(?<!stavby)vedoucí(ho|m|mu)? projektu|(?<!stavby)vedoucích projektů/i.test(v.text)).map(where)).toEqual([]);
  });
});

/**
 * The messages of the server reach the person too (the refusal of a save is shown in the alert), so the same glossary holds for the
 * string literals of the backend: no English role name in a message, no "(BOSS)" after a Czech word, no zápis, no "vedoucí projektu".
 * Comments and the operator's command line (`cli/`, English by design) are not looked at; a literal that is only a code (`"BOSS"`) is the key.
 */
const BACKEND = fileURLToPath(new URL("../../../backend/src/main/kotlin/", import.meta.url));

function kotlinFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) return entry.name === "cli" ? [] : kotlinFiles(`${path}/`);
    return entry.name.endsWith(".kt") ? [path] : [];
  });
}

/** The ordinary string literals of a Kotlin file, with the line they start on (the comments are cut out first). */
function kotlinLiterals(file: string): Visible[] {
  const source = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
  const found: Visible[] = [];
  for (const m of source.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    found.push({ file: file.slice(BACKEND.length), line: source.slice(0, m.index).split("\n").length, text: m[1], jsx: false });
  }
  return found;
}

const backendStrings = kotlinFiles(BACKEND).flatMap(kotlinLiterals);

describe("the words of the server's messages", () => {
  it("scans the whole backend (this would pass on nothing otherwise)", () => {
    expect(backendStrings.length).toBeGreaterThan(1000);
  });

  it("never name a role in English where a person reads it", () => {
    const bad = backendStrings.filter((v) => /\s/.test(v.text) && /\b(BOSS|WORKER|INSPECTOR|INVESTOR)\b/.test(v.text) && !/\b(SELECT|INSERT|UPDATE|WHERE|FROM)\b/.test(v.text));
    expect(bad.map(where)).toEqual([]);
  });

  it("say záznam, stavebník and stavbyvedoucí", () => {
    expect(backendStrings.filter((v) => /z[áÁ]pis/i.test(v.text)).map(where)).toEqual([]);
    expect(backendStrings.filter((v) => /investor/i.test(v.text) && !/^[A-Z_]+$/.test(v.text)).map(where)).toEqual([]);
    expect(backendStrings.filter((v) => /(?<!stavby)vedoucí(ho|m|mu)? projektu|(?<!stavby)vedoucích projektů/i.test(v.text)).map(where)).toEqual([]);
  });
});
