/**
 * Centralized environment variable access.
 *
 * - Throws at boot if a required variable is missing, so misconfigured
 *   deploys fail fast instead of silently mis-routing photo uploads
 *   or audit-log entries.
 * - All consumers go through `env` so we have a single place to add
 *   schema validation (zod) once we adopt it in Stage 2.
 */

const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    // Tolerate missing vars during `next build` — Next.js executes
    // server modules at build time even though the values will only
    // exist at runtime in production.
    if (isBuildPhase) return "";
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `See .env.example for the full list.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

/**
 * Lazy environment accessor. Each property is read on first access so
 * that the throw-on-missing happens at request time, not at module load.
 */
export const env = {
  isBuildPhase,
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  get authSecret() {
    return required("AUTH_SECRET");
  },
  get authUrl() {
    return optional("AUTH_URL", "http://localhost:3000");
  },
  get dataDir() {
    return optional("DATA_DIR", "/data");
  },
  get openMeteoBase() {
    return optional("OPEN_METEO_BASE", "https://api.open-meteo.com/v1");
  },
  get appName() {
    return optional("NEXT_PUBLIC_APP_NAME", "Stavební deník");
  },
  get timezone() {
    return optional("TZ", "Europe/Prague");
  },
};
