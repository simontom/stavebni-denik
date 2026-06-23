#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/dev/setup.sh — fresh local dev setup
#
# Idempotentní: může se pustit znovu, kroky které jsou hotové
# přeskakují bez chyby.
#
# Co dělá:
#   1. Ověří prerekvizity (node, pnpm, docker compose)
#   2. pnpm install (pokud node_modules chybí nebo je zastaralý)
#   3. .env (zkopíruje .env.example pokud .env chybí + vygeneruje AUTH_SECRET)
#   4. docker compose up -d (Postgres)
#   5. Čeká až je Postgres ready
#   6. prisma migrate dev + generate
#   7. db:seed (vytvoří bootstrap admina — zobrazí heslo!)
#
# Použití:
#   ./scripts/dev/setup.sh
# ---------------------------------------------------------------------------

set -euo pipefail

# Barvy pro výstup
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

info()    { printf "${GREEN}[setup]${NC} %s\n" "$*"; }
warn()    { printf "${YELLOW}[setup]${NC} %s\n" "$*"; }
err()     { printf "${RED}[setup]${NC} %s\n" "$*" >&2; }

# Najít root repa (skript může být volaný odkudkoliv)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# 1. Prerekvizity
info "Kontrola prerekvizit..."
command -v node >/dev/null 2>&1 || { err "node nenalezen — nainstaluj Node 24+ (LTS)"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { err "pnpm nenalezen — npm i -g pnpm"; exit 1; }
command -v docker >/dev/null 2>&1 || { err "docker nenalezen — nainstaluj Docker Desktop nebo Colima"; exit 1; }
if ! docker compose version >/dev/null 2>&1; then
  err "docker compose v2 nenalezen"
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 24 ]; then
  warn "Node $NODE_MAJOR detected — projekt vyžaduje Node 24+. Pokračuju, ale build může selhat."
fi
info "OK — node $(node -v), pnpm $(pnpm -v)"

# 2. pnpm install
info "Instalace závislostí..."
pnpm install --frozen-lockfile=false

# 3. .env
if [ ! -f .env ]; then
  info "Vytvářím .env z .env.example..."
  cp .env.example .env
  if command -v openssl >/dev/null 2>&1; then
    AUTH_SECRET=$(openssl rand -base64 32)
    # macOS sed -i potřebuje "" argument, GNU sed ne. Detekce:
    if sed --version >/dev/null 2>&1; then
      sed -i "s|^AUTH_SECRET=.*|AUTH_SECRET=\"$AUTH_SECRET\"|" .env
    else
      sed -i "" "s|^AUTH_SECRET=.*|AUTH_SECRET=\"$AUTH_SECRET\"|" .env
    fi
    info "AUTH_SECRET vygenerován"
  else
    warn "openssl není dostupný — uprav AUTH_SECRET v .env ručně!"
  fi
else
  info ".env už existuje, přeskočeno"
fi

# 4. Postgres
info "Spouštím Postgres přes docker compose..."
docker compose up -d

# 5. Wait for Postgres
info "Čekám na Postgres (max 30 s)..."
for i in {1..30}; do
  if docker compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1; then
    info "Postgres ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    err "Postgres se nespustil za 30 s — zkontroluj 'docker compose logs postgres'"
    exit 1
  fi
  sleep 1
done

# 6. Migrace + Prisma client
info "Aplikace migrací (prisma migrate dev)..."
pnpm exec prisma migrate dev --skip-seed

info "Generování Prisma klienta..."
pnpm exec prisma generate

# 7. Seed
info "Bootstrap admin (db:seed)..."
echo ""
echo "============================================================"
echo "  POZOR: Heslo se zobrazí JEDNOU. Uložit si ho!"
echo "============================================================"
echo ""
pnpm db:seed || warn "Seed selhal (možná už admin existuje?)"

echo ""
info "Setup hotov! Spusť dev server: pnpm dev"
info "Otevři: http://localhost:3000/login"
