#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/dev/prod-stop.sh — zastaví production server spuštěný přes
# prod-start.sh
# ---------------------------------------------------------------------------

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { printf "${GREEN}[prod]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[prod]${NC} %s\n" "$*"; }

PID_FILE="/tmp/stavebni-prod.pid"

if [ ! -f "$PID_FILE" ]; then
  warn "Žádný PID file — server pravděpodobně neběží."
  # Fallback: zkus zabít cokoliv na :3000
  if command -v lsof >/dev/null 2>&1; then
    PIDS=$(lsof -ti :3000 2>/dev/null || true)
    if [ -n "$PIDS" ]; then
      info "Našel jsem $PIDS na :3000 — zabíjím."
      echo "$PIDS" | xargs kill 2>/dev/null || true
    fi
  fi
  exit 0
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
  info "Zabíjím PID $PID..."
  kill "$PID"
  rm -f "$PID_FILE"
  info "Hotovo."
else
  warn "PID $PID neběží (zombie PID file?) — mažu."
  rm -f "$PID_FILE"
fi
