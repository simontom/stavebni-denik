#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Records the head of the audit-log hash chain OUTSIDE the database (decision D4), with a trusted timestamp.
#
# Why: the hash chain proves that no row was changed in the middle. It cannot prove that the newest rows were not cut off,
# or that the whole log was not rebuilt, by someone who owns the database. A copy of the head kept where that person cannot
# write, with a timestamp from an independent authority (RFC 3161), makes both visible: `audit-verify <anchor>` fails when
# the row named by the anchor is missing or changed.
#
# What one run does, in this order (any failure stops it BEFORE anything is recorded):
#   1. takes the newest record in the anchor repository and checks that its timestamp token still verifies;
#   2. verifies the whole chain against that record's head (`audit-verify <head>`): intact, and not cut below it;
#   3. reads the new head (`audit-head`; it refuses a damaged chain);
#   4. writes anchors/anchor-<UTC time>.txt (the head, the time, the previous record and its SHA-256), asks the time-stamping
#      authority for a token over that file, and verifies the token against the authority's certificate;
#   5. commits the three files (record, request, token) in the anchor repository. It does NOT push: the caller does, so that
#      a rejected push (somebody rewrote the history) fails the run.
#
#   APP_JAR           backend-all.jar
#   JDBC_URL DB_USER DB_PASSWORD   the database; a role that can only SELECT from audit_log is enough
#   ANCHOR_REPO_DIR   a working copy of the private anchor repository, on the branch that is pushed. The git identity of the
#                     committer must be configured there.
#   TSA_URL           the RFC 3161 time-stamping authority, e.g. https://freetsa.org/tsr
#   TSA_CA_FILE       the authority's CA certificate (PEM). Default: $ANCHOR_REPO_DIR/tsa/ca.pem. KEEP IT IN THE ANCHOR
#                     REPOSITORY, committed once by a person who got it from the authority and compared its fingerprint: a
#                     token that is checked against a certificate fetched on every run proves nothing.
#   TSA_CERT_FILE     the authority's signing certificate, when the token does not carry it. Default: $ANCHOR_REPO_DIR/tsa/tsa.pem
#                     (used when the file exists).
#
# Exit codes: 0 recorded; 1 the chain or a record is NOT intact (treat as a security incident); 2 not configured;
#             3 the run could not be completed (database, authority or git unreachable). Nothing is recorded in 1, 2, 3.
# ---------------------------------------------------------------------------
set -euo pipefail

log() { printf '[audit-anchor %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
refuse() { printf '[audit-anchor] NOT RECORDED: %s\n' "$2" >&2; exit "$1"; }

: "${APP_JAR:?APP_JAR: backend-all.jar}"
: "${ANCHOR_REPO_DIR:?ANCHOR_REPO_DIR: a working copy of the private anchor repository}"
: "${TSA_URL:?TSA_URL: the RFC 3161 time-stamping authority}"
for v in JDBC_URL DB_USER DB_PASSWORD; do
  [ -n "${!v:-}" ] || refuse 2 "$v is not set (the database the audit log is read from)"
done
[ -d "$ANCHOR_REPO_DIR/.git" ] || refuse 2 "$ANCHOR_REPO_DIR is not a git working copy"
[ -f "$APP_JAR" ] || refuse 2 "$APP_JAR does not exist"

records="$ANCHOR_REPO_DIR/anchors"
ca="${TSA_CA_FILE:-$ANCHOR_REPO_DIR/tsa/ca.pem}"
cert="${TSA_CERT_FILE:-$ANCHOR_REPO_DIR/tsa/tsa.pem}"
[ -f "$ca" ] || refuse 2 "the authority's CA certificate $ca is missing (commit it to the anchor repository first)"
verify_opts=(-CAfile "$ca")
[ -f "$cert" ] && verify_opts+=(-untrusted "$cert")

cli() { java -cp "$APP_JAR" cz.stavebni.denik.cli.AdminCliKt "$@"; }
valid_head() { [[ "$1" =~ ^[0-9]+:[0-9a-f]{64}$ ]]; }
sha256() { sha256sum "$1" | cut -d' ' -f1; }
token_ok() { openssl ts -verify -data "$1" -in "$2" "${verify_opts[@]}" >/dev/null 2>&1; }

mkdir -p "$records"
created=()
cleanup() { [ "${#created[@]}" -eq 0 ] || rm -f "${created[@]}"; }
trap cleanup EXIT

# 1. The previous record: it is only trusted while its own token verifies.
previous="$(find "$records" -maxdepth 1 -name 'anchor-*.txt' | sort | tail -n 1)"
previous_head=""
if [ -n "$previous" ]; then
  [ -s "${previous%.txt}.tsr" ] || refuse 1 "$(basename "$previous") has no timestamp token"
  token_ok "$previous" "${previous%.txt}.tsr" \
    || refuse 1 "$(basename "$previous") does not match its timestamp token (the record was changed, or the authority's certificate is not the one that signed it)"
  previous_head="$(sed -n 's/^head: //p' "$previous" | head -n 1)"
  valid_head "$previous_head" || refuse 1 "$(basename "$previous") does not name a head"
  log "previous record: $(basename "$previous"), head $previous_head"
else
  log "no previous record: this is the first anchor (a cut tail cannot be detected before it exists)"
fi

# 2. The chain, against the previous head. Exit 1 = broken, 3 = could not run.
set +e
if [ -n "$previous_head" ]; then cli audit-verify "$previous_head"; else cli audit-verify; fi
code=$?
set -e
case "$code" in
  0) ;;
  1) refuse 1 "the audit log does not verify${previous_head:+ against the recorded head $previous_head}: it was changed or cut. Treat this as a security incident" ;;
  *) refuse 3 "the audit log could not be checked (exit $code)" ;;
esac

# 3. The new head (the command refuses a damaged or empty chain).
head="$(cli audit-head)" || refuse 3 "the head of the audit log could not be read"
head="$(printf '%s' "$head" | tr -d '\r\n')"
valid_head "$head" || refuse 3 "unexpected output of audit-head: '$head'"
if [ -n "$previous_head" ] && [ "${head%%:*}" -lt "${previous_head%%:*}" ]; then
  refuse 1 "the head $head is older than the recorded $previous_head: the log was cut"
fi

# 4. The record and its token.
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
record="$records/anchor-$stamp.txt"
[ ! -e "$record" ] || refuse 3 "$record exists already (two runs in the same second)"
created+=("$record" "${record%.txt}.tsq" "${record%.txt}.tsr")
{
  echo "stavebni-denik audit anchor 1"
  echo "head: $head"
  echo "recordedAt: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ -n "$previous" ]; then echo "previous: $(basename "$previous") sha256:$(sha256 "$previous")"; else echo "previous: none"; fi
} > "$record"

openssl ts -query -data "$record" -sha256 -cert -out "${record%.txt}.tsq" 2>/dev/null || refuse 3 "could not create the timestamp request"
curl --fail --silent --show-error --max-time 60 --retry 2 --retry-delay 5 \
  -H 'Content-Type: application/timestamp-query' --data-binary "@${record%.txt}.tsq" \
  -o "${record%.txt}.tsr" "$TSA_URL" || refuse 3 "the time-stamping authority $TSA_URL did not answer"
token_ok "$record" "${record%.txt}.tsr" \
  || refuse 3 "the token of $TSA_URL does not verify against $ca (wrong authority certificate, or a refused request)"
log "timestamp: $(openssl ts -reply -in "${record%.txt}.tsr" -text 2>/dev/null | sed -n 's/^Time stamp: //p' | head -n 1)"

# 5. Commit. The caller pushes.
# The records are hashed and time-stamped byte for byte: git must never touch their line endings (autocrlf on a Windows
# checkout would break every token).
attributes="$ANCHOR_REPO_DIR/.gitattributes"
grep -qxF 'anchors/* -text' "$attributes" 2>/dev/null || printf 'anchors/* -text\n' >> "$attributes"
base="$(basename "${record%.txt}")"
git -C "$ANCHOR_REPO_DIR" add -- .gitattributes "anchors/$base.txt" "anchors/$base.tsq" "anchors/$base.tsr"
git -C "$ANCHOR_REPO_DIR" commit -q -m "audit anchor $head ($stamp)" \
  || { git -C "$ANCHOR_REPO_DIR" reset -q; refuse 3 "could not commit in $ANCHOR_REPO_DIR (is a git identity configured?)"; }
created=()
log "recorded $head in $(basename "$record"); push $ANCHOR_REPO_DIR now"
