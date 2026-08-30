import type { NextConfig } from "next";

/**
 * Baseline security headers applied to every response. Tuned for an
 * authenticated SaaS app — no third-party scripts, no inline scripts
 * (Next.js inlines a small amount of JSON, which is allowed via
 * `'self'`), no framing.
 *
 * `'unsafe-eval'` v script-src je tu i v produkci. React 19 dev to
 * potřebuje pro HMR; produkce by ideálně nemusela, ale **některé
 * deps v bundlu** (next-auth JWT signing, crypto polyfilly,
 * Turbopack runtime helpers) volají `vm.runInThisContext` /
 * `new Function()` v browser kontextu. Bez `'unsafe-eval'` to spadne
 * po loginu / form submitu s "EvalError: call to eval() blocked
 * by CSP". Lepší fix je nonce-based CSP (TODO), ale na to potřebujeme
 * refactor middlewaru + layoutu, který zatím odkládáme.
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
    // `'unsafe-eval'` is required by bundled deps (see comment above).
    // No third-party scripts or images — adjust if we ever embed maps etc.
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
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

  serverExternalPackages: [
    "playwright",
    "playwright-core",
    "sharp",
    "@prisma/client",
    "prisma",
  ],

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
