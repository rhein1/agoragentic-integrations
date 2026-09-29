"""Verify two upstream contract files, without importing an upstream package.

This is a source-subset check, not full release/supply-chain qualification.
"""
import hashlib
from pathlib import Path

CONTRACT_BLOBS = {
    "domain.py": "faf56eb66581fd0c7655abfd05daca96d4a180dd",
    "evaluate.py": "78cac3848c44d9c0827d60b91211964f6576f348",
}


def verify_contract_sources(root):
    result = {}
    for name, expected in CONTRACT_BLOBS.items():
        path = Path(root) / "rrsi" / name
        raw = path.read_bytes()
        actual = hashlib.sha1(f"blob {len(raw)}\0".encode() + raw).hexdigest()
        if actual != expected:
            raise ValueError("upstream_contract_source_mismatch")
        result[name] = path
    return result
