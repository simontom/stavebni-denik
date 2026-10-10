#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Test of record-anchor.sh against a real database and a real RFC 3161 exchange: a throwaway time-stamping authority (a test
# CA and `openssl ts -reply` behind a local HTTP server) signs the records, and every check the script makes is the real one.
#
# It shows that the recording WORKS (a first record, then one that names the first), and that it REFUSES what it must refuse,
# recording nothing each time:
#   - an unreachable time-stamping authority;
#   - a previous record that was edited after it was time-stamped;
#   - an audit log that no longer contains the row an earlier record named (a log that was cut or rebuilt);
#   - a time-stamping authority that is not the one whose certificate is pinned.
#
#   APP_JAR                       backend-all.jar
#   JDBC_URL DB_USER DB_PASSWORD  a database with at least one audit_log row (the tests leave one)
# Needs: bash, git, openssl (3.x), curl, node, java.
# ---------------------------------------------------------------------------
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${APP_JAR:?APP_JAR}"
for v in JDBC_URL DB_USER DB_PASSWORD; do : "${!v:?$v}"; done

work="$(mktemp -d)"
tsa_pid=""
cleanup() {
  [ -z "$tsa_pid" ] || kill "$tsa_pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT
log() { printf '[anchor-test] %s\n' "$*"; }
fail() { printf '[anchor-test] FAILED: %s\n' "$*" >&2; exit 1; }

# --- a test time-stamping authority ------------------------------------------------------------------------------------
tsa="$work/tsa"; mkdir -p "$tsa"
(
  cd "$tsa"
  # Git Bash on Windows must not rewrite "/CN=..." into a path (git and node, on the other hand, need the converted ones).
  MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 2 -subj "/CN=Test TSA CA" 2>/dev/null
  MSYS_NO_PATHCONV=1 openssl req -newkey rsa:2048 -nodes -keyout tsa.key -out tsa.csr -subj "/CN=Test TSA" 2>/dev/null
  printf 'extendedKeyUsage = critical, timeStamping\n' > tsa.ext
  openssl x509 -req -in tsa.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out tsa.pem -days 2 -extfile tsa.ext 2>/dev/null
  echo 01 > tsa_serial
  cat > tsa.conf <<'CONF'
[ tsa ]
default_tsa = tsa_config1
[ tsa_config1 ]
dir = .
serial = $dir/tsa_serial
crypto_device = builtin
signer_cert = $dir/tsa.pem
certs = $dir/ca.pem
signer_key = $dir/tsa.key
signer_digest = sha256
default_policy = 1.2.3.4.1
other_policies = 1.2.3.4.5.6
digests = sha256, sha512
accuracy = secs:1
ordering = yes
tsa_name = yes
ess_cert_id_chain = no
ess_cert_id_alg = sha256
CONF
)
# node on Windows needs native paths (Git Bash passes them through untouched here); elsewhere cygpath does not exist.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
node "$(native "$here/fake-tsa.mjs")" "$(native "$tsa")" "$(native "$work/port")" &
tsa_pid=$!
for _ in $(seq 1 50); do [ -s "$work/port" ] && break; sleep 0.2; done
[ -s "$work/port" ] || fail "the test time-stamping authority did not start"
TSA_URL="http://127.0.0.1:$(cat "$work/port")/tsr"
export TSA_URL
log "test time-stamping authority at $TSA_URL"

# --- an anchor repository with a remote ---------------------------------------------------------------------------------
git init -q --bare "$work/remote.git"
git clone -q "$work/remote.git" "$work/anchors-repo" 2>/dev/null
repo="$work/anchors-repo"
git -C "$repo" config user.name "audit-anchor-test"
git -C "$repo" config user.email "audit-anchor-test@example.invalid"
mkdir -p "$repo/tsa"
cp "$tsa/ca.pem" "$repo/tsa/ca.pem"
git -C "$repo" add tsa
git -C "$repo" commit -q -m "pin the time-stamping authority"
git -C "$repo" branch -M main
git -C "$repo" push -q origin main

export ANCHOR_REPO_DIR="$repo"
record() { bash "$here/record-anchor.sh"; }
commits() { git -C "$repo" rev-list --count HEAD; }
records_of() { find "$repo/anchors" -maxdepth 1 -name 'anchor-*.txt' 2>/dev/null | sort; }
# refused <expected exit code> <expected text> <what>: record-anchor.sh must fail that way and leave the repository as it was.
refused() {
  local code="$1" text="$2" what="$3" before tree out rc
  before="$(commits)"
  tree="$(git -C "$repo" status --porcelain)"
  set +e; out="$(record 2>&1)"; rc=$?; set -e
  [ "$rc" -eq "$code" ] || { printf '%s\n' "$out" >&2; fail "$what: expected exit $code, got $rc"; }
  printf '%s' "$out" | grep -q "$text" || { printf '%s\n' "$out" >&2; fail "$what: the refusal does not say '$text'"; }
  [ "$(commits)" = "$before" ] || fail "$what: a commit was made"
  [ "$(git -C "$repo" status --porcelain)" = "$tree" ] || fail "$what: files were left behind"
  log "refused as it must: $what"
}

# --- 1. the first record -------------------------------------------------------------------------------------------------
record
[ "$(records_of | wc -l)" -eq 1 ] || fail "the first run did not leave exactly one record"
first="$(records_of | head -n 1)"
grep -q '^previous: none$' "$first" || fail "the first record should name no previous one"
for ext in txt tsq tsr; do [ -s "${first%.txt}.$ext" ] || fail "the first record has no .$ext file"; done
head_now="$(java -cp "$APP_JAR" cz.stavebni.denik.cli.AdminCliKt audit-head | tr -d '\r\n')"
grep -q "^head: $head_now$" "$first" || fail "the first record does not hold the head of the audit log ($head_now)"
openssl ts -verify -data "$first" -in "${first%.txt}.tsr" -CAfile "$tsa/ca.pem" >/dev/null 2>&1 || fail "the token of the first record does not verify on its own"
git -C "$repo" push -q origin main
log "first record: $(basename "$first") holds $head_now"

# --- 2. the second record names the first --------------------------------------------------------------------------------
sleep 1   # records are named by the second
record
[ "$(records_of | wc -l)" -eq 2 ] || fail "the second run did not add exactly one record"
second="$(records_of | tail -n 1)"
want="previous: $(basename "$first") sha256:$(sha256sum "$first" | cut -d' ' -f1)"
grep -qxF "$want" "$second" || fail "the second record does not name the first with its hash (wanted: $want)"
git -C "$repo" push -q origin main
log "second record names the first"

# --- 3. what must be refused ---------------------------------------------------------------------------------------------
sleep 1
TSA_URL="http://127.0.0.1:9/tsr" refused 3 "did not answer" "an unreachable time-stamping authority"

# a previous record edited after it was time-stamped
cp "$second" "$work/second.bak"
sed -i 's/^recordedAt: .*/recordedAt: 2020-01-01T00:00:00Z/' "$second"
refused 1 "does not match its timestamp token" "a previous record that was edited after it was time-stamped"
cp "$work/second.bak" "$second"
[ -z "$(git -C "$repo" status --porcelain)" ] || fail "restoring the record left changes"

# a record (properly time-stamped!) that names a row the log does not hold: the log was cut or rebuilt
forged="$repo/anchors/anchor-99990101T000000Z"
printf 'stavebni-denik audit anchor 1\nhead: %s\nrecordedAt: 9999-01-01T00:00:00Z\nprevious: none\n' \
  "$(sed -n 's/^head: //p' "$second" | sed 's/:.*$/:/')$(printf '0%.0s' $(seq 1 64))" > "$forged.txt"
openssl ts -query -data "$forged.txt" -sha256 -cert -out "$forged.tsq" 2>/dev/null
curl -fsS --max-time 30 -H 'Content-Type: application/timestamp-query' --data-binary "@$forged.tsq" -o "$forged.tsr" "$TSA_URL"
git -C "$repo" add anchors
git -C "$repo" commit -q -m "a forged record (test)"
refused 1 "does not verify against the recorded head" "an audit log that lacks the row an earlier record named"
git -C "$repo" reset -q --hard HEAD~1

# a pinned certificate that is not the one that signed the records
(cd "$work" && MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -keyout other.key -out other.pem -days 2 -subj "/CN=Some other CA" 2>/dev/null)
TSA_CA_FILE="$work/other.pem" refused 1 "does not match its timestamp token" "a pinned certificate that is not the one that signed the records"

# --- 4. and it still works after all that --------------------------------------------------------------------------------
sleep 1
record
[ "$(records_of | wc -l)" -eq 3 ] || fail "the run after the refusals did not record"
log "anchor test passed"
