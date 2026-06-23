#!/usr/bin/env bash
# ===========================================================================
# scripts/dev/prod-start.sh — production server na pozadí
#
# Cross-platform Bash wrapper:
#   • macOS  → launchd LaunchAgent (~/Library/LaunchAgents/)
#   • Linux  → systemd user unit (~/.config/systemd/user/)
#              + fallback `nohup` pro distra bez user-systemd
#
# Pro Windows použij scripts/dev/prod-start.ps1 (jiná OS, jiné nástroje).
#
# Co dělají všechny větve společně:
#   1. Build pokud .next/standalone/server.js chybí (nebo --build)
#   2. Zkopírovat .next/static + public/ DO .next/standalone/
#      (Next standalone bundle to neobsahuje, ale potřebuje pro static
#       serving — viz docs/DEVELOPMENT.md "MIME mismatch")
#   3. Spustit `node --env-file=.env .next/standalone/server.js`
#      jako řízenou service (launchd nebo systemd)
#   4. Health-check na /healthz (max 30 s)
#
# Proč ne `nohup pnpm start &`:
#   • Na macOS po cca 15 min launchd hlásí "removing inactive unmanaged
#     service" a OS proces zlikviduje (App Nap / runningboardd policy).
#   • `pnpm start` (= next start) ve standalone módu vrací statiku jako
#     text/plain → browser blokuje s nosniff MIME mismatch.
#
# Použití:
#   ./scripts/dev/prod-start.sh             # build pokud chybí + start
#   ./scripts/dev/prod-start.sh --build     # vždy rebuild
#   ./scripts/dev/prod-start.sh --restart   # restart bez rebuildu
#
# Stop:    ./scripts/dev/prod-stop.sh
# Log:     tail -f /tmp/stavebni-prod.log
# ===========================================================================

set -euo pipefail

# ── Common: barvy, paths, parametry ────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info() { printf "${GREEN}[prod]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[prod]${NC} %s\n" "$*"; }
err()  { printf "${RED}[prod]${NC} %s\n" "$*"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

LABEL_REVERSE_DNS="com.stavebnidenik.prod"   # macOS launchd label
SERVICE_NAME="stavebni-denik-prod"            # systemd unit name
LOG_FILE="/tmp/stavebni-prod.log"
ERR_FILE="/tmp/stavebni-prod.err"
PORT="${PORT:-3000}"
HOSTNAME_BIND="${HOSTNAME:-0.0.0.0}"
UID_NUM="$(id -u)"

FORCE_BUILD=0
RESTART_ONLY=0
for arg in "${@}"; do
  case "$arg" in
    --build)   FORCE_BUILD=1 ;;
    --restart) RESTART_ONLY=1 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) err "Neznámý parametr: $arg"; exit 2 ;;
  esac
done

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  err "node nenalezen v PATH. Nainstaluj Node 24+ (homebrew/Volta/apt)."
  exit 1
fi

# ── Common: kill leftover na :PORT ─────────────────────────────────────────
kill_leftover_port() {
  if ! command -v lsof >/dev/null 2>&1; then return; fi
  local pids
  pids=$(lsof -ti ":$PORT" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    warn "Na :$PORT visí PID(y) $pids mimo service — zabíjím."
    for p in $pids; do kill -9 "$p" 2>/dev/null || true; done
    sleep 1
  fi
}

# ── Common: build + copy static (skipne když --restart) ────────────────────
prepare_build() {
  if [ "$RESTART_ONLY" -eq 1 ]; then return; fi

  if [ "$FORCE_BUILD" -eq 1 ] || [ ! -f ".next/standalone/server.js" ]; then
    info "pnpm build (standalone bundle)"
    pnpm build
  fi

  info "Kopíruji .next/static a public/ do .next/standalone/"
  rm -rf .next/standalone/.next/static .next/standalone/public
  mkdir -p .next/standalone/.next
  cp -R .next/static .next/standalone/.next/static
  if [ -d public ]; then
    cp -R public .next/standalone/public
  fi
}

# ── Common: health-check ───────────────────────────────────────────────────
wait_for_healthz() {
  info "Cekam na /healthz (max 30 s)"
  for i in $(seq 1 30); do
    if curl -fsS -I "http://localhost:$PORT/healthz" >/dev/null 2>&1; then
      info "OK — http://localhost:$PORT"
      info "Log:    tail -f $LOG_FILE"
      info "Stop:   ./scripts/dev/prod-stop.sh"
      return 0
    fi
    sleep 1
  done
  err "Server po 30 s neodpovídá. Posledních 40 řádků logu:"
  echo "--- stdout ---"; tail -40 "$LOG_FILE" 2>/dev/null || true
  echo "--- stderr ---"; tail -40 "$ERR_FILE" 2>/dev/null || true
  return 1
}

# ═══════════════════════════════════════════════════════════════════════════
# macOS: launchd LaunchAgent
# ═══════════════════════════════════════════════════════════════════════════
start_macos() {
  local plist_dir="$HOME/Library/LaunchAgents"
  local plist="$plist_dir/$LABEL_REVERSE_DNS.plist"

  # Zastavit existující service pokud běží
  if launchctl print "gui/${UID_NUM}/${LABEL_REVERSE_DNS}" >/dev/null 2>&1; then
    info "Zastavuji existující LaunchAgent ${LABEL_REVERSE_DNS}"
    launchctl bootout "gui/${UID_NUM}/${LABEL_REVERSE_DNS}" 2>/dev/null || true
    for i in 1 2 3 4 5; do
      if ! lsof -ti ":$PORT" >/dev/null 2>&1; then break; fi
      sleep 1
    done
  fi
  kill_leftover_port

  prepare_build

  mkdir -p "$plist_dir"
  info "Generuji $plist"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL_REVERSE_DNS}</string>

  <key>WorkingDirectory</key>
  <string>${ROOT}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>--env-file=.env</string>
    <string>.next/standalone/server.js</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PORT</key>
    <string>${PORT}</string>
    <key>HOSTNAME</key>
    <string>${HOSTNAME_BIND}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <!-- Restartuj JEN při crashi (ne když normalne vyřazený prod-stop.sh) -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>ProcessType</key>
  <string>Background</string>

  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${ERR_FILE}</string>
</dict>
</plist>
EOF

  info "Bootstrap do launchd"
  launchctl bootstrap "gui/${UID_NUM}" "$plist"
  launchctl enable "gui/${UID_NUM}/${LABEL_REVERSE_DNS}" 2>/dev/null || true

  wait_for_healthz
}

# ═══════════════════════════════════════════════════════════════════════════
# Linux: systemd user unit (s fallbackem na nohup pokud user-systemd chybí)
# ═══════════════════════════════════════════════════════════════════════════
start_linux() {
  # Zastavit existující
  if systemctl --user is-active "${SERVICE_NAME}.service" >/dev/null 2>&1; then
    info "Zastavuji existující systemd user unit"
    systemctl --user stop "${SERVICE_NAME}.service" || true
    sleep 1
  fi
  kill_leftover_port

  prepare_build

  # Detekce: má tato distra user-systemd?
  if command -v systemctl >/dev/null 2>&1 && systemctl --user --version >/dev/null 2>&1; then
    start_linux_systemd
  else
    warn "systemd --user není dostupný — používám nohup fallback."
    start_linux_nohup
  fi
}

start_linux_systemd() {
  local unit_dir="$HOME/.config/systemd/user"
  local unit="$unit_dir/${SERVICE_NAME}.service"
  mkdir -p "$unit_dir"

  info "Generuji $unit"
  cat > "$unit" <<EOF
[Unit]
Description=Stavebni denik — production server (Next standalone)
After=network.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
ExecStart=${NODE_BIN} --env-file=.env .next/standalone/server.js
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=HOSTNAME=${HOSTNAME_BIND}

# Restart pouze pri crashi (ne pri rucnim stopu)
Restart=on-failure
RestartSec=10

# Logy do souboru (alternativa: journalctl --user -u stavebni-denik-prod)
StandardOutput=append:${LOG_FILE}
StandardError=append:${ERR_FILE}

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable "${SERVICE_NAME}.service" 2>/dev/null || true
  systemctl --user restart "${SERVICE_NAME}.service"

  # Aby unit přežil logout, doporučujeme linger. Kontrolujeme a varujeme.
  if command -v loginctl >/dev/null 2>&1; then
    if ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q "Linger=yes"; then
      warn "Pro persistenci po logoutu spust JEDNORAZOVE:"
      warn "  sudo loginctl enable-linger $USER"
    fi
  fi

  wait_for_healthz
}

start_linux_nohup() {
  # Fallback: nohup + disown. Na Linuxu to funguje spolehlivě
  # (žádný App Nap, žádný launchd cleanup), ale nemá auto-restart.
  local pid_file="/tmp/stavebni-prod.pid"

  if [ -f "$pid_file" ]; then
    local old_pid
    old_pid=$(cat "$pid_file" 2>/dev/null || true)
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      warn "Předchozí PID $old_pid běží — zabíjím."
      kill "$old_pid" 2>/dev/null || true
      sleep 2
    fi
    rm -f "$pid_file"
  fi

  info "Startuji přes nohup (no auto-restart, no service)"
  PORT="$PORT" HOSTNAME="$HOSTNAME_BIND" NODE_ENV=production \
    nohup "$NODE_BIN" --env-file=.env .next/standalone/server.js \
    > "$LOG_FILE" 2> "$ERR_FILE" < /dev/null &
  local server_pid=$!
  disown "$server_pid" 2>/dev/null || true
  echo "$server_pid" > "$pid_file"

  wait_for_healthz
}

# ═══════════════════════════════════════════════════════════════════════════
# Dispatch
# ═══════════════════════════════════════════════════════════════════════════
case "$(uname -s)" in
  Darwin) start_macos ;;
  Linux)  start_linux ;;
  MINGW*|MSYS*|CYGWIN*)
    err "Tento skript je pro Unix. Na Windows použij:"
    err "  .\\scripts\\dev\\prod-start.ps1"
    exit 1
    ;;
  *)
    err "Nepodporovaný OS: $(uname -s)"
    exit 1
    ;;
esac
