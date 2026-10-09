#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Restores a backup made by backup.sh into an EMPTY database and EMPTY uploads directory, and then PROVES the result:
#
#   1. the checksums of the backup files are correct;
#   2. pg_restore finishes without an error;
#   3. every photo file matches the SHA-256 recorded at upload;
#   4. (when APP_JAR is given) the audit-log hash chain verifies and still contains the row the manifest recorded, and
#      every signed entry and its photos hash to what was recorded at signing.
#
# It refuses to restore over anything: the database must have no tables and the uploads directory must not exist or be
# empty. A restore never overwrites live data; to replace a damaged database, restore into a fresh one and switch over.
#
#   usage: restore.sh <backup directory>
#   PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE   the EMPTY target database (standard libpq variables); the user must be
#                                                allowed to create objects in it (the owner)
#   RESTORE_UPLOADS_DIR   where the photos are extracted (required)
#   APP_JAR               optional: backend-all.jar, to run audit-verify and verify-signatures against the restored database
#   PG_DOCKER_IMAGE       optional, as in backup.sh (--network host; on Docker Desktop use host.docker.internal)
#
# After a real restore: run `bootstrap-app-role.sql` and the `migrate` command (it applies no migration to an up-to-date
# schema and gives the application's role its privileges) before starting the application.
# ---------------------------------------------------------------------------
set -euo pipefail

backup="${1:?usage: restore.sh <backup directory>}"
: "${PGDATABASE:?PGDATABASE: the empty target database}"
: "${RESTORE_UPLOADS_DIR:?RESTORE_UPLOADS_DIR: where the photos are extracted}"

log() { printf '[restore %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
fail() { printf '[restore] RESTORE DRILL FAILED: %s\n' "$*" >&2; exit 1; }

backup="$(cd "$backup" && pwd)"
[ -f "$backup/db.dump" ] && [ -f "$backup/SHA256SUMS" ] || fail "$backup is not a backup directory"

# The directory as Docker sees it: Git Bash on Windows needs the Windows path (pwd -W) for a volume mount.
docker_backup="$(cd "$backup" && { pwd -W 2>/dev/null || pwd; })"
pg() {
  if [ -n "${PG_DOCKER_IMAGE:-}" ]; then
    docker run --rm -i --network host -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE \
      -v "$docker_backup:/backup:ro" "$PG_DOCKER_IMAGE" "$@"
  else
    "$@"
  fi
}
backup_path() { if [ -n "${PG_DOCKER_IMAGE:-}" ]; then echo "/backup/$1"; else echo "$backup/$1"; fi; }
query() { pg psql --no-psqlrc -v ON_ERROR_STOP=1 -At -c "$1" | tr -d '\r'; }

# 1. The files are what was written.
(cd "$backup" && sha256sum --check --quiet SHA256SUMS) || fail "the checksums of the backup do not match: the backup is damaged"
log "checksums ok"

# The target must be empty: nothing is ever restored over existing data.
existing="$(query "select count(*) from information_schema.tables where table_schema = 'public'")"
[ "$existing" = "0" ] || fail "the target database '$PGDATABASE' is not empty ($existing tables). Restore into a fresh database."
if [ -d "$RESTORE_UPLOADS_DIR" ] && [ -n "$(ls -A "$RESTORE_UPLOADS_DIR")" ]; then
  fail "RESTORE_UPLOADS_DIR '$RESTORE_UPLOADS_DIR' is not empty"
fi

# 2. The database.
pg pg_restore --no-owner --no-privileges --exit-on-error --dbname="$PGDATABASE" "$(backup_path db.dump)" \
  || fail "pg_restore reported an error"
log "database restored"

# The photos.
mkdir -p "$RESTORE_UPLOADS_DIR"
tar -C "$RESTORE_UPLOADS_DIR" -xzf "$backup/photos.tar.gz"
log "photos extracted ($(find "$RESTORE_UPLOADS_DIR" -type f | wc -l | tr -d ' ') files)"

# 3. Every photo the database knows (with a recorded hash) is on disk and is the file that was uploaded.
# The list is read first: a failing query must stop the restore, not look like "no photos".
photo_list="$(query "select \"pathOriginal\" || '|' || \"sha256\" from photos where \"deletedAt\" is null and \"sha256\" is not null
                   union all
                   select \"pathThumb\" || '|' || \"thumbSha256\" from photos where \"deletedAt\" is null and \"thumbSha256\" is not null")"
checked=0
bad=0
while IFS='|' read -r key digest; do
  [ -n "$key" ] || continue
  file="$RESTORE_UPLOADS_DIR/$key"
  if [ ! -f "$file" ]; then
    echo "[restore] missing photo file: $key" >&2; bad=$((bad + 1)); continue
  fi
  actual="$(sha256sum "$file" | cut -d' ' -f1)"
  if [ "$actual" != "$digest" ]; then
    echo "[restore] photo file does not match its recorded hash: $key" >&2; bad=$((bad + 1))
  fi
  checked=$((checked + 1))
done <<< "$photo_list"
[ "$bad" -eq 0 ] || fail "$bad photo file(s) are missing or changed"
log "photo files verified against their recorded hashes ($checked checked)"

# 4. The application's own checks, against the restored database.
if [ -n "${APP_JAR:-}" ]; then
  anchor="$(sed -n 's/.*"auditHeadBeforeDump": "\([^"]*\)".*/\1/p' "$backup/manifest.json")"
  export JDBC_URL="jdbc:postgresql://${PGHOST:-localhost}:${PGPORT:-5432}/$PGDATABASE"
  # The JVM wants the path in the operating system's own style (on Windows, Git Bash's /tmp/... is not one).
  uploads_native="$(cd "$RESTORE_UPLOADS_DIR" && { pwd -W 2>/dev/null || pwd; })"
  export DB_USER="${PGUSER:?PGUSER}" DB_PASSWORD="${PGPASSWORD:?PGPASSWORD}" UPLOADS_DIR="$uploads_native"
  cli() { java -cp "$APP_JAR" cz.stavebni.denik.cli.AdminCliKt "$@"; }
  if [ -n "$anchor" ]; then
    cli audit-verify "$anchor" || fail "the audit chain does not verify against the anchor $anchor"
  else
    cli audit-verify || fail "the audit chain does not verify"
  fi
  cli verify-signatures || fail "a signed entry or a photo no longer matches its signature"
else
  log "APP_JAR not given: the audit chain and the signatures were not checked"
fi

log "restore drill passed: the backup restores into an empty database, and what was signed is as it was signed"
