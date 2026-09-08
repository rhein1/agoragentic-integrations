"""Verify full snapshot validation, canonical identity, and replay output safety."""
import copy
import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from jsonschema import ValidationError

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("snapshot_schema", ROOT / "validate_platform_schema.py")
schema = importlib.util.module_from_spec(spec)
spec.loader.exec_module(schema)


class PlatformProofTests(unittest.TestCase):
    def test_completed_trial_with_failed_functional_check_is_not_a_task_success(self):
        replay_spec = importlib.util.spec_from_file_location("completion_replay", ROOT / "replay.py")
        replay = importlib.util.module_from_spec(replay_spec)
        replay_spec.loader.exec_module(replay)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for source in ROOT.iterdir():
                if source.is_file():
                    shutil.copyfile(source, root / source.name)
            target = root / "sanitized-trials.jsonl"
            rows = [json.loads(line) for line in target.read_text().splitlines()]
            next(row for row in rows if row["status"] == "completed")["findings"]["functional_complete"] = False
            target.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")
            report = replay.evaluate(root)
            evidence = replay.build_platform_evidence(root)
            observed = report["metrics"]["system_functional_complete"]
            exported = next(metric for metric in evidence["metrics"] if metric["metric_id"] == "task_completion_rate")
            self.assertEqual(observed["numerator"], report["counts"]["completed"] - 1)
            self.assertEqual(exported["numerator"], observed["numerator"])
            self.assertEqual(exported["denominator"], observed["denominator"])

    def test_complete_schema_rejects_nested_and_top_level_drift(self):
        evidence = json.loads((ROOT / "synthetic-cohort-evidence.json").read_text())
        schema.validate_snapshot(evidence)
        mutations = [
            lambda e: e.pop("task"),
            lambda e: e["producer"].update(adapter_version=42),
            lambda e: e["task"].update(unreviewed_field=True),
            lambda e: e["metrics"][0].update(denominator=-1),
            lambda e: e.update(created_at="not-a-date"),
        ]
        for field in evidence["representation_boundary"]:
            if type(evidence["representation_boundary"][field]) is bool:
                mutations.append(lambda e, key=field: e["representation_boundary"].update({key: True}))
        for mutate in mutations:
            value = copy.deepcopy(evidence)
            mutate(value)
            with self.assertRaises(ValidationError):
                schema.validate_snapshot(value)

    def test_canonical_serialization_has_cross_language_numeric_and_unicode_parity(self):
        packet = {"artifacts": {}, "integer_float": 0.0, "fraction": 1 / 3,
                  "small": 1e-7, "text": "caf\u00e9", "negative_zero": -0.0}
        result = subprocess.run(["node", str(ROOT / "canonical-evidence.cjs")],
                                input=json.dumps(packet), text=True, encoding="utf-8", capture_output=True,
                                check=True, timeout=30)
        value = json.loads(result.stdout)
        self.assertIn('"integer_float":0', result.stdout)
        self.assertIn('"small":1e-7', result.stdout)
        self.assertIn('"negative_zero":0', result.stdout)
        rerun = subprocess.run(["node", str(ROOT / "canonical-evidence.cjs")],
                               input=json.dumps(value), text=True, encoding="utf-8", capture_output=True,
                               check=True, timeout=30)
        self.assertEqual(result.stdout, rerun.stdout)

    def test_replay_exports_exact_evidence_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / "evidence.json"
            command = [sys.executable, str(ROOT / "replay.py"), "--evidence-out", str(out)]
            first = subprocess.run(command, capture_output=True, timeout=30)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(out.read_bytes(), (ROOT / "synthetic-cohort-evidence.json").read_bytes())
            second = subprocess.run(command, capture_output=True, timeout=30)
            self.assertNotEqual(second.returncode, 0)
            self.assertEqual(out.read_bytes(), (ROOT / "synthetic-cohort-evidence.json").read_bytes())

    def test_replay_rejects_rehashed_but_false_evidence_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for source in ROOT.iterdir():
                if source.is_file():
                    shutil.copyfile(source, root / source.name)
            target = root / "synthetic-cohort-evidence.json"
            value = json.loads(target.read_text())
            value["evidence_id"] = "sce_" + "0" * 24
            target.write_text(json.dumps(value), encoding="utf-8")
            manifest_path = root / "sha256-manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["files"][target.name] = "sha256:" + hashlib.sha256(target.read_bytes()).hexdigest()
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            result = subprocess.run([sys.executable, str(ROOT / "replay.py"), "--root", str(root)],
                                    capture_output=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"platform_evidence_payload_mismatch", result.stderr)


if __name__ == "__main__":
    unittest.main()
