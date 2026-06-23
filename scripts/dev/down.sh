#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/dev/down.sh — clean shutdown (Postgres + Node procesy)
# ---------------------------------------------------------------------------

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { printf "${GREEN}[down]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[down]${NC} %s\n" "$*"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

info "Zastavuju Postgres..."
docker compose down || warn "compose down selhalo (možná už neběží?)"

# Hanging Node procesy na portu 3000
if command -v lsof >/dev/null 2>&1; then
  pids=$(lsof -ti :3000 2>/dev/null || true)
  if [ -n "$pids" ]; then
    warn "Visící Node procesy na portu 3000 (PID: $pids) — zabíjím."
    echo "$pids" | xargs kill 2>/dev/null || true
  else
    info "Žádné procesy na portu 3000"
  fi
fi

info "Hotovo."
