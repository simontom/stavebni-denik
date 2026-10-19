#!/usr/bin/env python3
"""Reference verifier of the audit hash, version 2 (Python standard library only).

It is written from the specification in PROJECT.md ("Audit log"), not from the Kotlin code, and shows what somebody who
receives a project's part of the audit chain (its own rows in full, everybody else's as stubs) has to compute.

  python3 verify-audit-hash.py vectors <audit-hash-v2-vectors.json>   recompute the golden vectors and a chain made of them
  python3 verify-audit-hash.py chain <rows.json>                      verify a chain: a JSON list of rows (see verify_chain)

Exit status: 0 everything holds, 1 something does not fit, 2 wrong usage.
"""
import json
import sys

# --- specification begin (PROJECT.md quotes this block; a test compares them) ---
import hashlib
import struct

GENESIS = "0" * 64


def lp(data):
    """A field: its length as 4 bytes, big-endian, then the bytes."""
    return struct.pack(">I", len(data)) + data


def payload_digest(salt_hex, payload_text):
    # The salt is the 32 DECODED bytes, not the 64 characters of hex text.
    return hashlib.sha256(
        lp(b"stavebni-denik/audit-payload") + lp(bytes.fromhex(salt_hex)) + lp(payload_text.encode("utf-8"))
    ).hexdigest()


def row_hash(prev_hash, project_id, digest):
    # No project is a field of length zero (00 00 00 00), not an omitted field.
    project = (project_id or "").encode("ascii")
    return hashlib.sha256(
        lp(b"stavebni-denik/audit-row") + lp(b"2") + lp(prev_hash.encode("ascii")) + lp(project) + lp(digest.encode("ascii"))
    ).hexdigest()


def verify_chain(rows):
    """rows: dicts with prev_hash, row_hash, project_id (or None) and either payload_digest (a stub) or
    payload_text and payload_salt (a row in full). Returns None when every hash and every link holds, otherwise the
    position of the first row that does not fit."""
    prev = GENESIS
    for position, row in enumerate(rows):
        digest = row.get("payload_digest") or payload_digest(row["payload_salt"], row["payload_text"])
        if row["prev_hash"] != prev or row_hash(row["prev_hash"], row.get("project_id"), digest) != row["row_hash"]:
            return position
        prev = row["row_hash"]
    return None
# --- specification end ---


def check_vectors(path):
    with open(path, encoding="utf-8") as f:
        vectors = json.load(f)
    problems = []
    rows = {}
    for name in ("rowOfAProject", "rowOfNoProject"):
        v = vectors[name]
        digest = payload_digest(v["salt"], v["payloadText"])
        if digest != v["payloadDigest"]:
            problems.append("%s: payload digest %s, expected %s" % (name, digest, v["payloadDigest"]))
        hashed = row_hash(v["prevHash"], v["projectId"], v["payloadDigest"])
        if hashed != v["rowHash"]:
            problems.append("%s: row hash %s, expected %s" % (name, hashed, v["rowHash"]))
        rows[name] = v
    if vectors["genesis"] != GENESIS:
        problems.append("the genesis hash differs")

    def full(v):
        return {"prev_hash": v["prevHash"], "row_hash": v["rowHash"], "project_id": v["projectId"],
                "payload_text": v["payloadText"], "payload_salt": v["salt"]}

    def stub(v):
        return {"prev_hash": v["prevHash"], "row_hash": v["rowHash"], "project_id": v["projectId"],
                "payload_digest": v["payloadDigest"]}

    a, b = rows["rowOfAProject"], rows["rowOfNoProject"]
    # The chain of the two rows holds whether a row is given in full or as a stub ...
    for chain in ([full(a), full(b)], [stub(a), full(b)], [full(a), stub(b)], [stub(a), stub(b)]):
        if verify_chain(chain) is not None:
            problems.append("a chain made of the vectors does not verify")
    # ... and stops holding when one thing changes: the text, the project, the digest of a stub, the order.
    tampered = [
        ("one letter of the payload", [dict(full(a), payload_text=a["payloadText"].replace("Beton", "Betom")), full(b)], 0),
        ("the project of a row", [dict(full(a), project_id=None), full(b)], 0),
        ("the project of a stub", [stub(a), dict(stub(b), project_id=a["projectId"])], 1),
        ("the digest of a stub", [dict(stub(a), payload_digest="0" * 64), full(b)], 0),
        ("the order", [full(b), full(a)], 0),
    ]
    for what, chain, position in tampered:
        found = verify_chain(chain)
        if found != position:
            problems.append("%s was not found at row %d (found: %r)" % (what, position, found))
    return problems


def main(argv):
    if len(argv) == 3 and argv[1] == "vectors":
        problems = check_vectors(argv[2])
    elif len(argv) == 3 and argv[1] == "chain":
        with open(argv[2], encoding="utf-8") as f:
            position = verify_chain(json.load(f))
        problems = [] if position is None else ["the chain does not hold at row %d" % position]
    else:
        sys.stderr.write(__doc__)
        return 2
    for problem in problems:
        sys.stderr.write("FAILED: %s\n" % problem)
    if not problems:
        print("OK")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
