import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

/**
 * Baseline security headers applied to every response. Tuned for an
 * authenticated SaaS app — no third-party scripts, no inline scripts
 * (Next.js inlines a small amount of JSON, which is allowed via
 * `'self'`), no framing.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    // The app only ever uses camera/geo on the phone for photo upload
    // (Stage 5). Block everything else by default; we'll add the
    // explicit per-route allowance when we ship the upload flow.
    value: "camera=(self), geolocation=(self), microphone=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Content-Security-Policy",
    // `'unsafe-inline'` on style covers Tailwind's CSS-variables injection.
    // No third-party scripts or images — adjust if we ever embed maps etc.
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https://api.open-meteo.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  // `standalone` produces a tiny self-contained server in `.next/standalone/`,
  // ideal for the multi-stage Docker image (no node_modules at runtime).
  output: "standalone",

  // We live inside the slack/ workspace alongside other projects. Pin the
  // tracing root explicitly so Next doesn't try to follow lockfiles
  // upwards or pull files from sibling repos into the build trace.
  outputFileTracingRoot: __dirname,

  // sharp, pg, prisma, playwright are on Next's default external list as of
  // v15+, so we don't need to repeat them here. Add custom natives if/when
  // they appear.

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

/**
 * Wrap the config with Sentry so production builds upload source maps
 * (translating minified server stack traces back to TS lines) and
 * automatically tree-shake debug logger calls.
 *
 * The wrapper is a no-op unless `SENTRY_AUTH_TOKEN` is present — local
 * `pnpm dev`/`pnpm build` and CI runs without secrets stay quiet.
 * Required when uploading: `SENTRY_ORG`, `SENTRY_PROJECT`,
 * `SENTRY_AUTH_TOKEN`. Optional: `SENTRY_RELEASE` (commit SHA).
 */
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Hide source uploads from the public bundle directory (we still
  // ship `*.map` files into Sentry, but not into `.next/static`).
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
  // Quieter build output unless we're explicitly debugging.
  silent: !process.env.CI,
  // Skip the whole plugin (no init network call, no validation
  // warning) when the auth token is missing.
  disableLogger: true,
  telemetry: false,
  release: { name: process.env.SENTRY_RELEASE },
});
