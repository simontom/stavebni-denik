/** The password rules, as the server enforces them (PasswordPolicy.kt); shown as a live checklist. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

/** A login name shorter than this is not looked for in a password (same as the server). */
const MIN_NICKNAME_LENGTH_CHECKED = 3;

export interface PasswordRule {
  label: string;
  ok: boolean;
}

/**
 * Base words (letters only, lower case, no diacritics) refused whatever digits and symbols surround them.
 * Keep in step with COMMON_BASE_WORDS in PasswordPolicy.kt; the server is authoritative, this only gives early feedback.
 */
const COMMON_BASE_WORDS: ReadonlySet<string> = new Set([
  "password",
  "passwrd",
  "psswrd",
  "heslo",
  "hesloheslo",
  "qwerty",
  "qwertz",
  "qwertyuiop",
  "qwertzuiop",
  "asdfgh",
  "asdfghjkl",
  "zxcvbn",
  "zxcvbnm",
  "abcdefgh",
  "abcdefghijkl",
  "admin",
  "administrator",
  "letmein",
  "welcome",
  "iloveyou",
  "monkey",
  "dragon",
  "master",
  "login",
  "secret",
  "changeme",
  "stavba",
  "stavebni",
  "stavebnidenik",
  "denik",
  "bagr",
  "ceskarepublika",
  "cesko",
  "praha",
  "brno",
  "ostrava",
  "sparta",
  "slavia",
  "fotbal",
  "hokej",
  "miluji",
  "miluju",
  "jaro",
  "leto",
  "podzim",
  "zima",
]);

/** Lower case, no diacritics, only a-z. */
function lettersOnly(value: string): string {
  return value
    .normalize("NFD")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

export function isCommonPassword(password: string): boolean {
  return COMMON_BASE_WORDS.has(lettersOnly(password));
}

function containsNickname(password: string, nickname: string | undefined): boolean {
  const name = nickname?.trim() ?? "";
  return name.length >= MIN_NICKNAME_LENGTH_CHECKED && password.toLowerCase().includes(name.toLowerCase());
}

export function passwordRules(password: string, nickname?: string): PasswordRule[] {
  return [
    { label: `Alespoň ${MIN_PASSWORD_LENGTH} znaků`, ok: password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH },
    { label: "Malé písmeno", ok: /[a-z]/.test(password) },
    { label: "Velké písmeno", ok: /[A-Z]/.test(password) },
    { label: "Číslice", ok: /[0-9]/.test(password) },
    { label: "Speciální znak", ok: /[^a-zA-Z0-9]/.test(password) },
    { label: "Není běžné ani snadno uhodnutelné", ok: !isCommonPassword(password) },
    { label: "Neobsahuje přihlašovací jméno", ok: !containsNickname(password, nickname) },
  ];
}
