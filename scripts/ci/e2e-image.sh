#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Runs the Playwright suite against the PRODUCTION IMAGE, set up the way production is:
#
#   - a throwaway PostgreSQL 18 with an owner role and the application's own role that owns nothing (decision D5);
#   - the schema migrated by the owner with the `migrate` command (the application does not migrate in production);
#   - the image started with APP_ENV=production as that role, with /data a fresh volume owned by root like on Fly;
#   - Playwright driving the real thing: the built SPA served by Ktor with its security headers and secure cookies,
#     not the Vite dev server.
#
# The normal e2e job (Vite dev server + `gradle run` as the owner) cannot see a broken production bundle, a Content
# Security Policy the SPA violates, a missing grant for the application's role, or a file the non-root user cannot write.
#
#   usage: IMAGE=<image> scripts/ci/e2e-image.sh [playwright arguments...]
#   IMAGE          the image to test (required); build it first: docker build -t stavebni-denik:e2e .
#   E2E_PG_PORT    host port of the database (default 5432; the seed in e2e/global-setup.ts connects as the owner)
#   E2E_APP_PORT   host port of the application (default 8080)
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
: "${IMAGE:?IMAGE: the image to test}"
pg_port="${E2E_PG_PORT:-5432}"
app_port="${E2E_APP_PORT:-8080}"

owner_password="$(openssl rand -hex 16)"
app_password="$(openssl rand -hex 16)"
jwt_secret="$(openssl rand -base64 32)"

cleanup() {
  status=$?
  docker logs e2e-img-app > /tmp/e2e-image-app.log 2>&1 || true
  if [ "$status" -ne 0 ]; then
    echo "=== E2E against the image failed (exit $status); application log tail ===" >&2
    tail -n 60 /tmp/e2e-image-app.log >&2 || true
  fi
  docker rm -f e2e-img-app e2e-img-pg >/dev/null 2>&1 || true
  docker network rm e2e-img-net >/dev/null 2>&1 || true
  docker volume rm e2e-img-data >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker rm -f e2e-img-app e2e-img-pg >/dev/null 2>&1 || true
docker network rm e2e-img-net >/dev/null 2>&1 || true
docker volume rm e2e-img-data >/dev/null 2>&1 || true
docker network create e2e-img-net >/dev/null

docker run -d --name e2e-img-pg --network e2e-img-net -p "$pg_port:5432" \
  -e POSTGRES_DB=stavebni_denik -e POSTGRES_USER=denik -e POSTGRES_PASSWORD="$owner_password" \
  postgres:18-alpine >/dev/null
# Over TCP (-h 127.0.0.1), not the socket: while the image initialises, a temporary server answers on the socket only and
# then restarts, so a socket check can pass just before the database goes away for a moment.
for _ in $(seq 1 30); do
  docker exec e2e-img-pg pg_isready -h 127.0.0.1 -U denik -d stavebni_denik >/dev/null 2>&1 && break
  sleep 1
done
docker exec e2e-img-pg pg_isready -h 127.0.0.1 -U denik -d stavebni_denik >/dev/null

# The application's own role, then the migration as the owner, which also gives that role its privileges.
docker exec -i e2e-img-pg psql -U denik -d stavebni_denik -v ON_ERROR_STOP=1 -v app_password="$app_password" \
  < scripts/sql/bootstrap-app-role.sql >/dev/null
docker run --rm --network e2e-img-net -e APP_ENV=production \
  -e JDBC_URL=jdbc:postgresql://e2e-img-pg:5432/stavebni_denik \
  -e DB_MIGRATE_USER=denik -e DB_MIGRATE_PASSWORD="$owner_password" -e DB_APP_ROLE=app \
  "$IMAGE" java -cp /app/app.jar cz.stavebni.denik.cli.AdminCliKt migrate

# PWNED_PASSWORDS_URL=off: the suite must not depend on an external service (the check itself is covered by unit tests).
docker volume create e2e-img-data >/dev/null
docker run -d --name e2e-img-app --network e2e-img-net -p "$app_port:8080" -v e2e-img-data:/data \
  -e APP_ENV=production -e ALLOW_UNRELEASED_BUILD=true -e JWT_SECRET="$jwt_secret" \
  -e JDBC_URL=jdbc:postgresql://e2e-img-pg:5432/stavebni_denik -e DB_USER=app -e DB_PASSWORD="$app_password" \
  -e PWNED_PASSWORDS_URL=off \
  "$IMAGE" >/dev/null

for _ in $(seq 1 90); do
  curl -fsS --max-time 2 "http://127.0.0.1:$app_port/api/health" 2>/dev/null | grep -q ok && break
  sleep 1
done
curl -fsS --max-time 2 "http://127.0.0.1:$app_port/api/health" | grep -q ok
echo "image is up in production mode, running as the database role 'app'"

# 127.0.0.1, not localhost: Docker publishes IPv4 only on some hosts, and the browser treats it as a secure origin.
BASE_URL="http://127.0.0.1:$app_port" \
DATABASE_URL="postgresql://denik:$owner_password@127.0.0.1:$pg_port/stavebni_denik" \
  pnpm exec playwright test "$@"
