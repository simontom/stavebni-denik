#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Backup of the diary: the database (including the audit log) and the photo files, with a manifest and checksums that
# a restore is checked against.  A backup that was never restored is a hope, not a backup: see restore.sh and the CI
# "restore drill", which restores a real backup into an empty database and verifies it.
#
#   BACKUP_ROOT   directory that receives denik-<UTC time>/   (required)
#   UPLOADS_DIR   the uploads directory: it holds photos/     (required)
#   PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE                  the database (standard libpq variables)
#   PG_DOCKER_IMAGE   optional, e.g. postgres:18-alpine: run pg_dump and psql from that image when the local client is older
#                     than the server (pg_dump refuses a newer server). Uses --network host: on Docker Desktop point PGHOST
#                     at host.docker.internal instead of localhost.
#
# The backup directory holds personal data and the evidence itself. Copy it to encrypted storage (restic, age + object
# storage, ...) that the application's machine cannot delete from; this script does not do that.
# ---------------------------------------------------------------------------
set -euo pipefail

: "${BACKUP_ROOT:?BACKUP_ROOT: the directory that receives the backup}"
: "${UPLOADS_DIR:?UPLOADS_DIR: the uploads directory (holds photos/)}"
: "${PGDATABASE:?PGDATABASE: the database to back up}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dir="$BACKUP_ROOT/denik-$stamp"
mkdir -p "$dir"
dir="$(cd "$dir" && pwd)"

log() { printf '[backup %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

# The directory as Docker sees it: Git Bash on Windows needs the Windows path (pwd -W) for a volume mount.
docker_dir="$(cd "$dir" && { pwd -W 2>/dev/null || pwd; })"
# On Linux the container writes as the caller, so the backup is not left owned by root (Docker Desktop maps this itself).
user_args=()
[ "$(uname -s)" = "Linux" ] && user_args=(--user "$(id -u):$(id -g)")
# pg <command> [args...]: from the local client, or from a container when PG_DOCKER_IMAGE is set.
pg() {
  if [ -n "${PG_DOCKER_IMAGE:-}" ]; then
    docker run --rm -i ${user_args[@]+"${user_args[@]}"} --network host -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE \
      -v "$docker_dir:/backup" "$PG_DOCKER_IMAGE" "$@"
  else
    "$@"
  fi
}
backup_path() { if [ -n "${PG_DOCKER_IMAGE:-}" ]; then echo "/backup/$1"; else echo "$dir/$1"; fi; }

query() { pg psql --no-psqlrc -v ON_ERROR_STOP=1 -At -c "$1" | tr -d '\r'; }

log "backing up $PGDATABASE into $dir"

# The newest row of the audit chain BEFORE the dump: the dump holds at least this much, so it is a valid anchor for the
# restored database (an anchor stays valid while the log grows).
audit_head="$(query 'select id::text || chr(58) || "row_hash" from audit_log order by id desc limit 1' || true)"
schema_version="$(query "select coalesce(max(\"version\"::int), 0)::text from flyway_schema_history where success" || true)"

# 1. The database. pg_dump reads one consistent snapshot. No owners and no grants: the restore gives it to whoever restores.
pg pg_dump --format=custom --no-owner --no-privileges --file="$(backup_path db.dump)"
[ -s "$dir/db.dump" ] || { echo "[backup] FAILED: pg_dump left no dump in $dir" >&2; exit 1; }
log "database dumped ($(wc -c < "$dir/db.dump") bytes)"

# 2. The photo files, AFTER the dump: a photo that arrived in between is then an orphan file (harmless), never a database
# row without its file.
if [ -d "$UPLOADS_DIR/photos" ]; then
  tar -C "$UPLOADS_DIR" -czf "$dir/photos.tar.gz" photos
  photo_files="$(find "$UPLOADS_DIR/photos" -type f | wc -l | tr -d ' ')"
else
  tar -czf "$dir/photos.tar.gz" --files-from /dev/null
  photo_files=0
fi
log "photos archived ($photo_files files)"

# 3. The manifest, and checksums of everything in the directory.
cat > "$dir/manifest.json" <<JSON
{
  "createdAtUtc": "$stamp",
  "database": "$PGDATABASE",
  "schemaVersion": ${schema_version:-0},
  "auditHeadBeforeDump": "${audit_head:-}",
  "photoFiles": $photo_files
}
JSON
(cd "$dir" && sha256sum db.dump photos.tar.gz manifest.json > SHA256SUMS)

log "done: $dir"
log "audit head to record elsewhere: ${audit_head:-<empty log>}"
echo "$dir"
