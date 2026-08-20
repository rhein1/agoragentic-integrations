"""Canonical serialization and exact upstream source-lock verification."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .contracts import ContractError

LOCK_SCHEMA = "agoragentic.external-source-lock.v1"
PINNED_REPOSITORY = "https://github.com/MatrAIx-ai/MatrAIx-Persona-8B"
PINNED_COMMIT = "68f5faf4eed9a4f48513ca3ea4f22ee0f6b14c82"
PINNED_TREE = "ceb400be64ae7c971ba7e397aa2d049c3a08bd3b"
_HEX_40 = frozenset("0123456789abcdef")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_value(value: Any) -> str:
    return sha256_bytes(canonical_json(value).encode("utf-8"))


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _payload(lock: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: value for key, value in lock.items() if key != "canonical_payload_sha256"
    }


def _git_head(upstream_root: Path) -> str:
    marker = upstream_root.resolve() / ".git"
    if marker.is_dir():
        git_dir = marker
    elif marker.is_file():
        value = marker.read_text(encoding="utf-8").strip()
        if not value.startswith("gitdir:"):
            raise ContractError("upstream_commit_unverifiable", "malformed .git file")
        git_dir = (marker.parent / value.partition(":")[2].strip()).resolve()
    else:
        raise ContractError(
            "upstream_commit_unverifiable", "upstream root has no Git metadata"
        )

    head = (git_dir / "HEAD").read_text(encoding="utf-8").strip().lower()
    if len(head) == 40 and set(head) <= _HEX_40:
        return head
    if not head.startswith("ref: "):
        raise ContractError("upstream_commit_unverifiable", "Git HEAD is malformed")
    ref = head[5:]
    roots = [git_dir]
    common_marker = git_dir / "commondir"
    if common_marker.is_file():
        roots.append(
            (git_dir / common_marker.read_text(encoding="utf-8").strip()).resolve()
        )
    for root in roots:
        loose = root / ref
        if loose.is_file():
            value = loose.read_text(encoding="utf-8").strip().lower()
            if len(value) == 40 and set(value) <= _HEX_40:
                return value
        packed = root / "packed-refs"
        if packed.is_file():
            for line in packed.read_text(encoding="utf-8").splitlines():
                if line.startswith(("#", "^")):
                    continue
                value, _, name = line.partition(" ")
                if name == ref and len(value) == 40 and set(value) <= _HEX_40:
                    return value
    raise ContractError(
        "upstream_commit_unverifiable", f"Git ref is unavailable: {ref}"
    )


def verify_source_lock(
    lock: Mapping[str, Any], upstream_root: Path | None = None
) -> str:
    expected_fields = {
        "schema",
        "repository",
        "commit",
        "tree",
        "observed_at",
        "license",
        "source_files",
        "dataset_bundled",
        "partnership_claimed",
        "external_compatibility_verified",
        "canonical_payload_sha256",
    }
    if set(lock) != expected_fields:
        raise ContractError(
            "upstream_lock_invalid", "source lock has missing or unknown fields"
        )
    if lock["schema"] != LOCK_SCHEMA:
        raise ContractError("upstream_lock_invalid", "unsupported lock schema")
    if (
        lock["repository"] != PINNED_REPOSITORY
        or lock["commit"] != PINNED_COMMIT
        or lock["tree"] != PINNED_TREE
    ):
        raise ContractError(
            "upstream_commit_mismatch",
            "repository, commit, or tree does not match the reviewed pin",
        )
    if lock["license"] != "MIT":
        raise ContractError(
            "upstream_license_mismatch", "reviewed source license must be MIT"
        )
    for field in (
        "dataset_bundled",
        "partnership_claimed",
        "external_compatibility_verified",
    ):
        if lock[field] is not False:
            raise ContractError("upstream_lock_invalid", f"{field} must remain false")
    expected_digest = sha256_value(_payload(lock))
    if lock["canonical_payload_sha256"] != expected_digest:
        raise ContractError(
            "upstream_lock_digest_mismatch", "canonical source-lock digest changed"
        )
    source_files = lock["source_files"]
    if not isinstance(source_files, list) or not source_files:
        raise ContractError(
            "upstream_lock_invalid", "source_files must be a non-empty list"
        )
    if upstream_root is not None and _git_head(upstream_root) != lock["commit"]:
        raise ContractError(
            "upstream_commit_mismatch",
            "upstream checkout HEAD does not match the reviewed commit",
        )
    seen: set[str] = set()
    for item in source_files:
        if not isinstance(item, Mapping) or set(item) != {"path", "sha256"}:
            raise ContractError(
                "upstream_lock_invalid", "source file entries are closed objects"
            )
        relative = item["path"]
        if (
            not isinstance(relative, str)
            or relative in seen
            or Path(relative).is_absolute()
            or ".." in Path(relative).parts
        ):
            raise ContractError(
                "upstream_lock_invalid",
                "source file paths must be unique and repository-relative",
            )
        seen.add(relative)
        if not isinstance(item["sha256"], str) or len(item["sha256"]) != 64:
            raise ContractError(
                "upstream_lock_invalid", f"invalid digest for {relative}"
            )
        if upstream_root is not None:
            candidate = (upstream_root / relative).resolve()
            root = upstream_root.resolve()
            if root not in candidate.parents and candidate != root:
                raise ContractError(
                    "upstream_lock_invalid", f"source path escapes root: {relative}"
                )
            if (
                not candidate.is_file()
                or sha256_bytes(candidate.read_bytes()) != item["sha256"]
            ):
                raise ContractError("upstream_file_mismatch", relative)
    return expected_digest
