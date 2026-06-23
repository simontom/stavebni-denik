#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/dev/up.sh — start Postgres + ověřit env (bez migrace)
#
# Pro běžný start dne — Postgres už existuje, jen ho probudit.
# Když je první run, použij setup.sh.
# ---------------------------------------------------------------------------

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { printf "${GREEN}[up]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[up]${NC} %s\n" "$*"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# .env
if [ ! -f .env ]; then
  warn ".env neexistuje — spusť scripts/dev/setup.sh nejdřív."
  exit 1
fi

# Postgres
info "Spouštím Postgres..."
docker compose up -d

info "Čekám na Postgres..."
for i in {1..30}; do
  if docker compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1; then
    info "Postgres ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    warn "Postgres trvá podezřele dlouho — zkontroluj 'docker compose logs postgres'"
    break
  fi
  sleep 1
done

info "Prisma generate..."
pnpm exec prisma generate

echo ""
info "Hotovo. Spusť dev server: pnpm dev"
info "Nebo prod build: pnpm build && pnpm start"
