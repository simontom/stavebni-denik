// @ts-check
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

/**
 * Start the production server from a `next build` locally.
 *
 * `next.config.ts` sets `output: "standalone"`, so `next build` emits a
 * self-contained server at `.next/standalone/server.js`. Two important
 * gotchas (see the Next.js docs, `output` config page):
 *
 *   1. `next start` does NOT work with `output: "standalone"` — Next prints
 *      `"next start" does not work with "output: standalone" ... Use
 *      "node .next/standalone/server.js" instead.` and the server then
 *      fails to serve assets.
 *   2. The standalone `server.js` does NOT copy `public/` or `.next/static/`
 *      by default (in production these are meant to be served by a CDN).
 *      Without them every `/_next/static/*` request 404/500s as
 *      `text/plain`, so the page HTML loads but all JS/CSS/fonts are blocked
 *      by `X-Content-Type-Options: nosniff` — the page renders unstyled and
 *      login JS never runs.
 *
 * The production Docker image (`Dockerfile`) already copies both folders
 * into the runner stage, so deployments are fine. This script reproduces
 * that copy for LOCAL `pnpm start`, then launches the standalone server.
 */

const root = process.cwd();
const standalone = join(root, ".next", "standalone");

if (!existsSync(join(standalone, "server.js"))) {
  console.error(
    'Standalone build not found. Run "pnpm build" first ' +
      "(requires output: \"standalone\" in next.config.ts).",
  );
  process.exit(1);
}

// Copy the assets the minimal server expects to find next to itself.
// `recursive` mirrors the directory tree; `force` keeps it idempotent so
// repeated `pnpm start` runs just overwrite with the freshest build.
cpSync(join(root, "public"), join(standalone, "public"), {
  recursive: true,
  force: true,
});
cpSync(join(root, ".next", "static"), join(standalone, ".next", "static"), {
  recursive: true,
  force: true,
});

// Native packages (sharp / libvips / prisma) have platform-specific binaries
// that Next.js standalone file-tracing might not fully pull through pnpm symlinks.
for (const mod of ["@img", "sharp", "@prisma", "prisma"]) {
  const src = join(root, "node_modules", mod);
  const dest = join(standalone, "node_modules", mod);
  if (existsSync(src)) {
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, {
      recursive: true,
      force: true,
      dereference: true,
    });
  }
}

// Hand off to the standalone server, inheriting stdio and env (PORT,
// HOSTNAME, DATABASE_URL, AUTH_*, …). `server.js` reads next.config values
// that were serialized into it at build time.
const child = spawn(process.execPath, [join(standalone, "server.js")], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => process.exit(code ?? 0));
