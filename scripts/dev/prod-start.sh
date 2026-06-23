#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/dev/prod-start.sh — pustí production server na pozadí
#
# Důvod: `pnpm start` v dev terminálu padá s SIGTERM 143 jakmile
# se zavře shell session co ho spustil (terminál cleanup nebo
# tmux/screen detach). Tahle pojistka:
#   - Spustí přes `setsid` (= proces NIKDY nedostane controlling
#     terminal, takže ho shutdown shellu nezasáhne)
#   - Redirektuje stdin/stdout/stderr na log file
#   - Vypíše PID a path k logu
#
# Použití:
#   ./scripts/dev/prod-start.sh
#
# Pro stop: ./scripts/dev/prod-stop.sh
# ---------------------------------------------------------------------------

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { printf "${GREEN}[prod]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[prod]${NC} %s\n" "$*"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

LOG_FILE="/tmp/stavebni-prod.log"
PID_FILE="/tmp/stavebni-prod.pid"

# Pokud už něco běží, zabij to.
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    warn "Production server už běží (PID $OLD_PID) — zabíjím."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

# Kontrola buildu — pokud .next chybí, zabuilduj.
if [ ! -d ".next" ]; then
  info "No .next/ — spouštím pnpm build..."
  pnpm build
fi

info "Spouštím prod server detached..."
# macOS nemá `setsid` — používáme `nohup` + `disown -h` + redirekty
# na log file + < /dev/null. To je nejbližší ekvivalent: proces
# nedostane SIGHUP při zavření shellu a stdin/stdout/stderr jsou
# odpojené.
nohup pnpm start > "$LOG_FILE" 2>&1 < /dev/null &
SERVER_PID=$!
disown "$SERVER_PID" 2>/dev/null || true

# Uložit PID pro snadné zabití později
echo "$SERVER_PID" > "$PID_FILE"

# Počkat až server odpoví na :3000
info "Čekám na :3000..."
for i in {1..20}; do
  if curl -fsS -I http://localhost:3000/healthz >/dev/null 2>&1; then
    info "OK — PID $SERVER_PID, http://localhost:3000"
    info "Log: tail -f $LOG_FILE"
    info "Stop: ./scripts/dev/prod-stop.sh"
    exit 0
  fi
  sleep 1
done

warn "Server neodpovídá po 20 s — zkontroluj $LOG_FILE"
exit 1
