# Production image: Ktor backend + built React SPA + typst (PDF export).
#
# Build context = repository root. Requires the committed jOOQ sources in
# backend/src/generated/jooq (no database is needed at build time).

# --- 1. Frontend (Vite) ------------------------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /app/frontend
RUN npm install -g pnpm@12.8.1
# The committed lockfile decides what is installed; a missing or outdated one fails the build.
COPY frontend/package.json frontend/pnpm-workspace.yaml frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm build

# --- 2. Backend (Gradle shadow jar) -----------------------------------------
FROM gradle:8.10-jdk21-alpine AS backend
WORKDIR /app
COPY settings.gradle.kts build.gradle.kts ./
COPY backend backend
RUN gradle :backend:shadowJar --no-daemon -x test

# --- 3. Runtime --------------------------------------------------------------
# A glibc (Ubuntu) base on purpose, NOT Alpine: the password hashing library (argon2-jvm) loads a
# native libargon2 through JNA, and on Alpine (musl libc) the JVM dies with SIGSEGV as soon as a
# password is *hashed* (creating a user), while verifying one still works. The static typst binary
# below runs on any libc.
FROM eclipse-temurin:25-jre
# The archive is pinned by checksum. When TYPST_VERSION changes, update TYPST_SHA256 too (and the
# same pair in .github/actions/install-typst/action.yml). typst publishes no checksums; this one was computed from
# two independent downloads and matches the size GitHub lists for the asset.
ARG TYPST_VERSION=0.13.1
ARG TYPST_SHA256=7d214bfeffc2e585dc422d1a09d2b144969421281e8c7f5d784b65fc69b5673f
RUN apt-get update \
    && apt-get install -y --no-install-recommends xz-utils fontconfig fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    && wget -q "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz" \
    && echo "${TYPST_SHA256}  typst-x86_64-unknown-linux-musl.tar.xz" | sha256sum -c - \
    && tar -xf typst-x86_64-unknown-linux-musl.tar.xz \
    && mv typst-x86_64-unknown-linux-musl/typst /usr/local/bin/typst \
    && rm -rf typst-x86_64-unknown-linux-musl* \
    && typst --version

WORKDIR /app
COPY --from=backend /app/backend/build/libs/*-all.jar /app/app.jar
COPY --from=frontend /app/frontend/dist /app/static

# The application never runs as root: an upload that tricked the image decoder or the typst process into running code
# would otherwise own the whole container. The entrypoint starts as root only to hand the (root-owned) data volume to
# that user, then drops privileges before the JVM starts. The script is written here, not copied from the repository,
# so a checkout with Windows line endings cannot break it.
RUN useradd --system --create-home --home-dir /home/app --shell /usr/sbin/nologin app \
    && printf '%s\n' \
        '#!/bin/sh' \
        'set -eu' \
        'if [ "$(id -u)" = "0" ]; then' \
        '  mkdir -p "$UPLOADS_DIR"' \
        '  # Only walk the photos when the directory is not already the app user'"'"'s (a volume that was written by root).' \
        '  if [ "$(stat -c %U "$UPLOADS_DIR")" != "app" ]; then chown -R app:app "$UPLOADS_DIR"; fi' \
        '  exec setpriv --reuid=app --regid=app --init-groups "$@"' \
        'fi' \
        'exec "$@"' \
        > /app/entrypoint.sh \
    && chmod 0555 /app/entrypoint.sh

# JWT_SECRET and the database credentials come from Fly secrets.
# JAVA_TOOL_OPTIONS applies to the application and to the operator commands (AdminCliKt) alike:
#  - the heap is capped at 40 % of the machine's memory; the rest is for what the heap does not hold: Argon2 (up to 4 x 64 MiB of
#    native memory), the image decoder buffers, class metadata, threads, and the typst processes of the PDF export;
#  - an out-of-memory error ends the process at once (Fly restarts it) instead of leaving a half-working server.
ENV APP_ENV=production \
    STATIC_DIR=/app/static \
    UPLOADS_DIR=/data/uploads \
    JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=40 -XX:+ExitOnOutOfMemoryError"

EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["java", "-jar", "/app/app.jar"]
