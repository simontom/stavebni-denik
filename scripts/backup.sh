#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Nightly backup for stavební deník.
#
# Captures the full evidentiary state of the diary:
#   * Postgres dump (custom-format pg_dump, gzipped) — includes the
#     audit log with all hash chain rows so the restore can verify the
#     chain end-to-end after a restore.
#   * Photo files under $DATA_DIR/photos — referenced by the photo
#     rows in the DB; losing them breaks the link between audited
#     uploads and the on-disk evidence.
#   * audit-verify.log under $DATA_DIR — the rolling history of the
#     nightly chain verifier so we don't lose its track record.
#
# Uses restic for deduplicated, encrypted snapshots. Restic env vars
# (RESTIC_REPOSITORY, RESTIC_PASSWORD plus B2_* / AWS_* credentials for
# the chosen backend) come from the Fly secrets / Railway env. See
# README "Backup & restore" for the runbook.
#
# Exit code is non-zero on ANY failure so the orchestrator can alert.
# ---------------------------------------------------------------------------
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || true

log() {
  printf '[backup %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "FATAL: required env var $name is not set." >&2
    exit 2
  fi
}

require_env DATABASE_URL
require_env RESTIC_REPOSITORY
require_env RESTIC_PASSWORD

DATA_DIR="${DATA_DIR:-/data}"
PHOTOS_DIR="${DATA_DIR}/photos"
AUDIT_LOG_FILE="${DATA_DIR}/audit-verify.log"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

DUMP="${WORK}/db.sql.gz"

log "Dumping Postgres to ${DUMP} ..."
pg_dump --no-owner --no-acl --format=plain "${DATABASE_URL}" \
  | gzip -9 -c > "${DUMP}"
DUMP_SIZE="$(stat -c '%s' "${DUMP}" 2>/dev/null || stat -f '%z' "${DUMP}")"
log "Dump complete (${DUMP_SIZE} bytes)."

log "Ensuring restic repository ${RESTIC_REPOSITORY} is initialised ..."
if ! restic snapshots --quiet >/dev/null 2>&1; then
  log "Repository missing — initialising."
  restic init
fi

PATHS=("${DUMP}")
if [[ -d "${PHOTOS_DIR}" ]]; then
  PATHS+=("${PHOTOS_DIR}")
else
  log "WARN: ${PHOTOS_DIR} does not exist (yet) — skipping."
fi
if [[ -f "${AUDIT_LOG_FILE}" ]]; then
  PATHS+=("${AUDIT_LOG_FILE}")
fi

TODAY="$(date -u +%Y-%m-%d)"
log "Running restic backup for: ${PATHS[*]}"
restic backup \
  --tag stavebni-denik-nightly \
  --tag "date=${TODAY}" \
  --host "${BACKUP_HOSTNAME:-stavebni-denik}" \
  "${PATHS[@]}"

log "Pruning old snapshots (7d / 4w / 12m retention) ..."
restic forget \
  --tag stavebni-denik-nightly \
  --keep-daily 7 \
  --keep-weekly 4 \
  --keep-monthly 12 \
  --prune

log "Backup complete."
