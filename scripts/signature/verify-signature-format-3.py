#!/usr/bin/env python3
"""Reference verifier of signature format 3 of a daily entry (Python standard library only).

It is written from the specification in PROJECT.md ("Daily reports: signing", "What a signature covers"), not from the Kotlin
code, and shows what somebody who receives an entry with the values stored in the database has to compute to check that they
are what was signed: the text of part A that was stored, its digest, the canonical content of the entry and its SHA-256.

  python3 verify-signature-format-3.py vectors <signature-format-3-vectors.json>   recompute the golden vectors
  python3 verify-signature-format-3.py entry <entry.json>                           print the signature hash of an entry

An entry file is a JSON object with `entry` (the stored values, as in the vectors) and `partASnapshot` (the text stored in
`daily_reports."partASnapshot"`, exactly as it is stored); the hash printed is to be compared with `signatureHash`.

Exit status: 0 everything holds, 1 something does not fit, 2 wrong usage.
"""
import json
import sys

# --- specification begin (PROJECT.md quotes this block; a test compares them) ---
import hashlib
from decimal import Decimal

# The fields of the vyhláška that format 3 covers, by key. Never changes: a tenth field is a format 4.
DETAIL_KEYS = [
    "materials", "machinery", "testsAndChecks", "safetyNotes", "dustMeasures",
    "accessibilityMeasures", "defects", "workStateChanges", "otherNotes",
]


def canonical(value):
    """Sorted keys, no white space, characters other than control characters as they are."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_hex(text):
    """SHA-256 of the UTF-8 bytes of a text, as 64 lower-case hex characters."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def degrees(number):
    """A temperature as people write it: no trailing zeros, a decimal comma ("8,5", "15", "-3", "0")."""
    value = Decimal(repr(float(number)))
    if value == 0:
        return "0"
    return format(value.normalize(), "f").replace(".", ",")


def weather_text(weather):
    """The weather as the text that is signed, or None when nothing is stated (the text of WeatherData.describe())."""
    if not weather:
        return None
    parts = []
    condition = (weather.get("condition") or "").strip()
    if condition:
        parts.append(condition)
    low, high = weather.get("tempMin"), weather.get("tempMax")
    if low is not None and high is not None:
        parts.append("%s až %s °C" % (degrees(low), degrees(high)))
    elif low is not None:
        parts.append("min. %s °C" % degrees(low))
    elif high is not None:
        parts.append("max. %s °C" % degrees(high))
    return ", ".join(parts) or None


def blank_to_none(text):
    """A field that is empty or only blanks says nothing: null. Any other text is signed exactly as it is stored."""
    return text if text is not None and text.strip() != "" else None


def content(entry, part_a_text):
    """The content that is hashed: `entry` holds the values stored on the entry and its photos, `part_a_text` is the text
    stored in `partASnapshot`, exactly as it is stored (it is never built again)."""
    photos = [
        {"id": p["id"], "sha256": p["sha256"], "thumbSha256": p["thumbSha256"], "uploadedById": p["uploadedById"]}
        for p in entry["photos"]
        if not p.get("removed")
    ]
    details = entry.get("details") or {}
    return {
        "format": 3,
        "id": entry["id"],
        "projectId": entry["projectId"],
        "date": entry["date"],
        "sequenceNumber": entry["sequenceNumber"],
        "authorId": entry["authorId"],
        "workDescription": entry["workDescription"] or "",
        "workersByTrade": entry["workersByTrade"],
        "isControlDay": entry["isControlDay"],
        "constructionObj": entry["constructionObj"],
        "weather": weather_text(entry["weather"]),
        "isLateEntry": entry["isLateEntry"],
        "lateEntryReason": entry["lateEntryReason"],
        "signedAt": entry["signedAt"],
        "signedById": entry["signedById"],
        "signerName": entry["signerName"],
        "signerCkaitNumber": entry["signerCkaitNumber"],
        "partASha256": sha256_hex(part_a_text),
        "details": {key: blank_to_none(details.get(key)) for key in DETAIL_KEYS},
        "photos": sorted(photos, key=lambda p: p["id"]),
    }


def signature_hash(entry, part_a_text):
    """The signature: the SHA-256 of the canonical text of the content."""
    return sha256_hex(canonical(content(entry, part_a_text)))
# --- specification end ---


def check_vectors(path):
    with open(path, encoding="utf-8") as f:
        vectors = json.load(f)
    problems = []

    for case in vectors["weatherCases"]:
        text = weather_text(case["weather"])
        if text != case["text"]:
            problems.append("weather %r: text %r, expected %r" % (case["weather"], text, case["text"]))

    for name, case in vectors["partA"].items():
        text = canonical(case["partA"])
        if text != case["text"]:
            problems.append("part A %s: text %s, expected %s" % (name, text, case["text"]))
        if sha256_hex(case["text"]) != case["sha256"]:
            problems.append("part A %s: digest %s, expected %s" % (name, sha256_hex(case["text"]), case["sha256"]))

    for name, case in vectors["entries"].items():
        part_a = vectors["partA"][case["partA"]]["text"]
        text = canonical(content(case["entry"], part_a))
        if text != case["contentText"]:
            problems.append("entry %s: content %s, expected %s" % (name, text, case["contentText"]))
        digest = sha256_hex(case["contentText"])
        if digest != case["signatureHash"]:
            problems.append("entry %s: signature hash %s, expected %s" % (name, digest, case["signatureHash"]))
        # What a byte changed in the stored values does to the hash: it must not stay the same.
        for what, changed in changes_of(case["entry"], part_a):
            if signature_hash(*changed) == case["signatureHash"]:
                problems.append("entry %s: a change of %s did not change the signature" % (name, what))
    return problems


def changes_of(entry, part_a):
    """Each newly covered value changed by one character: the entry and the snapshot as they would then be stored."""
    def with_entry(**changes):
        return dict(entry, **changes)

    yield "the signer's name", (with_entry(signerName=entry["signerName"] + "x"), part_a)
    yield "the signer's number", (with_entry(signerCkaitNumber=entry["signerCkaitNumber"] + "1"), part_a)
    yield "one byte of part A", (entry, part_a.replace("a", "b", 1))
    yield "the start of work", (with_entry(details=dict(entry.get("details") or {}, workStateChanges="x")), part_a)
    yield "the weather", (with_entry(weather={"tempMin": 1.5, "tempMax": 2.5, "condition": "x"}), part_a)


def main(argv):
    if len(argv) == 3 and argv[1] == "vectors":
        problems = check_vectors(argv[2])
        for problem in problems:
            sys.stderr.write("FAILED: %s\n" % problem)
        if not problems:
            print("OK")
        return 1 if problems else 0
    if len(argv) == 3 and argv[1] == "entry":
        with open(argv[2], encoding="utf-8") as f:
            given = json.load(f)
        print(signature_hash(given["entry"], given["partASnapshot"]))
        return 0
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
