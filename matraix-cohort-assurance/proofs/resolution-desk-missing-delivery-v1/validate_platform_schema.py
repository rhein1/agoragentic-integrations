"""Validate the pinned public schema offline; no platform semantic-validity claim."""
import hashlib
import json
from pathlib import Path

from jsonschema import Draft7Validator, FormatChecker
from referencing import Registry

ROOT = Path(__file__).resolve().parent


def validate_snapshot(evidence, root=ROOT):
    pin = json.loads((root / "platform-contract.json").read_text(encoding="utf-8"))
    raw = (root / "synthetic-cohort-evidence.v1.snapshot.json").read_bytes()
    if "sha256:" + hashlib.sha256(raw).hexdigest() != pin["schema_sha256"]:
        raise ValueError("platform schema snapshot digest mismatch")
    schema = json.loads(raw)
    if schema["$id"] != pin["schema_uri"]:
        raise ValueError("platform schema identity mismatch")
    Draft7Validator.check_schema(schema)
    # No retrieval callback: validation cannot fetch an external reference.
    checker = FormatChecker()
    if "date-time" not in checker.checkers:
        raise RuntimeError("date-time format checker unavailable")
    Draft7Validator(schema, format_checker=checker, registry=Registry()).validate(evidence)


if __name__ == "__main__":
    validate_snapshot(json.loads((ROOT / "synthetic-cohort-evidence.json").read_text(encoding="utf-8")))
    print("Pinned snapshot schema valid; platform semantic validation not performed")
