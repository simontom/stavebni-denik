#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/dev/prod-start.sh — production server na pozadí (standalone bundle)
#
# Proč standalone, ne `pnpm start`:
#   next.config.ts má `output: "standalone"`, což je formát pro Docker
#   image. `next start` v tomto módu sice nastartuje, ale nedokáže servovat
#   /_next/static (vrací text/plain → browser blokuje s MIME mismatch),
#   a navíc vyhazuje warning *"next start does not work with output:
#   standalone"*. Správné řešení: spustit `.next/standalone/server.js`
#   přes Node, předtím zkopírovat `.next/static` a `public/` dovnitř
#   standalone adresáře (standalone bundle je úmyslně self-contained).
#
# Proč přes `nohup + disown + </dev/null`:
#   `pnpm start` v ad-hoc terminálu padá s SIGTERM 143, jakmile shell
#   session co ho spustil zemře (terminal cleanup, tmux/screen detach,
#   agent shutdown). macOS nemá `setsid`, ale tahle kombinace funguje
#   stejně — proces nedostane SIGHUP a nemá controlling terminal.
#
# Použití:
#   ./scripts/dev/prod-start.sh         # build pokud chybí + start
#   ./scripts/dev/prod-start.sh --build # vždy rebuild
#
# Stop:  ./scripts/dev/prod-stop.sh
# Log:   tail -f /tmp/stavebni-prod.log
# ---------------------------------------------------------------------------

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info() { printf "${GREEN}[prod]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[prod]${NC} %s\n" "$*"; }
err()  { printf "${RED}[prod]${NC} %s\n" "$*"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

LOG_FILE="/tmp/stavebni-prod.log"
PID_FILE="/tmp/stavebni-prod.pid"
PORT="${PORT:-3000}"
HOSTNAME_BIND="${HOSTNAME:-0.0.0.0}"

FORCE_BUILD=0
if [ "${1:-}" = "--build" ]; then
  FORCE_BUILD=1
fi

# ── 1) Zabij předchozí instanci ────────────────────────────────────────────
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    warn "Předchozí prod běží (PID $OLD_PID) — zabíjím."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
  rm -f "$PID_FILE"
fi

# Fallback: zabij cokoliv na :3000 (zombie z minulé session)
EXISTING=$(lsof -ti ":$PORT" 2>/dev/null || true)
if [ -n "$EXISTING" ]; then
  warn "Na :$PORT visí proces(y) $EXISTING — zabíjím."
  for pid in $EXISTING; do
    kill -9 "$pid" 2>/dev/null || true
  done
  sleep 1
fi

# ── 2) Build (pokud chybí nebo --build) ────────────────────────────────────
NEEDS_BUILD=0
if [ "$FORCE_BUILD" -eq 1 ]; then
  NEEDS_BUILD=1
elif [ ! -f ".next/standalone/server.js" ]; then
  NEEDS_BUILD=1
fi

if [ "$NEEDS_BUILD" -eq 1 ]; then
  info "pnpm build (standalone bundle)"
  pnpm build
fi

# ── 3) Standalone bundle potřebuje vedle sebe static + public ──────────────
# Next standalone úmyslně vynechává tyto adresáře — musíme je zkopírovat.
# Bez tohohle vrací /_next/static jako 404 nebo text/plain.
info "Kopíruji .next/static a public/ do .next/standalone/"
rm -rf .next/standalone/.next/static .next/standalone/public
mkdir -p .next/standalone/.next
cp -R .next/static .next/standalone/.next/static
if [ -d public ]; then
  cp -R public .next/standalone/public
fi

# ── 4) Spuštění detached ───────────────────────────────────────────────────
info "Startuji prod server (standalone) na :${PORT}…"

# Node 20.6+ podporuje --env-file. Standalone server.js sám nečte .env.
NODE_ARGS=""
if [ -f .env ]; then
  NODE_ARGS="--env-file=.env"
fi

# nohup + disown + </dev/null = detach pattern bez setsid (který macOS nemá).
# Předáváme PORT/HOSTNAME explicitně přes shell env (Next standalone je čte).
PORT="$PORT" HOSTNAME="$HOSTNAME_BIND" \
  nohup node $NODE_ARGS .next/standalone/server.js \
  > "$LOG_FILE" 2>&1 < /dev/null &
SERVER_PID=$!
disown "$SERVER_PID" 2>/dev/null || true
echo "$SERVER_PID" > "$PID_FILE"

# ── 5) Health-check ────────────────────────────────────────────────────────
info "Cekam na /healthz"
for i in {1..30}; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    err "Proces $SERVER_PID umřel během startu. Posledních 40 řádků logu:"
    tail -40 "$LOG_FILE" || true
    rm -f "$PID_FILE"
    exit 1
  fi
  if curl -fsS -I "http://localhost:$PORT/healthz" >/dev/null 2>&1; then
    info "OK — PID $SERVER_PID — http://localhost:$PORT"
    info "Log:  tail -f $LOG_FILE"
    info "Stop: ./scripts/dev/prod-stop.sh"
    exit 0
  fi
  sleep 1
done

err "Server po 30 s neodpovídá. Posledních 40 řádků logu:"
tail -40 "$LOG_FILE" || true
exit 1
