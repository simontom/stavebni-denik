import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTION_LABELS, AUDIT_ENTITY_LABELS, auditActionLabel, auditEntityLabel } from "./auditLabels";

/** The audit viewer says what was done in Czech words and keeps the code beside them; a code the server writes and the list lacks would be shown in English. */
const services = fileURLToPath(new URL("../../../backend/src/main/kotlin/cz/stavebni/denik/services/", import.meta.url));
const source = readdirSync(services)
  .filter((name) => name.endsWith(".kt"))
  .map((name) => readFileSync(`${services}${name}`, "utf8"))
  .join("\n");

describe("the words of the audit viewer", () => {
  it("name every action the server records", () => {
    const actions = [...new Set([...source.matchAll(/action = "([A-Za-z]+(?:\.[A-Za-z_]+)+)"/g)].map((m) => m[1]))];
    expect(actions.length, "the server's actions were found in its source").toBeGreaterThan(20);
    expect(actions.filter((action) => !(action in AUDIT_ACTION_LABELS))).toEqual([]);
  });

  it("name every kind of object the server records", () => {
    const kinds = [...new Set([...source.matchAll(/auditedWrite\(\s*[^,]+,\s*(?:entityType = )?"(\w+)"/g)].map((m) => m[1]))];
    expect(kinds.length).toBeGreaterThanOrEqual(5);
    expect(kinds.filter((kind) => !(kind in AUDIT_ENTITY_LABELS))).toEqual([]);
  });

  it("show a code that is not in the list as it is, and a known one in words", () => {
    expect(auditActionLabel("report.lock")).toBe("Podpis záznamu");
    expect(auditActionLabel("something.new")).toBe("something.new");
    expect(auditEntityLabel("siteHandover")).toBe("Protokol o předání");
    expect(auditEntityLabel("other")).toBe("other");
  });
});
