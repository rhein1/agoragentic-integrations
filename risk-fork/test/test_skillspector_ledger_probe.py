"""Explicit pinned-source network regression; not part of the offline Node suite.

Run from the repository root with Python 3.11+:
    python risk-fork/test/test_skillspector_ledger_probe.py
Only the probe's two immutable public source files are downloaded. No scanner,
third-party Python package, model or provider is invoked.
"""

import json
from pathlib import Path
import subprocess
import sys
import unittest


FIXTURES = Path(__file__).resolve().parent / "fixtures"


class SkillSpectorLedgerProbeTest(unittest.TestCase):
    def test_executable_probe_reproduces_complete_and_overflow_fixture(self):
        result = subprocess.run(
            [sys.executable, "-I", str(FIXTURES / "skillspector-ledger-boundary.probe.py")],
            capture_output=True, text=True, timeout=60, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        actual = json.loads(result.stdout)
        expected = json.loads(
            (FIXTURES / "skillspector-ledger-boundary.json").read_text(encoding="utf-8")
        )
        self.assertEqual(actual, expected)
        complete, overflow = actual["results"]
        self.assertEqual(complete["requested_events"], 10_000)
        self.assertEqual(complete["merged_events"], 10_000)
        self.assertEqual(complete["analysis_completeness"]["status"], "complete")
        self.assertTrue(complete["analysis_completeness"]["is_complete"])
        self.assertIsNone(complete["overflow_marker"])
        self.assertEqual(overflow["requested_events"], 10_001)
        self.assertEqual(overflow["merged_events"], 10_000)
        self.assertEqual(overflow["analysis_completeness"]["status"], "partial")
        self.assertFalse(overflow["analysis_completeness"]["is_complete"])
        self.assertEqual(overflow["overflow_marker"], {
            "phase": "ledger_output", "outcome": "partial", "reason_code": "output_limit",
            "observed_records": 10_001, "limit_records": 10_000,
        })


if __name__ == "__main__":
    unittest.main()
