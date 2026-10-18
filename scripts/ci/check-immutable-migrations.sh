#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# A migration that was released never changes (PROJECT.md, "Database": the rule starts with the first release tag).
#
# Flyway keeps a checksum of every versioned migration it has run, so a migration edited after a release makes every
# database that already ran it refuse to migrate, and one that is deleted or renamed leaves the history with a hole. The
# schema changes by adding a new migration (the next V<n>), never by editing an old one.
#
# The baseline is the newest v* tag reachable from HEAD (`git describe`). Compared with the tree of that tag, under
# backend/src/main/resources/db/migration/:
#   - an added file is fine;
#   - a file that was modified, renamed or deleted fails the check (exit 1), and every such file is named.
# Without a v* tag the rule is not active yet: the script says so and exits 0.
#
# `db/grants/app-role.sql` is deliberately not guarded. It is not a versioned migration (no checksum); `migrate` applies
# it again at every release, and a new table or sequence may need it to change.
#
# Run it inside a clone with the full history and the tags (CI: actions/checkout with `fetch-depth: 0`). In a shallow
# clone it fails instead of passing, because a check that cannot see the tags would pass for the wrong reason.
#   bash scripts/ci/check-immutable-migrations.sh        (its own test: check-immutable-migrations.test.sh)
# Needs: bash, git.
# ---------------------------------------------------------------------------
set -euo pipefail

MIGRATIONS_DIR="backend/src/main/resources/db/migration"

log() { printf '[check-migrations] %s\n' "$*"; }
fail() { printf '[check-migrations] FAILED: %s\n' "$*" >&2; exit 1; }

git rev-parse --git-dir >/dev/null 2>&1 || fail "not inside a git repository"
cd "$(git rev-parse --show-toplevel)"

if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  fail "this is a shallow clone, so the tags and the history that the check compares with may be missing. Fetch them all: \`git fetch --unshallow --tags\` (in CI: actions/checkout with \`fetch-depth: 0\`)."
fi

tag="$(git describe --tags --match 'v*' --abbrev=0 HEAD 2>/dev/null || true)"
if [ -z "$tag" ]; then
  log "no v* tag is reachable from HEAD: the rule that a released migration never changes is not active until the first v* tag. Nothing to check."
  exit 0
fi
tag_commit="$(git rev-list -n 1 "$tag")"

released="$(git ls-tree -r --name-only "$tag_commit" -- "$MIGRATIONS_DIR/")"
if [ -z "$released" ]; then
  fail "no file exists under $MIGRATIONS_DIR/ at $tag, so there is nothing to compare, and the check would pass for the wrong reason. Did the migrations move? Then update MIGRATIONS_DIR in this script."
fi
released_count="$(printf '%s\n' "$released" | wc -l | tr -d ' ')"

# Name, status and path(s) of every difference between the release and HEAD under the migration directory.
changes="$(git diff --name-status -M "$tag_commit" HEAD -- "$MIGRATIONS_DIR/")"

violations=""
added=0
while IFS=$'\t' read -r status path_a path_b; do
  case "$status" in
    "") ;;
    A) added=$((added + 1)) ;;
    D) violations+="  deleted:   $path_a"$'\n' ;;
    R*) violations+="  renamed:   $path_a -> $path_b"$'\n' ;;
    *) violations+="  modified:  $path_a"$'\n' ;;
  esac
done <<< "$changes"

if [ -n "$violations" ]; then
  {
    printf '[check-migrations] FAILED: released migrations changed since %s (the newest v* tag reachable from HEAD):\n' "$tag"
    printf '%s' "$violations"
    printf 'A released migration is never edited, renamed or deleted: the databases that ran it hold its checksum.\n'
    printf 'Restore it (git checkout %s -- <file>) and put the change in a new migration, the next V<n>.\n' "$tag"
  } >&2
  exit 1
fi

log "ok: the $released_count migrations of $tag are unchanged ($added added since)."
