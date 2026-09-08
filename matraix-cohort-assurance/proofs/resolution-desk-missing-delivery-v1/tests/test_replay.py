"""Reconcile evaluator fixtures and reject malformed or misleading evidence."""

import importlib.util
import json
import shutil
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("proof_replay", ROOT / "replay.py")
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class ReplayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cohort-proof-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in (*proof.INPUTS, "report.json"):
            shutil.copyfile(ROOT / name, self.root / name)

    def edit(self, name, mutation):
        path = self.root / name
        if name.endswith("jsonl"):
            value = [json.loads(line) for line in path.read_text().splitlines()]
            mutation(value)
            path.write_text("\n".join(proof.canonical_json(r) for r in value) + "\n")
        else:
            value = json.loads(path.read_text())
            mutation(value)
            path.write_text(proof.canonical_json(value) + "\n")

    def test_replay_matches_canonical_report_without_network(self):
        with patch.object(socket, "socket", side_effect=AssertionError("network forbidden")):
            actual = proof.evaluate(self.root)
        self.assertEqual((proof.canonical_json(actual) + "\n").encode(),
                         (ROOT / "report.json").read_bytes())
        self.assertEqual(actual["live_trials_completed"], 0)
        self.assertEqual(actual["live_trials_missing"], 32)
        self.assertEqual(actual["model_sensitivity_status"], "not_measured")
        self.assertEqual(sum(actual["counts"][s] for s in proof.STATUSES), 32)
        self.assertGreater(actual["counts"]["failed"], 0)
        self.assertGreater(actual["counts"]["invalid"], 0)
        self.assertGreater(actual["counts"]["unverifiable"], 0)

    def test_rates_preserve_correct_denominators(self):
        report = proof.evaluate(self.root)
        count = report["counts"]
        valid = 32 - count["invalid"] - count["unverifiable"]
        completion = report["metrics"]["system_functional_complete"]
        self.assertEqual(completion["numerator"], count["completed"])
        self.assertEqual(completion["denominator"], valid)
        self.assertEqual(completion["value"], round(count["completed"] / valid, 6))
        self.assertEqual(proof.rate(0, 0), {"numerator": 0, "denominator": 0, "value": None})

    def test_trial_mutations_fail_closed(self):
        mutations = {
            "omission": lambda rows: rows.pop(),
            "duplicate": lambda rows: rows.__setitem__(1, rows[0]),
            "persona": lambda rows: rows[0].update(persona_id="customer@example.org"),
            "model": lambda rows: rows[0].update(model_id=""),
            "receipt": lambda rows: rows[0]["response"]["receipt"].update(receipt_id="persona-claimed"),
            "invocation": lambda rows: rows[0].update(invocation_id=rows[1]["invocation_id"]),
            "pass": lambda rows: rows[0].update(passed=True),
            "metrics": lambda rows: rows[0].update(metrics={"customer_conversion": 1}),
            "negative": lambda rows: rows[0].update(turns=-1),
            "boolean": lambda rows: rows[0].update(turns=True),
            "findings": lambda rows: rows[0]["findings"].update(functional_complete="true"),
            "status": lambda rows: rows[0].update(status="human_validated"),
            "binding": lambda rows: rows[0]["bindings"].update(task="sha256:" + "0" * 64),
            "price": lambda rows: rows[0]["preflight"].update(price_usdc=1),
            "ambiguous_price": lambda rows: rows[0]["preflight"].update(price_usdc=False),
            "challenge": lambda rows: rows[0]["response"].update(http_status=402),
            "response_price": lambda rows: rows[0]["response"].update(price_usdc=1),
            "target_drift": lambda rows: rows[0]["response"].update(target_version="2"),
            "receipt_route": lambda rows: rows[0]["response"]["receipt"].update(capability_path="/other"),
            "authority": lambda rows: rows[0]["preflight"]["authority"].update(payment_authority_granted=True),
            "uncertain_effect": lambda rows: rows[0]["preflight"].update(side_effect="uncertain"),
        }
        original = (ROOT / "sanitized-trials.jsonl").read_bytes()
        for label, mutation in mutations.items():
            with self.subTest(label=label):
                (self.root / "sanitized-trials.jsonl").write_bytes(original)
                self.edit("sanitized-trials.jsonl", mutation)
                with self.assertRaises((proof.ContractError, ValueError)):
                    proof.evaluate(self.root)

    def test_raw_material_and_representational_claims_are_not_an_extension_point(self):
        values = ["Bearer synthetic-test-token-only-0000", {"api_key": "synthetic-key"},
                  {"cookie": "fixture"}, "postgres://fixture:fixture@localhost/db",
                  {"address": "synthetic address", "phone": "555-0100"},
                  "https://example.invalid/?token=fixture", "payment was made",
                  "What customers want", "purchase intent", "population prevalence",
                  "synthetic jury", "community voice", "personas represent affected customers",
                  "consent", "fairness", "legitimacy", "lived experience",
                  {"race": "fixture"}, "users", "people", "customers", "community"]
        original = (ROOT / "sanitized-trials.jsonl").read_bytes()
        for value in values:
            with self.subTest(value=value):
                (self.root / "sanitized-trials.jsonl").write_bytes(original)
                self.edit("sanitized-trials.jsonl", lambda rows: rows[0].update(summary_code=value))
                with self.assertRaises(proof.ContractError):
                    proof.evaluate(self.root)

    def test_all_representation_flags_mandatory_literal_false(self):
        original = (ROOT / "run-config.example.json").read_bytes()
        for field in proof.REPRESENTATION:
            for value in (True, 0, None):
                with self.subTest(field=field, value=value):
                    (self.root / "run-config.example.json").write_bytes(original)
                    self.edit("run-config.example.json", lambda obj: obj["representation_boundary"].update({field: value}))
                    with self.assertRaises(proof.ContractError):
                        proof.evaluate(self.root)

    def test_config_and_cohort_mutations_fail_closed(self):
        cases = [("run-config.example.json", "seed", 322),
                 ("run-config.example.json", "replacement_policy", "with_replacement"),
                 ("cohort-manifest.json", "personas", []),
                 ("task-manifest.json", "scenario", "What customers want"),
                 ("model-manifest.example.json", "model_sensitivity_status", "measured")]
        for name, key, value in cases:
            with self.subTest(name=name, key=key):
                original = (self.root / name).read_bytes()
                self.edit(name, lambda obj: obj.update({key: value}))
                with self.assertRaises(proof.ContractError):
                    proof.evaluate(self.root)
                (self.root / name).write_bytes(original)

    def test_duplicate_json_keys_and_nonfinite_numbers_rejected(self):
        for text in ('{"seed":321,"seed":322}', '{"value":NaN}', '{"value":Infinity}'):
            with self.subTest(text=text), self.assertRaises(proof.ContractError):
                proof.parse_json(text)

    def test_exact_artifact_manifest_and_tamper(self):
        proof.verify_manifest(ROOT)
        for path in ROOT.iterdir():
            if path.is_file():
                shutil.copyfile(path, self.root / path.name)
        with (self.root / "report.json").open("ab") as stream:
            stream.write(b" ")
        with self.assertRaises(proof.ContractError):
            proof.verify_manifest(self.root)


if __name__ == "__main__":
    unittest.main()
