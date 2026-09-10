#!/usr/bin/env python3
"""Hermetic adapter/SQLite regressions. No upstream/model/SDK claim from this suite."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from agoragentic_claude_agent import ClaudeAgentSdkGatingAdapter, money
from commerce.fixture import (FIXTURE_PRINCIPAL as P, FixtureHost, FixtureStore,
                              GateClosed, Principal, digest)

ROOT = Path(__file__).resolve().parent


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.adapter = ClaudeAgentSdkGatingAdapter()

    def test_pending_is_not_allowed(self):
        self.assertEqual(self.adapter.verify_tool_permission("agoragentic_execute", {
            "constraints": {"max_cost_usdc": "0.15"}, "approved": True}), (False, "Approval_Required"))

    def test_no_environment_auto_activation(self):
        with patch.dict("os.environ", {"AGORAGENTIC_API_KEY": "fixture-only", "AGORAGENTIC_ALLOW_REAL_SPEND": "1"}):
            self.assertFalse(ClaudeAgentSdkGatingAdapter().verify_tool_permission(
                "agoragentic_execute", {"constraints": {"max_cost_usdc": 0}})[0])

    def test_bad_spend_shapes(self):
        for cap in [True, False, None, [], {}, "", "NaN", "Infinity", "-1", "1e-6", "0x10", "1\n", "1\r", " 1", "1 ", "0.0000001", float("nan"), float("inf"), -0.0]:
            with self.subTest(cap=cap):
                self.assertEqual(self.adapter.verify_tool_permission("agoragentic_execute", {
                    "constraints": {"max_cost_usdc": cap}}), (False, "Invalid_Spend_Cap"))

    def test_decimal_and_legacy_numeric(self):
        self.assertEqual(money("0.000001"), money(0.000001))
        self.assertEqual(money("0.25"), money(0.25))
        self.assertEqual(self.adapter.verify_tool_permission("agoragentic_execute", {
            "constraints": {"max_cost_usdc": "0.250001"}}), (False, "Denied_Spend_Limit_Exceeded"))

    def test_unknown_and_missing_input_fail_closed(self):
        for name in [None, {}, "Bash", "apply_change", "mcp__other__agoragentic_match", "agoragentic_register"]:
            self.assertFalse(self.adapter.verify_tool_permission(name, {})[0])
        for data in [None, [], {}, {"constraints": None}, {"constraints": {}}]:
            self.assertFalse(self.adapter.verify_tool_permission("agoragentic_execute", data)[0])

    def test_explicit_read_surface(self):
        for name in ["agoragentic_match", "agoragentic_search", "agoragentic_categories"]:
            self.assertEqual(self.adapter.verify_tool_permission(name, {}), (True, "Read_Only_Preflight"))

    def test_file_hint_is_not_file_authority(self):
        for flag in [True, "false", []]:
            self.assertFalse(self.adapter.verify_tool_permission("agoragentic_execute", {
                "constraints": {"max_cost_usdc": "0.1"}, "input_data": {"read_local_files": flag}})[0])

    def test_nested_example_is_loaded(self):
        adapter = ClaudeAgentSdkGatingAdapter(str(ROOT / "permissions.example.json"))
        self.assertEqual(adapter.permissions["max_spend_usdc_per_call"], "0.25")

    def test_missing_policy_is_error_not_defaults(self):
        with self.assertRaises(FileNotFoundError):
            ClaudeAgentSdkGatingAdapter(str(ROOT / "does-not-exist.json"))

    def test_policy_shape_and_duplicate_keys(self):
        invalid = ['[]', '{"max_spend_usdc_per_call":true}', '{"require_hitl_for_spend":"false"}',
                   '{"permissions":{}, "require_hitl_for_spend":false}', '{"unknown":true}',
                   '{"permissions":{},"permissions":{}}']
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "policy.json"
            for value in invalid:
                path.write_text(value)
                with self.assertRaises(ValueError, msg=value):
                    ClaudeAgentSdkGatingAdapter(str(path))

    def test_disabling_hitl_does_not_enable_paid_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "policy.json"
            path.write_text('{"require_hitl_for_spend":false}')
            adapter = ClaudeAgentSdkGatingAdapter(str(path))
            self.assertEqual(adapter.verify_tool_permission("agoragentic_invoke", {
                "constraints": {"max_cost_usdc": "0"}}), (False, "Paid_Execution_Unavailable"))

    def test_policy_is_immutable(self):
        with self.assertRaises(TypeError):
            self.adapter.permissions["require_hitl_for_spend"] = False

    def test_hook_denies_pending_without_permission_override_on_reads(self):
        result = asyncio.run(self.adapter.pre_tool_use({"hook_event_name": "PreToolUse",
            "tool_name": "agoragentic_execute", "tool_input": {"constraints": {"max_cost_usdc": "0.1"}}}))
        self.assertEqual(result["hookSpecificOutput"]["permissionDecision"], "deny")
        result = asyncio.run(self.adapter.pre_tool_use({"hook_event_name": "PreToolUse",
            "tool_name": "agoragentic_match", "tool_input": {}}))
        self.assertEqual(result, {})
        self.assertEqual(asyncio.run(self.adapter.pre_tool_use({}))["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_hook_registration_is_lazy_and_explicit(self):
        # Stub verifies construction only, NOT real host enforcement.
        class Matcher:
            def __init__(self, **kwargs): self.__dict__.update(kwargs)
        import types
        with patch.dict("sys.modules", {"claude_agent_sdk": types.SimpleNamespace(HookMatcher=Matcher)}):
            item = self.adapter.sdk_hooks()["PreToolUse"][0]
            self.assertIsNone(item.matcher)
            self.assertEqual(item.hooks, [self.adapter.pre_tool_use])

    def test_receipt_projection_drops_all_freeform_fields(self):
        original = {"output": "fixture-output", "receipt": {"status": "completed", "receipt_id": "sensitive-id",
            "transaction_hash": "fixture-hash", "settlement_address": "fixture-address",
            "nested": {"authorization": "fixture-secret"}, "signature": "fixture-signature"}}
        snapshot = copy.deepcopy(original)
        result = self.adapter.handle_post_execution(original)
        self.assertEqual(original, snapshot)
        self.assertEqual(result["receipt"], {"projection": "receipt_display_only", "status": "completed"})
        self.assertEqual(result["output"], "fixture-output")


class FixtureTests(unittest.TestCase):
    def setUp(self):
        self.now = 1000.0
        self.store = FixtureStore(clock=lambda: self.now)
        self.host = FixtureHost(self.store)
    def tearDown(self): self.store.close()
    def stage(self, title="Approved fixture title"):
        self.store.read_listing(P)
        return self.store.stage(P, {"title": title})
    def approve(self, change): self.host.approve(change["id"], change["digest"])
    def applied_count(self): return sum(e["kind"] == "applied" for e in self.store.evidence()["events"])

    def test_read_required_before_staging(self):
        with self.assertRaisesRegex(GateClosed, "read_current_listing_first"):
            self.store.stage(P, {"title": "No read"})

    def test_title_only_and_no_money_mutations(self):
        for fields in [{"price": 1}, {"title": "x", "approved": True}, {"title": "x", "budget": 0}, {"title": ""}]:
            with self.assertRaises(GateClosed): self.store.stage(P, fields)

    def test_proposal_is_not_execution(self):
        change = self.stage()
        self.assertEqual(self.store.read_listing(P)["title"], "Original fixture title")
        with self.assertRaisesRegex(GateClosed, "approval_required"): self.store.apply(P, change["id"])
        self.assertEqual(self.applied_count(), 0)
        self.assertFalse(self.store.evidence()["events"][-1]["action_executed"])

    def test_approved_change_applies_exactly_once(self):
        change = self.stage(); self.approve(change)
        self.assertEqual(self.applied_count(), 0)
        self.store.apply(P, change["id"]); self.store.apply(P, change["id"])
        self.assertEqual(self.store.read_listing(P)["title"], "Approved fixture title")
        self.assertEqual(self.applied_count(), 1)

    def test_expired_approval(self):
        change = self.stage(); self.approve(change); self.now += 60
        with self.assertRaisesRegex(GateClosed, "approval_expired"): self.store.apply(P, change["id"])
        self.assertEqual(self.applied_count(), 0)

    def test_revoked_approval(self):
        change = self.stage(); self.approve(change); self.host.revoke(change["id"])
        with self.assertRaisesRegex(GateClosed, "approval_inactive"): self.store.apply(P, change["id"])

    def test_policy_change_invalidates_approval(self):
        change = self.stage(); self.approve(change); self.host.set_paused(True)
        with self.assertRaisesRegex(GateClosed, "policy_denied"): self.store.apply(P, change["id"])
        self.host.set_paused(False)
        with self.assertRaisesRegex(GateClosed, "approval_binding_changed"): self.store.apply(P, change["id"])

    def test_identity_and_session_binding(self):
        change = self.stage(); self.approve(change)
        for other in [Principal("other", P.operator, P.session_id), Principal(P.merchant_id, "other", P.session_id),
                      Principal(P.merchant_id, P.operator, "other")]:
            with self.assertRaisesRegex(GateClosed, "principal_mismatch"): self.store.apply(other, change["id"])
        self.assertEqual(self.applied_count(), 0)

    def test_stale_record_is_not_overwritten(self):
        first = self.stage("first"); second = self.stage("second")
        self.approve(first); self.approve(second); self.store.apply(P, first["id"])
        with self.assertRaisesRegex(GateClosed, "stale_listing"): self.store.apply(P, second["id"])
        self.assertEqual(self.store.read_listing(P)["title"], "first")

    def test_changed_proposal_cannot_reuse_approval(self):
        change = self.stage(); self.approve(change)
        body = change["body"]; body["after"] = "changed since approval"
        self.store.db.execute("UPDATE fixture_changes SET body=?, digest=? WHERE id=?", (json.dumps(body), digest(body), change["id"]))
        with self.assertRaisesRegex(GateClosed, "approval_binding_changed"): self.store.apply(P, change["id"])

    def test_approval_requires_exact_reviewed_digest(self):
        change = self.stage()
        with self.assertRaisesRegex(GateClosed, "approval_binding_changed"): self.host.approve(change["id"], "0" * 64)

    def test_discard_revokes_and_blocks_apply(self):
        change = self.stage(); self.approve(change); self.store.discard(P, change["id"])
        with self.assertRaisesRegex(GateClosed, "change_not_staged"): self.store.apply(P, change["id"])

    def test_failed_evidence_write_rolls_back_mutation(self):
        change = self.stage(); self.approve(change)
        with patch.object(self.store, "_event", side_effect=OSError("fixture audit failure")):
            with self.assertRaises(OSError): self.store.apply(P, change["id"])
        self.assertEqual(self.store.change(P, change["id"])["status"], "staged")
        self.assertEqual(self.store.read_listing(P)["title"], "Original fixture title")
        self.store.apply(P, change["id"])
        self.assertEqual(self.applied_count(), 1)

    def test_restart_preserves_consumption(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "fixture.sqlite")
            first = FixtureStore(path); first.read_listing(P)
            change = first.stage(P, {"title": "persisted fixture"})
            FixtureHost(first).approve(change["id"], change["digest"])
            first.apply(P, change["id"]); first.close()
            second = FixtureStore(path)
            try:
                second.apply(P, change["id"])
                self.assertEqual(second.read_listing(P)["title"], "persisted fixture")
                self.assertEqual(sum(e["kind"] == "applied" for e in second.evidence()["events"]), 1)
            finally: second.close()

    def test_concurrent_retries_have_one_effect(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "fixture.sqlite")
            initial = FixtureStore(path); initial.read_listing(P)
            change = initial.stage(P, {"title": "once"}); FixtureHost(initial).approve(change["id"], change["digest"]); initial.close()
            barrier = threading.Barrier(2)
            def apply():
                connection = FixtureStore(path)
                try:
                    barrier.wait(timeout=5)
                    return connection.apply(P, change["id"])["status"]
                finally: connection.close()
            with ThreadPoolExecutor(max_workers=2) as workers:
                self.assertEqual(list(workers.map(lambda _: apply(), range(2))), ["applied", "applied"])
            final = FixtureStore(path)
            try: self.assertEqual(sum(e["kind"] == "applied" for e in final.evidence()["events"]), 1)
            finally: final.close()

    def test_evidence_is_local_not_payment_or_upstream_proof(self):
        change = self.stage(); self.approve(change); self.store.apply(P, change["id"])
        evidence = self.store.evidence()
        for field in ["payment_attempted", "production_authority", "settlement_final", "upstream_runtime_exercised"]:
            self.assertIs(evidence[field], False)
        self.assertEqual(evidence["spend_usdc"], "0")
        self.assertNotIn("Approved fixture title", json.dumps(evidence))
        self.assertEqual(evidence["evidence_hash"], digest(evidence["events"]))


if __name__ == "__main__":
    # No provider/network implementation is present; catch accidental high-level connects.
    with patch("socket.create_connection", side_effect=AssertionError("network forbidden")):
        unittest.main(verbosity=2)
