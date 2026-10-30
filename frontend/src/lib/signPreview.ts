import { ROLE_LABELS } from "./api";
import { formatDay } from "./dates";
import { CORE, SECTIONS, type FieldSpec } from "./projectFields";

/**
 * What the sign dialog shows before the password (backlog C2b): part A of the diary as the server would freeze it now (příloha 12 A:
 * the identification, the persons and the authorised persons), with the SHA-256 of that text. The server answers
 * `GET …/sign-preview` with exactly the data it would store (`PartASnapshot.take`), and the sign request names the digest back
 * (`expectedPartASha256`): a part A that is different when the request is handled is `409 STALE_VERSION`.
 *
 * The keys are those of the signed text and are never renamed (a key is part of what a signature covers). Everything here is wording:
 * the labels of the identification are the ones of the project form (`projectFields.ts`), so the screen says the same everywhere.
 */
export interface PartAPerson {
  userId: string;
  name: string;
  ckaitNumber: string | null;
}

/** A member who ensures the technical management of the works (BOSS) or supervises them (INSPECTOR), with the scope of their authorisation and responsibility. */
export interface PartAMember extends PartAPerson {
  role: string;
  scope: string | null;
}

/** A person who may make entries in the diary (§ 166 odst. 2), with their function. */
export interface PartAAuthorizedPerson {
  id: string;
  name: string;
  company: string | null;
  authorization: string | null;
}

export interface PartA {
  identification: Record<string, string | null>;
  siteManager: PartAPerson;
  members: PartAMember[];
  authorizedPersons: PartAAuthorizedPerson[];
  projectId: string;
}

export interface SignPreview {
  /** The SHA-256 of the canonical text of [partA] (64 lower-case hex characters). */
  partASha256: string;
  partA: PartA;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a body is a preview as the server sends it: a body that is not must never be drawn (and never be signed on). */
export function isSignPreview(value: unknown): value is SignPreview {
  if (!isRecord(value) || typeof value.partASha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.partASha256)) return false;
  const partA = value.partA;
  return (
    isRecord(partA) &&
    isRecord(partA.identification) &&
    isRecord(partA.siteManager) &&
    typeof partA.siteManager.name === "string" &&
    Array.isArray(partA.members) &&
    Array.isArray(partA.authorizedPersons)
  );
}

/** The first eight characters of a digest and an ellipsis: enough to recognise it, short enough to read out. */
export const shortDigest = (digest: string): string => `${digest.slice(0, 8)}…`;

/** "ČKAIT 0012345", or what is said when the person has no number. */
export const ckaitText = (number: string | null | undefined): string => (number ? `ČKAIT ${number}` : "bez čísla ČKAIT");

// ---- the identification, in the words of the form -------------------------------------------------

const SPECS: FieldSpec[] = [...CORE, ...SECTIONS.flatMap((section) => section.fields)];

/** The label of a key of the identification, as the project form words it. A key the screen does not know is shown as it is. */
export const labelOfIdentificationKey = (key: string): string => SPECS.find((spec) => spec.key === key)?.label ?? key;

/** The keys of the identification that the screen knows, in the order of the form (= the order of the signed text). */
export const IDENTIFICATION_KEYS: string[] = SPECS.map((spec) => spec.key);

export interface PartAFact {
  key: string;
  label: string;
  /** What the project says, as a person reads it; null for what was not entered. */
  value: string | null;
  /** A list (one firm or document per line): the lines are kept. */
  multiline: boolean;
}

export interface PartAPersonRow {
  name: string;
  ckait: string;
  /** The scope of the authorisation and responsibility; null when it was not entered. */
  scope: string | null;
  isSiteManager: boolean;
}

export interface PartAAuthorizedRow {
  name: string;
  company: string | null;
  function: string | null;
}

export interface PartAView {
  facts: PartAFact[];
  siteManager: { name: string; ckait: string };
  /** BOSS members: the persons who ensure the technical management of the works. */
  managers: PartAPersonRow[];
  /** INSPECTOR members: technical supervision of the client, author's supervision. */
  supervisors: PartAPersonRow[];
  authorizedPersons: PartAAuthorizedRow[];
}

const blank = (value: string | null | undefined): string | null => (value && value.trim() !== "" ? value : null);

/** Part A as the sign dialog reads it out: every field the signature covers, in the order of the form, nothing left out because it is empty. */
export function viewOf(partA: PartA): PartAView {
  const facts: PartAFact[] = SPECS.map((spec) => {
    const raw = blank(partA.identification[spec.key]);
    return {
      key: spec.key,
      label: spec.label,
      value: raw === null ? null : spec.type === "date" ? formatDay(raw) : raw,
      multiline: spec.type === "textarea",
    };
  });
  const row = (member: PartAMember): PartAPersonRow => ({
    name: member.name,
    ckait: ckaitText(member.ckaitNumber),
    scope: blank(member.scope),
    isSiteManager: member.userId === partA.siteManager.userId,
  });
  return {
    facts,
    siteManager: { name: partA.siteManager.name, ckait: ckaitText(partA.siteManager.ckaitNumber) },
    managers: partA.members.filter((m) => m.role === "BOSS").map(row),
    supervisors: partA.members.filter((m) => m.role === "INSPECTOR").map(row),
    authorizedPersons: partA.authorizedPersons.map((p) => ({ name: p.name, company: blank(p.company), function: blank(p.authorization) })),
  };
}

// ---- what changed ---------------------------------------------------------------------------------

const MEMBER_FIELDS: { key: keyof PartAMember; label: string }[] = [
  { key: "name", label: "jméno" },
  { key: "role", label: "role" },
  { key: "ckaitNumber", label: "číslo ČKAIT" },
  { key: "scope", label: "rozsah oprávnění a odpovědnosti" },
];

const AUTHORIZED_FIELDS: { key: keyof PartAAuthorizedPerson; label: string }[] = [
  { key: "name", label: "jméno" },
  { key: "company", label: "organizace" },
  { key: "authorization", label: "funkce, rozsah pověření" },
];

const same = (a: string | null | undefined, b: string | null | undefined): boolean => (a ?? null) === (b ?? null);

/**
 * What differs between the part A that was shown and the one that is there now, in words: the fields of the identification by their
 * labels, and the persons by name. Empty when nothing differs (the digest says so too). A short list: it is read in a dialog.
 */
export function describeChanges(before: PartA, after: PartA): string[] {
  const changes: string[] = [];

  const keys = [...new Set([...IDENTIFICATION_KEYS, ...Object.keys(before.identification), ...Object.keys(after.identification)])];
  const fields = keys.filter((key) => !same(blank(before.identification[key]), blank(after.identification[key])));
  if (fields.length > 0) changes.push(`Údaje o stavbě: ${fields.map(labelOfIdentificationKey).join(", ")}`);

  const [was, is] = [before.siteManager, after.siteManager];
  if (was.userId !== is.userId || !same(was.name, is.name) || !same(was.ckaitNumber, is.ckaitNumber)) changes.push("Hlavní stavbyvedoucí");

  for (const member of after.members) {
    const old = before.members.find((m) => m.userId === member.userId);
    if (!old) {
      changes.push(`Přibyla osoba ${member.name} (${(ROLE_LABELS[member.role] ?? member.role).toLowerCase()})`);
      continue;
    }
    const differing = MEMBER_FIELDS.filter(({ key }) => !same(blank(old[key]), blank(member[key]))).map(({ label }) => label);
    if (differing.length > 0) changes.push(`Změna u osoby ${member.name}: ${differing.join(", ")}`);
  }
  for (const old of before.members) {
    if (!after.members.some((m) => m.userId === old.userId)) changes.push(`Ubyla osoba ${old.name}`);
  }

  for (const person of after.authorizedPersons) {
    const old = before.authorizedPersons.find((p) => p.id === person.id);
    if (!old) {
      changes.push(`Přibyla pověřená osoba ${person.name}`);
      continue;
    }
    const differing = AUTHORIZED_FIELDS.filter(({ key }) => !same(blank(old[key]), blank(person[key]))).map(({ label }) => label);
    if (differing.length > 0) changes.push(`Změna u pověřené osoby ${person.name}: ${differing.join(", ")}`);
  }
  for (const old of before.authorizedPersons) {
    if (!after.authorizedPersons.some((p) => p.id === old.id)) changes.push(`Ubyla pověřená osoba ${old.name}`);
  }

  return changes;
}
