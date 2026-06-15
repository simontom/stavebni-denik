import { hash, verify } from "@node-rs/argon2";

/**
 * Password hashing parameters tuned for "interactive" use (login form).
 * The defaults follow the OWASP 2024 recommendation for argon2id:
 *   - 2 iterations
 *   - 19 MiB memory
 *   - parallelism 1
 *
 * Rationale: aimed at ~250 ms on a shared-cpu-1x Fly machine. Tweak
 * upwards once we deploy on more powerful hardware.
 *
 * `Algorithm` from `@node-rs/argon2` is an ambient `const enum` which
 * is incompatible with `isolatedModules`. We hard-code the numeric
 * value (Argon2id = 2) instead.
 */
const ARGON2_OPTS = {
  algorithm: 2 satisfies number, // Algorithm.Argon2id
  timeCost: 2,
  memoryCost: 19_456, // 19 MiB in KiB
  parallelism: 1,
} as const;

/**
 * Returns an argon2id-encoded password hash. Format includes salt + params,
 * so it's self-describing and safe to store directly in `User.passwordHash`.
 */
export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTS);
}

/**
 * Constant-time verification. Returns `false` (never throws) for any
 * malformed hash so login responses don't leak structural information
 * about stored hashes.
 */
export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<boolean> {
  try {
    return await verify(stored, plain);
  } catch {
    return false;
  }
}
