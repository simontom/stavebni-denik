import * as Sentry from "@sentry/nextjs";

/**
 * Sentry initialisation hook (Next.js instrumentation API).
 *
 * `register()` is called once per worker on first request — early enough
 * to catch errors from the very first route handler. Initialisation is
 * gated on `SENTRY_DSN`: when the env var is empty (local dev, CI),
 * Sentry is fully inactive, no network traffic, no overhead.
 *
 * `onRequestError` (Next.js 15+) hands Sentry the errors that escape
 * server components, route handlers and server actions; without it
 * Sentry only sees explicit `captureException` calls.
 */

function commonInit() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "production",
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: Number.parseFloat(
      process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1",
    ),
    // Do not ship potentially sensitive request bodies (passwords on
    // login, photo bytes on upload) to Sentry by default.
    sendDefaultPii: false,
  });
  return true;
}

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    commonInit();
  } else if (process.env.NEXT_RUNTIME === "edge") {
    commonInit();
  }
}

export const onRequestError = Sentry.captureRequestError;
