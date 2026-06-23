#!/usr/bin/env bash
# ===========================================================================
# scripts/dev/prod-stop.sh — zastaví production server
#
# Cross-platform Bash wrapper:
#   • macOS → `launchctl bootout` LaunchAgent
#   • Linux → `systemctl --user stop` (nebo PID-based pokud běží nohup fallback)
#
# Pro Windows: scripts/dev/prod-stop.ps1
#
# Použití:
#   ./scripts/dev/prod-stop.sh
#   ./scripts/dev/prod-stop.sh --purge   # smaže i plist/unit soubor
# ===========================================================================

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { printf "${GREEN}[prod]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[prod]${NC} %s\n" "$*"; }

LABEL_REVERSE_DNS="com.stavebnidenik.prod"
SERVICE_NAME="stavebni-denik-prod"
UID_NUM="$(id -u)"
PORT="${PORT:-3000}"

PURGE=0
if [ "${1:-}" = "--purge" ]; then PURGE=1; fi

kill_leftover_port() {
  if ! command -v lsof >/dev/null 2>&1; then return; fi
  local pids
  pids=$(lsof -ti ":$PORT" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    warn "Na :$PORT po stopu visí $pids — zabíjím."
    for p in $pids; do kill -9 "$p" 2>/dev/null || true; done
  fi
}

stop_macos() {
  local plist="$HOME/Library/LaunchAgents/$LABEL_REVERSE_DNS.plist"
  if launchctl print "gui/${UID_NUM}/${LABEL_REVERSE_DNS}" >/dev/null 2>&1; then
    info "Zastavuji LaunchAgent ${LABEL_REVERSE_DNS}"
    launchctl bootout "gui/${UID_NUM}/${LABEL_REVERSE_DNS}" 2>/dev/null || true
  else
    warn "LaunchAgent ${LABEL_REVERSE_DNS} není načtený."
  fi
  for i in 1 2 3 4 5; do
    if ! lsof -ti ":$PORT" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  kill_leftover_port
  if [ "$PURGE" -eq 1 ] && [ -f "$plist" ]; then
    info "Mažu $plist"
    rm -f "$plist"
  fi
}

stop_linux() {
  local unit="$HOME/.config/systemd/user/${SERVICE_NAME}.service"
  local pid_file="/tmp/stavebni-prod.pid"

  if command -v systemctl >/dev/null 2>&1 \
     && systemctl --user is-active "${SERVICE_NAME}.service" >/dev/null 2>&1; then
    info "Zastavuji systemd user unit ${SERVICE_NAME}"
    systemctl --user stop "${SERVICE_NAME}.service" || true
    if [ "$PURGE" -eq 1 ]; then
      systemctl --user disable "${SERVICE_NAME}.service" 2>/dev/null || true
      if [ -f "$unit" ]; then
        info "Mažu $unit"
        rm -f "$unit"
        systemctl --user daemon-reload
      fi
    fi
  elif [ -f "$pid_file" ]; then
    # nohup fallback path
    local pid
    pid=$(cat "$pid_file")
    if kill -0 "$pid" 2>/dev/null; then
      info "Zabíjím nohup PID $pid"
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  else
    warn "Žádný stavebni-denik-prod service ani PID file nenalezen."
  fi

  for i in 1 2 3; do
    if ! lsof -ti ":$PORT" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  kill_leftover_port
}

case "$(uname -s)" in
  Darwin) stop_macos ;;
  Linux)  stop_linux ;;
  MINGW*|MSYS*|CYGWIN*)
    warn "Tento skript je pro Unix. Na Windows použij:"
    warn "  .\\scripts\\dev\\prod-stop.ps1"
    exit 0
    ;;
  *)
    warn "Nepodporovaný OS: $(uname -s)"; exit 0 ;;
esac

info "Hotovo."
