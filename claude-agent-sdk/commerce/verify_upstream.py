"""Verify a trusted developer checkout before importing upstream source; no fetch.

This is source-drift detection, not containment of a hostile filesystem or Git.
Dependency installation and upstream checkout creation are explicit host steps.
"""
import hashlib
import json
from pathlib import Path
import subprocess

PINS = json.loads(Path(__file__).with_name("upstream.json").read_text(encoding="utf-8"))


def verify(root: Path) -> None:
    root = root.resolve(strict=True)
    def git(*args):
        return subprocess.check_output(["git", "-C", str(root), *args], timeout=15)
    if git("rev-parse", "HEAD").decode().strip() != PINS["commit"]:
        raise ValueError("upstream_commit_mismatch")
    if git("status", "--porcelain", "--untracked-files=all").strip():
        raise ValueError("upstream_checkout_not_clean")
    for relative, expected in PINS["reviewed_git_blobs"].items():
        path = root / relative
        if path.is_symlink() or not path.is_file():
            raise ValueError("upstream_source_not_regular")
        data = path.read_bytes()
        actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        if actual != expected:
            raise ValueError("upstream_blob_mismatch")
