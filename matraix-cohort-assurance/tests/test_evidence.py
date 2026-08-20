from __future__ import annotations

import copy
import unittest
from pathlib import Path

from agoragentic_matraix_assurance.contracts import ALL_AUTHORITY_FALSE, ContractError
from agoragentic_matraix_assurance.manifest import (
    canonical_json,
    load_json,
    sha256_value,
)
from agoragentic_matraix_assurance.runner import (
    DEFAULT_TASK_DIR,
    DEFAULT_TRIALS,
    load_task_packet,
    replay_task,
    require_no_caller_overrides,
    verify_fixture_evidence,
)


class EvidenceTests(unittest.TestCase):
    def test_fixture_replay_is_byte_deterministic(self):
        first = canonical_json(replay_task()) + "\n"
        second = canonical_json(replay_task())
        expected = (
            Path(__file__).resolve().parents[1] / "fixtures" / "expected_evidence.json"
        ).read_text(encoding="utf-8")
        self.assertEqual(first, second + "\n")
        self.assertEqual(first, expected)
        verify_fixture_evidence(replay_task())

    def test_fixture_manifest_or_seed_drift_fails_baseline(self):
        packet = replay_task()
        packet["seed"] += 1
        with self.assertRaises(ContractError) as caught:
            verify_fixture_evidence(packet)
        self.assertEqual(caught.exception.code, "fixture_evidence_mismatch")

    def test_expected_metrics_and_boundaries_are_evaluator_derived(self):
        packet = replay_task()
        self.assertEqual(packet["schema"], "agoragentic.synthetic-cohort-run.v1")
        self.assertEqual(
            packet["counts"],
            {
                "requested": 4,
                "started": 4,
                "completed": 2,
                "failed": 1,
                "timed_out": 0,
                "abandoned": 1,
            },
        )
        self.assertEqual(packet["metrics"]["functional_task_completion_rate"], 0.5)
        self.assertEqual(packet["metrics"]["mandate_violation_count"], 1)
        self.assertEqual(packet["metrics"]["approval_correctness_rate"], 0.5)
        self.assertEqual(packet["metrics"]["receipt_present_rate"], 0.75)
        self.assertEqual(packet["metrics"]["receipt_correctness_rate"], 0.666667)
        self.assertEqual(packet["authority"], ALL_AUTHORITY_FALSE)
        self.assertFalse(any(packet["claims"].values()))
        self.assertTrue(packet["model_sensitivity"]["same_backbone"])

        manifest = load_json(
            Path(__file__).resolve().parents[1]
            / "fixtures"
            / "expected_run_manifest.json"
        )
        self.assertEqual(manifest["run_id"], packet["run_id"])
        self.assertEqual(manifest["task_digest"], packet["bindings"]["task_digest"])
        self.assertEqual(manifest["evidence_sha256"], sha256_value(packet))
        self.assertFalse(manifest["external_execution"])
        self.assertFalse(manifest["authority_granted"])

    def test_duplicate_or_malformed_trials_fail_closed(self):
        trials = load_json(DEFAULT_TRIALS)
        duplicate = copy.deepcopy(trials)
        duplicate[1]["trial_id"] = duplicate[0]["trial_id"]
        from agoragentic_matraix_assurance.evidence import build_evidence_packet
        from agoragentic_matraix_assurance.runner import ADAPTER_VERSION, DEFAULT_LOCK

        with self.assertRaises(ContractError) as caught:
            build_evidence_packet(
                load_task_packet(DEFAULT_TASK_DIR),
                duplicate,
                load_json(DEFAULT_LOCK),
                ADAPTER_VERSION,
            )
        self.assertEqual(caught.exception.code, "trial_id_invalid")
        injected = copy.deepcopy(trials)
        injected[0]["metrics"] = {"pass": 1}
        with self.assertRaises(ContractError) as caught:
            build_evidence_packet(
                load_task_packet(DEFAULT_TASK_DIR),
                injected,
                load_json(DEFAULT_LOCK),
                ADAPTER_VERSION,
            )
        self.assertEqual(caught.exception.code, "trial_contract_invalid")

    def test_caller_cannot_supply_evaluator_fields(self):
        for field in ("evidence_hash", "metrics", "run_id", "authority", "receipt"):
            with self.subTest(field=field), self.assertRaises(ContractError) as caught:
                require_no_caller_overrides({field: "forged"})
            self.assertEqual(caught.exception.code, "caller_override_prohibited")


if __name__ == "__main__":
    unittest.main()
