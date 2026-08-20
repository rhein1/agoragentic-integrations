from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agoragentic_transaction_assurance_env.tumbler_benchmarks import (
    TUMBLER_BENCHMARK_SCHEMA,
    build_benchmark_report,
    get_baseline_policy,
    main,
)


class TumblerBenchmarkTests(unittest.TestCase):
    def test_safety_first_control_passes_all_packaged_scenarios(self):
        report = build_benchmark_report("safety_first_v1")
        summary = report["summary"]
        self.assertEqual(summary["scenario_count"], 8)
        self.assertEqual(summary["pass_count"], 8)
        self.assertEqual(summary["pass_rate"], 1.0)
        self.assertEqual(summary["zero_reward_count"], 0)
        self.assertEqual(summary["average_total_reward"], 1.0)

    def test_reckless_and_always_escalate_controls_do_not_look_successful(self):
        reckless = build_benchmark_report("always_execute_v1")
        conservative = build_benchmark_report("always_escalate_v1")

        self.assertLess(reckless["summary"]["pass_count"], 8)
        self.assertGreater(reckless["summary"]["zero_reward_count"], 0)
        self.assertEqual(conservative["summary"]["pass_count"], 0)
        self.assertEqual(conservative["summary"]["pass_rate"], 0.0)

    def test_report_is_deterministic_public_safe_and_authority_free(self):
        first = build_benchmark_report("safety_first_v1")
        second = build_benchmark_report("safety_first_v1")
        serialized = json.dumps(first, sort_keys=True)

        self.assertEqual(first, second)
        self.assertEqual(first["schema"], TUMBLER_BENCHMARK_SCHEMA)
        self.assertRegex(first["benchmark_sha256"], r"^[0-9a-f]{64}$")
        self.assertTrue(first["control_only"])
        self.assertTrue(
            all(value is False for value in first["authority_boundary"].values())
        )
        self.assertNotRegex(serialized, r"amk_|Bearer |sk-|PRIVATE KEY")
        self.assertNotIn("generated_at", first)

    def test_cli_writes_canonical_json_with_terminal_newline(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "report.json"
            self.assertEqual(
                main(["--policy", "safety_first_v1", "--out", str(path)]),
                0,
            )
            raw = path.read_text(encoding="utf-8")
            self.assertTrue(raw.endswith("\n"))
            report = json.loads(raw)
            self.assertEqual(report, build_benchmark_report("safety_first_v1"))

    def test_unknown_policy_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "unknown Tumbler baseline policy"):
            get_baseline_policy("invented_policy")


if __name__ == "__main__":
    unittest.main()
