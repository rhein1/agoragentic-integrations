import copy
import hashlib
import importlib.util
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from domain.contract import ContractError, compile_packet, data, digest, history_proposal, replay
from verify_contract import verify_contract_sources

FIXTURE = json.loads((ROOT / "fixture.json").read_text(encoding="utf-8"))


class Contracts(unittest.TestCase):
    def setUp(self):
        self.r = copy.deepcopy(FIXTURE["request"])
        self.rows = copy.deepcopy(FIXTURE["observations"])

    def rebind(self):
        h = compile_packet(self.r)["request_digest"]
        for row in self.rows:
            row["request_digest"] = h

    def test_01_packet_is_stable_and_authority_free(self):
        p = compile_packet(self.r)
        self.assertEqual(p, compile_packet(copy.deepcopy(self.r)))
        self.assertFalse(p["authority_granted"])
        self.assertFalse(p["budgets_enforced"])
        self.assertFalse(p["host_qualified"])
        self.assertEqual(len(p["evolve_ids"]), 2)
        self.assertNotIn("heldout-check", json.dumps(p))

    def test_02_return_values_do_not_mutate_input(self):
        p = compile_packet(self.r)
        p["edits"][0]["path"] = "changed"
        self.assertNotEqual(p["edits"], self.r["edits"])

    def test_03_authority_and_override_fields_denied(self):
        for field in ("enabled", "approved", "executor", "gateway", "provider", "raw_logs", "holdout_answers"):
            with self.subTest(field=field):
                r = copy.deepcopy(self.r)
                r[field] = True
                with self.assertRaisesRegex(ContractError, "invalid_fields"):
                    compile_packet(r)

    def test_04_protected_paths_denied(self):
        for path in ("../AGENTS.md", ".github/workflows/ci.yml", "harness/../adapter.py", "harness/prompts/strategy.md\n", "C:secret", "harness/prompts\\strategy.md", "harness/prompts/AGENTS.md", "harness/grader.py"):
            with self.subTest(path=path):
                self.r["edits"][0]["path"] = path
                with self.assertRaisesRegex(ContractError, "protected_or_unknown_path"):
                    compile_packet(self.r)

    def test_05_component_cannot_be_relabelled_for_novelty(self):
        self.r["edits"][0]["component"] = "memory"
        with self.assertRaisesRegex(ContractError, "component_mismatch"):
            compile_packet(self.r)

    def test_06_duplicate_and_excess_edits_denied(self):
        self.r["edits"] *= 2
        with self.assertRaisesRegex(ContractError, "duplicate_edit"):
            compile_packet(self.r)
        self.r["edits"] *= 2
        with self.assertRaisesRegex(ContractError, "edit_budget_exceeded"):
            compile_packet(self.r)

    def test_07_split_family_leakage_denied(self):
        self.r["tasks"][2]["family"] = self.r["tasks"][0]["family"]
        with self.assertRaisesRegex(ContractError, "family_split_leakage"):
            compile_packet(self.r)

    def test_08_duplicate_task_and_missing_split_denied(self):
        self.r["tasks"][2]["id"] = self.r["tasks"][0]["id"]
        with self.assertRaisesRegex(ContractError, "duplicate_task"):
            compile_packet(self.r)
        self.r = copy.deepcopy(FIXTURE["request"])
        self.r["tasks"].pop()
        with self.assertRaisesRegex(ContractError, "missing_split"):
            compile_packet(self.r)

    def test_09_digests_and_candidate_identity_strict(self):
        self.r["target"]["candidate_commit"] = self.r["target"]["baseline_commit"]
        with self.assertRaisesRegex(ContractError, "identical_candidate"):
            compile_packet(self.r)
        self.r["target"]["candidate_commit"] += "\n"
        with self.assertRaisesRegex(ContractError, "invalid_digest"):
            compile_packet(self.r)

    def test_10_limits_require_bounded_integers_not_booleans(self):
        for value in (True, 0, -1, 3, 1.5, "2", None):
            with self.subTest(value=value):
                self.r["limits"]["max_edits"] = value
                with self.assertRaises(ContractError):
                    compile_packet(self.r)

    def test_11_replay_does_not_select_a_winner(self):
        result = replay(self.r, self.rows)
        self.assertEqual(result["preflight_violations"], [])
        self.assertFalse(result["selection_evaluated"])
        self.assertFalse(result["promotion_allowed"])
        self.assertFalse(result["verified"])
        self.assertEqual(result["provider_calls"], 0)
        self.assertEqual(result["summaries"]["candidate"]["score"], 0.75)

    def test_12_missing_trials_keep_full_denominator(self):
        self.rows.pop()
        result = replay(self.r, self.rows)
        self.assertEqual(result["summaries"]["candidate"]["expected"], 4)
        self.assertEqual(result["summaries"]["candidate"]["missing"], 1)
        self.assertEqual(result["summaries"]["candidate"]["score"], 0.75 * 3 / 4)
        self.assertIn("candidate_missing_trials", result["preflight_violations"])
        self.assertIn("candidate_incomplete_cost", result["preflight_violations"])

    def test_13_unknown_cost_is_not_free(self):
        self.rows[-1]["policy_tokens"] = None
        result = replay(self.r, self.rows)
        self.assertIsNone(result["summaries"]["candidate"]["policy_tokens"])
        self.assertIn("candidate_incomplete_cost", result["preflight_violations"])

    def test_14_unknown_dollar_cost_blocks_even_with_tokens(self):
        self.rows[-1]["cost_microusd"] = None
        self.assertIn("candidate_incomplete_cost", replay(self.r, self.rows)["preflight_violations"])

    def test_15_failed_trial_cannot_carry_reward(self):
        self.rows[-1]["status"] = "timeout"
        with self.assertRaisesRegex(ContractError, "failed_trial_reward"):
            replay(self.r, self.rows)
        self.rows[-1]["reward"] = 0
        self.assertIn("failure_rate_regression", replay(self.r, self.rows)["preflight_violations"])

    def test_16_unbounded_score_and_token_types_denied(self):
        for value in (True, -1, 1.01, "0.5", float("nan"), float("inf")):
            with self.subTest(value=value):
                rows = copy.deepcopy(self.rows)
                rows[0]["reward"] = value
                with self.assertRaises(ContractError):
                    replay(self.r, rows)
        self.rows[0]["policy_tokens"] = True
        with self.assertRaisesRegex(ContractError, "invalid_cost"):
            replay(self.r, self.rows)

    def test_17_non_evolve_trial_denied(self):
        self.rows[0]["task_id"] = self.r["tasks"][2]["id"]
        with self.assertRaisesRegex(ContractError, "non_evolve_trial"):
            replay(self.r, self.rows)

    def test_18_duplicate_or_reused_trials_denied(self):
        with self.assertRaisesRegex(ContractError, "duplicate_trial"):
            replay(self.r, self.rows + [copy.deepcopy(self.rows[0])])
        self.rows[1]["evidence_digest"] = self.rows[0]["evidence_digest"]
        with self.assertRaisesRegex(ContractError, "reused_evidence"):
            replay(self.r, self.rows)

    def test_19_stale_request_binding_denied(self):
        self.r["target"]["evaluator_digest"] = "sha256:" + "9" * 64
        with self.assertRaisesRegex(ContractError, "request_binding_mismatch"):
            replay(self.r, self.rows)

    def test_20_wrong_commit_denied(self):
        self.rows[0]["commit"] = self.r["target"]["candidate_commit"]
        with self.assertRaisesRegex(ContractError, "commit_mismatch"):
            replay(self.r, self.rows)

    def test_21_report_cannot_claim_trusted_host_provenance(self):
        self.rows[0]["source_class"] = "verified_host"
        with self.assertRaisesRegex(ContractError, "unqualified_evidence_source"):
            replay(self.r, self.rows)

    def test_22_raw_logs_and_secret_fields_are_not_accepted(self):
        self.rows[0]["stdout"] = "private-token-value"
        with self.assertRaisesRegex(ContractError, "invalid_fields"):
            replay(self.r, self.rows)

    def test_23_critical_violations_cannot_be_paid_for_by_score(self):
        self.rows[-1]["reward"] = 1
        self.rows[-1]["violations"] = ["authority"]
        self.assertIn("candidate_noncompensatory_violation", replay(self.r, self.rows)["preflight_violations"])

    def test_24_known_costs_of_incomplete_runs_still_count(self):
        self.r["limits"]["max_cost_microusd"] = 1
        self.rebind()
        self.rows[-1]["cost_microusd"] = None
        self.assertIn("cost_microusd_campaign_budget_exceeded", replay(self.r, self.rows)["preflight_violations"])

    def test_25_deadline_overrun_reported(self):
        self.rows[-1]["duration_ms"] = 601000
        self.assertIn("candidate_deadline_exceeded", replay(self.r, self.rows)["preflight_violations"])

    def test_26_all_zero_tokens_are_not_ratio_evidence(self):
        for row in self.rows:
            row["policy_tokens"] = 0
        self.assertIn("baseline_zero_token_cost_undefined", replay(self.r, self.rows)["preflight_violations"])

    def test_35_mixed_zero_token_counts_block_upstream_cost_bias(self):
        self.rows[-1]["policy_tokens"] = 0
        self.assertIn("candidate_zero_token_cost_undefined", replay(self.r, self.rows)["preflight_violations"])

    def test_27_history_is_only_a_proposal(self):
        rec = history_proposal(self.r, self.rows)
        self.assertFalse(rec["memory_written"])
        self.assertFalse(rec["accepted_incumbent"])
        self.assertFalse(rec["installed"])
        self.assertFalse(rec["authority_granted"])
        self.assertNotIn("reward", json.dumps(rec))

    def test_28_hostile_non_json_data_denied(self):
        class Hostile(dict):
            def items(self):
                raise AssertionError("must not invoke subclass")
        with self.assertRaises(ContractError):
            data(Hostile())
        with self.assertRaises(ContractError):
            data({"__proto__": True})
        cyclic = []; cyclic.append(cyclic)
        with self.assertRaises(ContractError):
            data(cyclic)
        with self.assertRaises(ContractError):
            data("\ud800")

    def test_29_cli_preview_and_no_apply(self):
        cmd = [sys.executable, str(ROOT / "preview.py")]
        got = subprocess.run(cmd + [str(ROOT / "fixture.json")], capture_output=True, text=True, check=True)
        self.assertFalse(json.loads(got.stdout)["replay"]["promotion_allowed"])
        for flag in ("--apply", "--run", "--approve"):
            self.assertEqual(subprocess.run(cmd + [flag], capture_output=True).returncode, 2)

    def test_30_cli_errors_do_not_echo_secrets(self):
        cmd = [sys.executable, str(ROOT / "preview.py")]
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "private-token-value.json"
            for raw in ('{"secret":"private-token-value"', '{"request":1,"request":2}', 'x' * 262145):
                p.write_text(raw, encoding="utf-8")
                out = subprocess.run(cmd + [str(p)], capture_output=True, text=True)
                self.assertEqual(out.returncode, 2)
                self.assertNotIn("private-token-value", out.stderr + out.stdout)

    def test_31_upstream_verifier_rejects_modified_bytes(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "rrsi"
            p.mkdir()
            (p / "domain.py").write_text("# altered", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "upstream_contract_source_mismatch"):
                verify_contract_sources(d)


@unittest.skipUnless(os.environ.get("RRSI_CONTRACT_ROOT"), "Set RRSI_CONTRACT_ROOT to check pinned upstream ABI; offline core does not need it")
class PinnedUpstreamABI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        paths = verify_contract_sources(os.environ["RRSI_CONTRACT_ROOT"])
        # Only these two verified pure modules run; no upstream __init__/LLM/loop.
        package = types.ModuleType("rrsi")
        package.__path__ = [str(paths["domain.py"].parent)]
        sys.modules["rrsi"] = package
        for filename, path in paths.items():
            name = "rrsi." + filename[:-3]
            spec = importlib.util.spec_from_file_location(name, path)
            module = importlib.util.module_from_spec(spec)
            sys.modules[name] = module
            spec.loader.exec_module(module)
        from domain.adapter import AgoragenticDomain
        cls.Domain = AgoragenticDomain

    def test_32_actual_taskresult_and_aggregate_abi(self):
        from rrsi.evaluate import aggregate
        dom = self.Domain(FIXTURE["request"], FIXTURE["observations"])
        per, extra = dom.score(None, "fixture", dom.evolve_ids(), 2)
        result = aggregate("fixture", 2, per, extra)
        self.assertEqual(result.S, 0.75)
        self.assertEqual(result.n_expected, 4)
        self.assertEqual(result.C, 80)
        self.assertIn("qualified_host_evidence_missing", dom.guards(result, result))

    def test_33_actual_domain_is_inert_and_holds_out_data(self):
        from rrsi.domain import Domain
        dom = self.Domain(FIXTURE["request"], FIXTURE["observations"])
        self.assertIsInstance(dom, Domain)
        self.assertEqual(dom.heldout_ids(), [])
        self.assertEqual(dom.smoke(None, None, "job", []), (False, {"reason": "live_execution_not_implemented", "provider_calls": 0}))
        with self.assertRaisesRegex(ContractError, "live_execution_not_implemented"):
            dom.run(None, None, "job", [], 2)
        with self.assertRaisesRegex(ContractError, "evaluation_scope_mismatch"):
            dom.score(None, "job", ["heldout-check"], 2)
        self.assertIsNone(dom.load_trial(None, None, "../../secret", 0))
        self.assertNotIn("private-token-value", dom.render_trace({"secret": "private-token-value"}))

    def test_36_upstream_load_domain_in_disposable_layout(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "rrsi").mkdir()
            for name, path in verify_contract_sources(os.environ["RRSI_CONTRACT_ROOT"]).items():
                shutil.copyfile(path, root / "rrsi" / name)
            target = root / "domains" / "agoragentic"
            target.mkdir(parents=True)
            for name in ("__init__.py", "adapter.py", "contract.py", "SKILL.md", "PATTERNS.md"):
                shutil.copyfile(ROOT / "domain" / name, target / name)
            script = ("from rrsi.domain import load_domain; "
                      "d=load_domain('agoragentic'); "
                      "assert d.name == 'agoragentic'; "
                      "assert d.smoke(None,None,'x',[])[0] is False; "
                      "assert d.heldout_ids() == []; "
                      "assert len(d.constitution(d.root.parents[1])) == 2; "
                      "print('ABI_LAYOUT_OK')")
            out = subprocess.run([sys.executable, "-c", script], cwd=root,
                                 capture_output=True, text=True, check=True)
            self.assertEqual(out.stdout.strip(), "ABI_LAYOUT_OK")

    def test_34_actual_upstream_missing_cost_needs_extra_guard(self):
        from rrsi.evaluate import relative_cost_change
        self.assertEqual(relative_cost_change(None, 100), 0.0)
        rows = copy.deepcopy(FIXTURE["observations"])
        rows[-1]["policy_tokens"] = None
        dom = self.Domain(FIXTURE["request"], rows)
        self.assertIn("candidate_incomplete_cost", dom.guards(None, None))


if __name__ == "__main__":
    unittest.main()
