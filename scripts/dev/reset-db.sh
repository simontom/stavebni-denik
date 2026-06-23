#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/dev/reset-db.sh — wipe local DB and re-seed
#
# Co dělá:
#   1. docker compose down -v (= drop volume = drop data)
#   2. docker compose up -d
#   3. wait for Postgres
#   4. prisma migrate dev
#   5. db:seed (nový admin + nové heslo)
#
# POZOR: smaže VŠECHNA lokální data (uživatele, projekty, fotky DB
# rows). Fyzické JPEG soubory v .dev-data/ ZŮSTANOU — chceš-li
# i ty smazat, smaž ručně.
#
# Použití:
#   ./scripts/dev/reset-db.sh
# ---------------------------------------------------------------------------

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info() { printf "${GREEN}[reset]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[reset]${NC} %s\n" "$*"; }
err()  { printf "${RED}[reset]${NC} %s\n" "$*" >&2; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

warn "Tahle akce SMAŽE LOKÁLNÍ POSTGRES DATA (users, projects, audit log, …)."
warn "Fyzické JPEG soubory v .dev-data/ zůstanou."
read -r -p "Pokračovat? [yes/NO] " confirm
if [ "$confirm" != "yes" ]; then
  info "Zrušeno."
  exit 0
fi

info "Zastavuju Postgres + dropuju volume..."
docker compose down -v

info "Spouštím Postgres znovu..."
docker compose up -d

info "Čekám na Postgres..."
for i in {1..30}; do
  if docker compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1; then
    info "Postgres ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    err "Postgres se nespustil"; exit 1
  fi
  sleep 1
done

info "Aplikace migrací..."
pnpm exec prisma migrate dev --skip-seed

info "Bootstrap admin..."
echo ""
echo "============================================================"
echo "  POZOR: Heslo se zobrazí JEDNOU. Uložit si ho!"
echo "============================================================"
echo ""
pnpm db:seed

echo ""
info "DB resetnuta. Spusť: pnpm dev"
