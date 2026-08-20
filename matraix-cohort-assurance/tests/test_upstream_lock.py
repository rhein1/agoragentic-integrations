from __future__ import annotations

import copy
import tempfile
import unittest
from pathlib import Path

from agoragentic_matraix_assurance.contracts import ContractError
from agoragentic_matraix_assurance.manifest import (
    load_json,
    sha256_value,
    verify_source_lock,
)
from agoragentic_matraix_assurance.runner import DEFAULT_LOCK


class UpstreamLockTests(unittest.TestCase):
    def setUp(self):
        self.lock = load_json(DEFAULT_LOCK)

    @staticmethod
    def refresh_digest(lock):
        payload = {
            key: value
            for key, value in lock.items()
            if key != "canonical_payload_sha256"
        }
        lock["canonical_payload_sha256"] = sha256_value(payload)

    def test_exact_offline_lock_is_valid(self):
        self.assertEqual(
            verify_source_lock(self.lock), self.lock["canonical_payload_sha256"]
        )

    def test_commit_and_lock_digest_drift_fail_closed(self):
        changed = copy.deepcopy(self.lock)
        changed["commit"] = "0" * 40
        self.refresh_digest(changed)
        with self.assertRaises(ContractError) as caught:
            verify_source_lock(changed)
        self.assertEqual(caught.exception.code, "upstream_commit_mismatch")
        changed = copy.deepcopy(self.lock)
        changed["observed_at"] = "2026-08-21T00:00:00Z"
        with self.assertRaises(ContractError) as caught:
            verify_source_lock(changed)
        self.assertEqual(caught.exception.code, "upstream_lock_digest_mismatch")

    def test_upstream_root_requires_exact_reviewed_commit(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            self.assertRaises(ContractError) as caught,
        ):
            verify_source_lock(self.lock, Path(directory))
        self.assertEqual(caught.exception.code, "upstream_commit_unverifiable")

        with tempfile.TemporaryDirectory() as directory:
            git_dir = Path(directory) / ".git"
            git_dir.mkdir()
            (git_dir / "HEAD").write_text("0" * 40 + "\n", encoding="utf-8")
            with self.assertRaises(ContractError) as caught:
                verify_source_lock(self.lock, Path(directory))
        self.assertEqual(caught.exception.code, "upstream_commit_mismatch")


if __name__ == "__main__":
    unittest.main()
