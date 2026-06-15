import { randomInt } from "node:crypto";

/**
 * Cryptographically-secure password generator.
 *
 * Used by `BOSS` when creating WORKER / GUEST accounts — the generated
 * password is shown exactly once in the admin UI and stored only as
 * argon2id hash. The newly created user is forced to change it on first
 * login (`User.mustChangePwd = true`).
 *
 * Requirements (acceptance criteria):
 *  - >= 12 characters
 *  - Mix of uppercase, lowercase, digit, symbol
 *  - Uses `crypto.randomInt` (rejection-sampled, no modulo bias)
 *  - Avoids visually ambiguous characters (l/1/I, O/0) to ease verbal
 *    handoff on a building site.
 */

const LOWER = "abcdefghjkmnpqrstuvwxyz"; // no i, l, o
const UPPER = "ABCDEFGHJKMNPQRSTUVWXYZ"; // no I, L, O
const DIGIT = "23456789"; // no 0, 1
const SYMBOL = "!@#$%^&*-_=+?";
const ALPHABET = LOWER + UPPER + DIGIT + SYMBOL;

export const MIN_PASSWORD_LENGTH = 12;
export const DEFAULT_PASSWORD_LENGTH = 16;

function pick(source: string): string {
  return source[randomInt(0, source.length)];
}

/**
 * Fisher–Yates shuffle on a char array using `crypto.randomInt`.
 */
function shuffleChars(chars: string[]): string[] {
  const out = [...chars];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function generatePassword(length = DEFAULT_PASSWORD_LENGTH): string {
  if (length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password length must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  // Guarantee at least one of each class.
  const required: string[] = [pick(LOWER), pick(UPPER), pick(DIGIT), pick(SYMBOL)];
  const rest: string[] = [];
  for (let i = required.length; i < length; i++) {
    rest.push(pick(ALPHABET));
  }
  return shuffleChars([...required, ...rest]).join("");
}

/**
 * Validate that an arbitrary password meets the policy. Used by
 * `/first-password-change` and any other change-password flow.
 *
 * Returns a list of human-readable Czech messages — empty array means OK.
 */
export function validatePasswordPolicy(password: string): string[] {
  const issues: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) {
    issues.push(`Heslo musí mít alespoň ${MIN_PASSWORD_LENGTH} znaků.`);
  }
  if (!/[a-z]/.test(password)) {
    issues.push("Heslo musí obsahovat alespoň jedno malé písmeno.");
  }
  if (!/[A-Z]/.test(password)) {
    issues.push("Heslo musí obsahovat alespoň jedno velké písmeno.");
  }
  if (!/[0-9]/.test(password)) {
    issues.push("Heslo musí obsahovat alespoň jednu číslici.");
  }
  if (!/[^a-zA-Z0-9]/.test(password)) {
    issues.push("Heslo musí obsahovat alespoň jeden speciální znak.");
  }
  return issues;
}
