#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# The restore drill: backs a database up with backup.sh, restores it into an EMPTY database with restore.sh (which then
# verifies the photos, the audit chain and every signature), and shows that the restore REFUSES what it must refuse:
#
#   - a target database that already holds tables;
#   - a backup file that was damaged;
#   - a photo that was replaced even though the checksums of the backup were regenerated to match.
#
# A restore that cannot fail proves nothing; this is what makes "the backup restores" a checked statement.
# CI runs it after the end-to-end tests, on the data they left behind (see .github/workflows/ci.yml); an operator can run
# it against production data on a schedule, as long as the server lets the user create a scratch database.
#
#   PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE   the database to back up (the user must be allowed to CREATE DATABASE)
#   UPLOADS_DIR      its uploads directory (holds photos/)
#   APP_JAR          backend-all.jar
#   DRILL_DIR        scratch directory (backups and restored photos are written here)
#   PG_DOCKER_IMAGE  optional, see backup.sh
# ---------------------------------------------------------------------------
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${PGDATABASE:?PGDATABASE: the database to back up}"
: "${UPLOADS_DIR:?UPLOADS_DIR}"
: "${APP_JAR:?APP_JAR}"
: "${DRILL_DIR:?DRILL_DIR}"

log() { printf '[drill %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
fail() { printf '[drill] DRILL FAILED: %s\n' "$*" >&2; exit 1; }

# SQL against the server's maintenance database.
admin() {
  if [ -n "${PG_DOCKER_IMAGE:-}" ]; then
    docker run --rm --network host -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE=postgres \
      "$PG_DOCKER_IMAGE" psql --no-psqlrc -v ON_ERROR_STOP=1 -q -c "$1"
  else
    PGDATABASE=postgres psql --no-psqlrc -v ON_ERROR_STOP=1 -q -c "$1"
  fi
}

scratch_dbs=()
new_db() { admin "create database $1"; scratch_dbs+=("$1"); }
cleanup() {
  for db in "${scratch_dbs[@]:-}"; do
    [ -n "$db" ] && admin "drop database if exists $db with (force)" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

restore_into() { # <backup directory> <database>
  PGDATABASE="$2" RESTORE_UPLOADS_DIR="$DRILL_DIR/restored-photos-$2" APP_JAR="$APP_JAR" bash "$here/restore.sh" "$1"
}

# restore_refused <expected text in the refusal> <backup directory> <database>
restore_refused() {
  local expected="$1" out
  if out="$(restore_into "$2" "$3" 2>&1)"; then
    printf '%s\n' "$out" >&2
    fail "the restore accepted something it must refuse (expected: $expected)"
  fi
  printf '%s\n' "$out" | grep -q "$expected" || { printf '%s\n' "$out" >&2; fail "the restore refused, but not for the expected reason ($expected)"; }
  log "refused as it must: $expected"
}

# The scratch directory is created or must be empty: the drill never deletes something it did not create.
if [ -d "$DRILL_DIR" ] && [ -n "$(ls -A "$DRILL_DIR")" ]; then fail "DRILL_DIR $DRILL_DIR is not empty"; fi
mkdir -p "$DRILL_DIR"
DRILL_DIR="$(cd "$DRILL_DIR" && pwd)"   # absolute and in the shell's own path style (GNU tar reads "C:" as a host)

# 1. A backup of the real thing. It must hold something to prove.
BACKUP_ROOT="$DRILL_DIR/backups" bash "$here/backup.sh" | tee "$DRILL_DIR/backup.log"
backup="$(tail -n 1 "$DRILL_DIR/backup.log")"
grep -q '"auditHeadBeforeDump": ""' "$backup/manifest.json" && fail "the audit log is empty: there is nothing for the drill to prove"
grep -q '"photoFiles": 0' "$backup/manifest.json" && fail "no photo files: there is nothing for the drill to prove"

# 2. It restores into an empty database and verifies.
new_db drill_restore
restore_into "$backup" drill_restore

# 3. Nothing is restored over existing data.
restore_refused "is not empty" "$backup" drill_restore

# 4. A damaged backup file is noticed before anything is restored.
damaged="$DRILL_DIR/damaged"
cp -r "$backup" "$damaged"
printf 'x' >> "$damaged/photos.tar.gz"
restore_refused "backup is damaged" "$damaged" drill_restore_damaged

# 5. A replaced photo is noticed even when the backup's own checksums were regenerated to match it.
swapped="$DRILL_DIR/swapped"
cp -r "$backup" "$swapped"
mkdir "$DRILL_DIR/swapped-photos"
tar -C "$DRILL_DIR/swapped-photos" -xzf "$swapped/photos.tar.gz"
victim="$(find "$DRILL_DIR/swapped-photos" -type f | sed -n 1p)"
printf 'not the photo that was uploaded' > "$victim"
tar -C "$DRILL_DIR/swapped-photos" -czf "$swapped/photos.tar.gz" photos
(cd "$swapped" && sha256sum db.dump photos.tar.gz manifest.json > SHA256SUMS)
new_db drill_restore_swapped
restore_refused "missing or changed" "$swapped" drill_restore_swapped

log "drill passed: the backup restores and verifies, and the restore refuses what it must refuse"
