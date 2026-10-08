# Production image: Ktor backend + built React SPA + typst (PDF export).
#
# Build context = repository root. Requires the committed jOOQ sources in
# backend/src/generated/jooq (no database is needed at build time).

# --- 1. Frontend (Vite) ------------------------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /app/frontend
RUN npm install -g pnpm@12.8.1
# pnpm-lock.yaml* : the lockfile is optional until it is committed
COPY frontend/package.json frontend/pnpm-workspace.yaml frontend/pnpm-lock.yaml* ./
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install; fi
COPY frontend/ ./
RUN pnpm build

# --- 2. Backend (Gradle shadow jar) -----------------------------------------
FROM gradle:8.10-jdk21-alpine AS backend
WORKDIR /app
COPY settings.gradle.kts build.gradle.kts ./
COPY backend backend
RUN gradle :backend:shadowJar --no-daemon -x test

# --- 3. Runtime --------------------------------------------------------------
FROM eclipse-temurin:21-jre-alpine
# The archive is pinned by checksum. When TYPST_VERSION changes, update TYPST_SHA256 too (and the
# same pair in .github/actions/install-typst/action.yml). typst publishes no checksums; this one was computed from
# two independent downloads and matches the size GitHub lists for the asset.
ARG TYPST_VERSION=0.13.1
ARG TYPST_SHA256=7d214bfeffc2e585dc422d1a09d2b144969421281e8c7f5d784b65fc69b5673f
RUN apk add --no-cache fontconfig ttf-dejavu \
    && wget -q "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz" \
    && echo "${TYPST_SHA256}  typst-x86_64-unknown-linux-musl.tar.xz" | sha256sum -c - \
    && tar -xf typst-x86_64-unknown-linux-musl.tar.xz \
    && mv typst-x86_64-unknown-linux-musl/typst /usr/local/bin/typst \
    && rm -rf typst-x86_64-unknown-linux-musl* \
    && typst --version

WORKDIR /app
COPY --from=backend /app/backend/build/libs/*-all.jar /app/app.jar
COPY --from=frontend /app/frontend/dist /app/static

# JWT_SECRET and the database credentials come from Fly secrets.
ENV APP_ENV=production \
    STATIC_DIR=/app/static \
    UPLOADS_DIR=/data/uploads

EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
