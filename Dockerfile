# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Stavební deník — production Docker image.
#
# Multi-stage build:
#   1. base     — pinned Node 22 + pnpm, common to all later stages.
#   2. deps     — `pnpm install --frozen-lockfile` for reproducible builds.
#   3. builder  — generates the Prisma client and runs `next build`.
#   4. runner   — minimal runtime carrying the Next.js standalone output
#                 plus Chromium system libraries needed by Playwright
#                 (PDF export, Stage 6).
# ---------------------------------------------------------------------------

ARG NODE_VERSION=22-bookworm-slim

# === Stage 1: base ==========================================================
FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate
WORKDIR /app

# === Stage 2: deps ==========================================================
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
# `prisma` is in devDependencies and is needed for `prisma generate`
# during the builder stage; we install full deps here.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# === Stage 3: builder =======================================================
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generate Prisma client (output to src/generated/prisma per schema.prisma).
RUN pnpm exec prisma generate
# Disable telemetry on every CI / build host.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm run build

# === Stage 4: runner ========================================================
FROM node:${NODE_VERSION} AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app

# System libraries needed by:
#   * Chromium (Playwright, used for PDF export in Stage 6)
#   * sharp (libvips comes bundled with the npm prebuilt binary)
#   * Postgres TLS via `pg`
#   * `scripts/backup.sh` (postgresql-client for pg_dump, restic for
#     deduplicated encrypted snapshots to B2/R2/S3)
# `tini` makes PID 1 forward signals correctly to the Node server.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      tini \
      fonts-liberation \
      fonts-noto \
      libnss3 \
      libnspr4 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libdbus-1-3 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libgbm1 \
      libpango-1.0-0 \
      libcairo2 \
      libasound2 \
      libatspi2.0-0 \
      postgresql-client \
      restic \
    && rm -rf /var/lib/apt/lists/*

# Download the Chromium browser binary into a system-wide path so the
# non-root `nextjs` user can find it via PLAYWRIGHT_BROWSERS_PATH. The
# version MUST match the `playwright` npm version pinned in package.json,
# otherwise Playwright's launcher will refuse to start.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN mkdir -p $PLAYWRIGHT_BROWSERS_PATH \
 && npx -y playwright@1.61.0 install chromium \
 && chmod -R a+rX $PLAYWRIGHT_BROWSERS_PATH

# Run as non-root.
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs --create-home nextjs

# Standalone output already contains a trimmed node_modules tree.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Prisma migration files and schema are needed at runtime to run
# `prisma migrate deploy` on container start.
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=nextjs:nodejs /app/src/generated/prisma ./src/generated/prisma

# Backup script needs to live in the runner image so a Fly machine
# schedule can invoke `/app/scripts/backup.sh` directly.
COPY --from=builder --chown=nextjs:nodejs /app/scripts/backup.sh ./scripts/backup.sh
RUN chmod +x /app/scripts/backup.sh

# Volume mount target — photos, PDF exports, audit-verify log.
RUN mkdir -p /data && chown -R nextjs:nodejs /data
VOLUME ["/data"]

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run migrations on every boot then start Next; idempotent in production.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node server.js"]
