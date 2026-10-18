#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Test of check-immutable-migrations.sh. Every case builds a throwaway git repository in a temp directory, with Flyway
# migrations laid out as in this repository, tags it the way a release is tagged, changes it, and runs the guard there.
#
#   no tag, and a tag that is not a v* tag    the guard is not active: exit 0 and says so
#   unchanged, added file, other files        exit 0 (new migrations are how the schema changes)
#   modified, deleted, renamed file           exit 1, naming each file
#   several violations at once                every one of them is named
#   older v* tag, newer v* tag                the newest tag is the baseline
#   a shallow clone                           exit 1: a guard that cannot see the tags must not pass quietly
#   a tag with no migrations under the path   exit 1: a guard that checks nothing must not pass quietly
#
# Needs: bash and git. Takes a few seconds. Run: bash scripts/ci/check-immutable-migrations.test.sh
# ---------------------------------------------------------------------------
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
guard="$here/check-immutable-migrations.sh"
MIG="backend/src/main/resources/db/migration"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

passed=0
failed=0
out=""
code=0

[ -f "$guard" ] || { printf '[migrations-test] FAILED: %s does not exist\n' "$guard" >&2; exit 1; }

# --- helpers -----------------------------------------------------------------------------------------------------------
g() { local d="$1"; shift; git -C "$d" "$@"; }

# A repository with two migrations, one grants file and one unrelated file, on main. Prints its path.
new_repo() {
  local d
  d="$(mktemp -d "$work/repo.XXXXXX")"
  git -C "$d" init -q
  git -C "$d" symbolic-ref HEAD refs/heads/main
  for kv in user.name=Test user.email=test@example.invalid commit.gpgsign=false tag.gpgSign=false core.autocrlf=false; do
    git -C "$d" config "${kv%%=*}" "${kv#*=}"
  done
  mkdir -p "$d/$MIG" "$d/backend/src/main/resources/db/grants"
  printf 'create table a (id int);\n' > "$d/$MIG/V1__a.sql"
  printf 'create table b (id int);\n' > "$d/$MIG/V2__b.sql"
  printf 'grant select on all tables to app;\n' > "$d/backend/src/main/resources/db/grants/app-role.sql"
  printf 'readme\n' > "$d/README.md"
  commit "$d" "initial"
  printf '%s' "$d"
}

commit() { git -C "$1" add -A; git -C "$1" commit -q -m "$2"; }
lightweight_tag() { git -C "$1" tag "$2"; }
annotated_tag() { git -C "$1" tag -a -m "release $2" "$2"; }

# Runs the guard inside the repository; sets $out (stdout and stderr) and $code.
run_guard() {
  code=0
  out="$(cd "$1" && bash "$guard" 2>&1)" || code=$?
}

check() { # name, wanted exit code, then every text the output must contain
  local name="$1" want="$2"
  shift 2
  local ok=1 why=""
  if [ "$code" -ne "$want" ]; then ok=0; why="exit code $code, wanted $want"; fi
  local needle
  for needle in "$@"; do
    case "$out" in
      *"$needle"*) ;;
      *) ok=0; why="${why:+$why; }output lacks: $needle" ;;
    esac
  done
  if [ "$ok" -eq 1 ]; then
    passed=$((passed + 1))
    printf '[migrations-test] ok      %s\n' "$name"
  else
    failed=$((failed + 1))
    printf '[migrations-test] FAILED  %s: %s\n--- output ---\n%s\n--------------\n' "$name" "$why" "$out" >&2
  fi
}

check_absent() { # name, text that the output must not contain
  case "$out" in
    *"$2"*)
      failed=$((failed + 1))
      printf '[migrations-test] FAILED  %s: output names %s\n--- output ---\n%s\n--------------\n' "$1" "$2" "$out" >&2 ;;
    *) passed=$((passed + 1)); printf '[migrations-test] ok      %s\n' "$1" ;;
  esac
}

# --- cases -------------------------------------------------------------------------------------------------------------
# 1. No tag at all: the rule starts with the first v* tag.
d="$(new_repo)"
printf 'create table changed (id int);\n' > "$d/$MIG/V1__a.sql"   # would be a violation, if a release existed
commit "$d" "edit V1 before any release"
run_guard "$d"
check "no tag: not active, exit 0" 0 "not active until the first v* tag"

# 2. A tag that is not a v* tag does not activate it.
d="$(new_repo)"
lightweight_tag "$d" "release-1"
annotated_tag "$d" "snapshot"
printf 'create table changed (id int);\n' > "$d/$MIG/V1__a.sql"
commit "$d" "edit V1"
run_guard "$d"
check "tags that are not v* tags are ignored" 0 "not active until the first v* tag"

# 3. Nothing under the migration directory changed since the tag; everything else did.
d="$(new_repo)"
lightweight_tag "$d" "v1.0.0"
printf 'other\n' >> "$d/README.md"
printf 'grant all on all tables to app;\n' > "$d/backend/src/main/resources/db/grants/app-role.sql"
mkdir -p "$d/frontend" && printf '{}\n' > "$d/frontend/package.json"
commit "$d" "unrelated changes"
run_guard "$d"
check "unchanged since the tag (other files and the grants may change), exit 0" 0 "v1.0.0"

# 4. A new migration is how the schema changes.
d="$(new_repo)"
annotated_tag "$d" "v1.0.0"
printf 'create table c (id int);\n' > "$d/$MIG/V3__c.sql"
commit "$d" "add V3"
run_guard "$d"
check "an added migration is fine, exit 0" 0 "v1.0.0"

# 5. A released migration was edited.
d="$(new_repo)"
lightweight_tag "$d" "v1.0.0"
printf 'create table a (id int, extra text);\n' > "$d/$MIG/V1__a.sql"
commit "$d" "edit V1"
run_guard "$d"
check "a modified migration fails, naming the file" 1 "$MIG/V1__a.sql" "v1.0.0"
check_absent "the untouched migration is not named" "V2__b.sql"

# 6. A released migration was deleted.
d="$(new_repo)"
annotated_tag "$d" "v1.0.0"
git -C "$d" rm -q "$MIG/V2__b.sql"
commit "$d" "delete V2"
run_guard "$d"
check "a deleted migration fails, naming the file" 1 "$MIG/V2__b.sql"

# 7. A released migration was renamed (the same content under another version or name).
d="$(new_repo)"
lightweight_tag "$d" "v1.0.0"
git -C "$d" mv "$MIG/V2__b.sql" "$MIG/V3__b.sql"
commit "$d" "renumber V2 to V3"
run_guard "$d"
check "a renamed migration fails, naming the old and the new name" 1 "$MIG/V2__b.sql" "$MIG/V3__b.sql" "renamed"

# 8. Every violation is reported, together with the one thing that is allowed.
d="$(new_repo)"
lightweight_tag "$d" "v1.0.0"
printf 'create table a (id bigint);\n' > "$d/$MIG/V1__a.sql"
git -C "$d" rm -q "$MIG/V2__b.sql"
printf 'create table c (id int);\n' > "$d/$MIG/V3__c.sql"
commit "$d" "edit V1, delete V2, add V3"
run_guard "$d"
check "all violations are named at once" 1 "$MIG/V1__a.sql" "$MIG/V2__b.sql"
check_absent "an added migration is not named as a violation" "V3__c.sql"

# 9. The newest tag is the baseline: a change before the latest release was part of that release.
d="$(new_repo)"
lightweight_tag "$d" "v1.0.0"
printf 'create table a (id bigint);\n' > "$d/$MIG/V1__a.sql"
commit "$d" "edit V1 (between the releases)"
lightweight_tag "$d" "v2.0.0"
printf 'create table c (id int);\n' > "$d/$MIG/V3__c.sql"
commit "$d" "add V3"
run_guard "$d"
check "the newest v* tag is the baseline, exit 0" 0 "v2.0.0"

# 10. ... and an edit after that newest tag is a violation.
printf 'create table a (id smallint);\n' > "$d/$MIG/V1__a.sql"
commit "$d" "edit V1 after v2.0.0"
run_guard "$d"
check "an edit after the newest tag fails" 1 "$MIG/V1__a.sql" "v2.0.0"

# 11. A tag on a branch that HEAD does not contain is not a baseline.
d="$(new_repo)"
git -C "$d" checkout -q -b elsewhere
printf 'create table a (id bigint);\n' > "$d/$MIG/V1__a.sql"
commit "$d" "edit V1 on another branch"
lightweight_tag "$d" "v9.9.9"
git -C "$d" checkout -q main
run_guard "$d"
check "a v* tag that HEAD does not contain is ignored" 0 "not active until the first v* tag"

# 12. A shallow clone cannot see the tags: refuse, do not pass quietly.
d="$(new_repo)"
lightweight_tag "$d" "v1.0.0"
printf 'x\n' >> "$d/README.md"
commit "$d" "second commit, so that a depth-1 clone is shallow"
src="$(cd "$d" && { pwd -W 2>/dev/null || pwd; })"
case "$src" in /*) url="file://$src" ;; *) url="file:///$src" ;; esac
git clone -q --depth 1 "$url" "$work/shallow" 2>/dev/null
run_guard "$work/shallow"
check "a shallow clone fails and asks for the full history" 1 "shallow" "fetch-depth: 0"

# 13. A tag at which the guarded directory holds no migration: the guard would check nothing.
d="$(new_repo)"
git -C "$d" rm -q -r "$MIG"
commit "$d" "no migrations yet"
lightweight_tag "$d" "v0.0.1"
mkdir -p "$d/$MIG" && printf 'create table a (id int);\n' > "$d/$MIG/V1__a.sql"
commit "$d" "first migration after the tag"
run_guard "$d"
check "a tag without migrations under the path fails" 1 "$MIG" "v0.0.1"

# --- result ------------------------------------------------------------------------------------------------------------
printf '[migrations-test] %d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
