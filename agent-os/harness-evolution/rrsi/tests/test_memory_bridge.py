import copy
import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from domain.memory_bridge import MemoryBridgeError, validate_reviewed_memory
from domain.memory_bridge import _digest


NOW = "2026-09-30T12:00:00Z"


def packet():
    import json
    value = json.loads((Path(__file__).parent / "fixtures/memory-reviewed-packet.json").read_text(encoding="utf-8"))
    return tuple(value[key] for key in ("task", "stage", "review_claim", "review", "receipt", "stage_view"))


def rebind_artifacts(values):
    task, stage, claim, review, receipt, view = values
    claim["task_digest"] = _digest(task)
    claim["stage_digest"] = _digest(stage)
    review["task_digest"] = _digest(task)
    review["review_claim_digest"] = _digest(claim)
    receipt["candidate"]["task_hash"] = _digest(task)
    receipt["candidate"]["stage_hash"] = _digest(stage)
    review["evaluation_receipt_digest"] = _digest(receipt)
    view["review"]["task_digest"] = _digest(task)
    view["review"]["evaluation_receipt_digest"] = _digest(receipt)


class MemoryBridgeTests(unittest.TestCase):
    def call(self, values, **kw):
        return validate_reviewed_memory(task=values[0], stage=values[1], review_claim=values[2], review=values[3], receipt=values[4], stage_view=values[5], scope={"project_id": "agoragentic", "repo_id": "rhein1/example"}, now=NOW, **kw)

    def test_claim_bound_scope_and_redaction_are_quarantined(self):
        result = self.call(packet())
        self.assertFalse(result["evaluation_allowed"]); self.assertFalse(result["promotion_allowed"])
        self.assertEqual(result["provider_calls"], 0)

    def test_stale_review_rejected(self):
        values = packet(); values[2]["reviewed_at"] = "2026-09-28T11:00:00Z"; values[3]["reviewed_at"] = values[2]["reviewed_at"]
        from domain.memory_bridge import _digest
        values[3]["review_claim_digest"] = _digest(values[2]); values[5]["review"]["reviewed_at"] = values[2]["reviewed_at"]
        with self.assertRaisesRegex(MemoryBridgeError, "memory_review_stale"):
            self.call(values)

    def test_receipt_digest_and_task_baseline_are_bound(self):
        values = packet(); values[3]["evaluation_receipt_digest"] = "sha256:" + "f" * 64
        with self.assertRaisesRegex(MemoryBridgeError, "memory_receipt_digest_mismatch"):
            self.call(values)
        values = packet(); values[0]["baseline"] = {"ref": "owner://other", "hash": "sha256:" + "c" * 64}
        from domain.memory_bridge import _digest
        values[3]["task_digest"] = _digest(values[0])
        values[2]["task_digest"] = _digest(values[0]); values[3]["review_claim_digest"] = _digest(values[2]); values[4]["baseline"] = copy.deepcopy(values[0]["baseline"])
        values[4]["candidate"]["task_hash"] = _digest(values[0]); values[3]["evaluation_receipt_digest"] = _digest(values[4])
        with self.assertRaisesRegex(MemoryBridgeError, "memory_task_baseline_mismatch"):
            self.call(values)

    def test_candidate_hash_and_scope_values_are_strict(self):
        values = packet(); values[1]["candidate"]["candidate_hash"] = "sha256:" + "f" * 64; values[0]["provenance"]["candidate_hash"] = values[1]["candidate"]["candidate_hash"]
        with self.assertRaisesRegex(MemoryBridgeError, "memory_candidate_hash_invalid"):
            self.call(values)
        values = packet(); values[1]["scope"].pop("repo_id")
        with self.assertRaisesRegex(MemoryBridgeError, "invalid_memory_scope"):
            self.call(values)

    def test_bounded_json_and_boolean_freshness_are_rejected(self):
        values = packet(); values[0]["nested"] = value = {}; current = value
        for _ in range(18): current["x"] = {}; current = current["x"]
        with self.assertRaisesRegex(MemoryBridgeError, "memory_artifact_too_deep_or_large"):
            self.call(values)
        with self.assertRaisesRegex(MemoryBridgeError, "invalid_review_freshness"):
            self.call(packet(), max_age_seconds=True)

    def test_cross_repo_scope_rejected(self):
        with self.assertRaisesRegex(MemoryBridgeError, "memory_repo_scope_mismatch"):
            values = packet(); validate_reviewed_memory(task=values[0], stage=values[1], review_claim=values[2], review=values[3], receipt=values[4], stage_view=values[5], scope={"project_id": "agoragentic", "repo_id": "other/repo"}, now=NOW)

    def test_legacy_or_rollback_state_rejected(self):
        values = packet(); values[5]["status"] = "reviewed_legacy_unbound"
        with self.assertRaisesRegex(MemoryBridgeError, "memory_stage_not_eligible"):
            self.call(values)

    def test_tampered_task_claim_and_raw_capture_rejected(self):
        values = packet(); values[0]["raw_transcript"] = "secret"
        with self.assertRaisesRegex(MemoryBridgeError, "memory_raw_capture_forbidden"):
            self.call(values)
        values = packet(); values[2]["stage_digest"] = "sha256:" + "f" * 64
        with self.assertRaisesRegex(MemoryBridgeError, "memory_stage_digest_mismatch"):
            self.call(values)

    def test_stage_view_must_project_the_bound_artifacts(self):
        changes = (
            ("candidate", "candidate_id", "skill_other"),
            ("candidate", "candidate_hash", "sha256:" + "f" * 64),
            ("candidate", "source_claim_ids", []),
            ("review", "owner_review_id", "other-review"),
            ("review", "reviewed_at", "2026-09-30T11:30:00Z"),
            ("review", "task_digest", "sha256:" + "f" * 64),
            ("review", "evaluation_receipt_digest", "sha256:" + "f" * 64),
        )
        for section, key, value in changes:
            with self.subTest(section=section, key=key):
                values = packet(); values[5][section][key] = value
                with self.assertRaisesRegex(MemoryBridgeError, "memory_stage_view_"):
                    self.call(values)

    def test_receipt_no_call_and_no_spend_shapes_are_complete(self):
        changes = (
            ("provider", "name", "provider-x"),
            ("provider", "model", "model-x"),
            ("spend", "amount", 1),
            ("spend", "amount", False),
            ("spend", "currency", "USD"),
        )
        for section, key, value in changes:
            with self.subTest(section=section, key=key):
                values = packet(); values[4][section][key] = value
                rebind_artifacts(values)
                with self.assertRaisesRegex(MemoryBridgeError, "memory_receipt_"):
                    self.call(values)

    def test_reviewed_tasks_match_the_source_claims_and_split(self):
        changes = (
            lambda rows: rows.clear(),
            lambda rows: rows.pop(),
            lambda rows: rows[0].__setitem__("split", "test"),
        )
        for change in changes:
            values = packet(); change(values[0]["tasks"])
            rebind_artifacts(values)
            with self.assertRaisesRegex(MemoryBridgeError, "memory_task_collection_"):
                self.call(values)
        values = packet(); values[4]["validation"]["held_out_split_present"] = False
        rebind_artifacts(values)
        with self.assertRaisesRegex(MemoryBridgeError, "memory_receipt_validation_"):
            self.call(values)


if __name__ == "__main__": unittest.main()
