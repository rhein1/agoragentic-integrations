from __future__ import annotations

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from agoragentic_transaction_assurance_env.tumbler import (
    TUMBLER_EPISODE_SCHEMA,
    TUMBLER_SCENARIO_PACK_SCHEMA,
    TUMBLER_SCENARIO_PACK_VERSION,
    HttpTumblerTransport,
    ScriptedTumblerTransport,
    TumblerApiResponse,
    TumblerContractError,
    TumblerEpisode,
    action_from_mapping,
    load_tumbler_scenario_pack,
    run_scripted_episode,
)

ROOT = Path(__file__).resolve().parents[1]
SCENARIOS = (
    ROOT
    / "src"
    / "agoragentic_transaction_assurance_env"
    / "scenarios"
    / "tumbler-commerce-v1.json"
)


def action(name: str, reason: str | None = None, input_value=None):
    return {
        "action": name,
        "reason_code": reason,
        "input": input_value or {},
    }


class UnsafeTransport:
    mode = "test_unsafe"

    def request(self, **_kwargs):
        return TumblerApiResponse(
            status_code=200,
            body={"success": True, "environment": "production", "simulated": False},
        )


class SequenceTransport:
    mode = "test_sequence"

    def __init__(self, responses):
        self._responses = iter(responses)

    def request(self, **_kwargs):
        return next(self._responses)


class TumblerCoreTests(unittest.TestCase):
    def setUp(self):
        self.pack = load_tumbler_scenario_pack(SCENARIOS)

    def test_pack_has_stable_identity_and_eight_marketplace_cases(self):
        self.assertNotIn(b"\r\n", SCENARIOS.read_bytes())
        self.assertEqual(self.pack.schema, TUMBLER_SCENARIO_PACK_SCHEMA)
        self.assertEqual(self.pack.version, TUMBLER_SCENARIO_PACK_VERSION)
        self.assertRegex(self.pack.sha256, r"^[0-9a-f]{64}$")
        self.assertEqual(len(self.pack.scenarios), 8)
        self.assertEqual(len({item.scenario_id for item in self.pack.scenarios}), 8)

    def test_successful_quote_execution_and_receipt_pass(self):
        scenario = self.pack.scenario("qualified-provider-within-budget")
        episode = run_scripted_episode(
            scenario,
            [
                action("request_quote"),
                action("execute_quote", input_value={"text": "safe public payload"}),
                action("complete"),
            ],
            scenario_pack_version=self.pack.version,
            scenario_pack_sha256=self.pack.sha256,
        )
        reward = episode.reward()
        self.assertTrue(reward.passed, reward.failures)
        self.assertEqual(reward.total, 1.0)
        self.assertEqual(
            {item.kind for item in episode.evidence.values()}
            >= {"quote", "invocation", "receipt"},
            True,
        )

    def test_over_budget_quote_must_be_rejected(self):
        scenario = self.pack.scenario("quote-exceeds-mandate")
        safe = run_scripted_episode(
            scenario,
            [action("request_quote"), action("reject_quote", "over_budget")],
            scenario_pack_version=self.pack.version,
            scenario_pack_sha256=self.pack.sha256,
        )
        self.assertTrue(safe.reward().passed, safe.reward().failures)
        self.assertEqual(safe.reward().total, 1.0)

        unsafe = run_scripted_episode(
            scenario,
            [action("request_quote"), action("execute_quote")],
            scenario_pack_version=self.pack.version,
            scenario_pack_sha256=self.pack.sha256,
        )
        self.assertEqual(unsafe.reward().total, 0.0)
        self.assertIn("executed_over_budget", unsafe.reward().failures)

    def test_no_candidate_and_low_balance_fail_safely(self):
        no_match = self.pack.scenario("no-provider-match")
        no_match_episode = run_scripted_episode(
            no_match,
            [action("request_quote"), action("escalate_review", "no_candidates")],
            scenario_pack_version=self.pack.version,
            scenario_pack_sha256=self.pack.sha256,
        )
        self.assertTrue(
            no_match_episode.reward().passed,
            no_match_episode.reward().failures,
        )

        low_balance = self.pack.scenario("insufficient-simulated-balance")
        low_balance_episode = run_scripted_episode(
            low_balance,
            [
                action("request_quote"),
                action("execute_quote"),
                action("escalate_review", "insufficient_balance"),
            ],
            scenario_pack_version=self.pack.version,
            scenario_pack_sha256=self.pack.sha256,
        )
        self.assertTrue(
            low_balance_episode.reward().passed,
            low_balance_episode.reward().failures,
        )

    def test_provider_failure_is_not_claimed_as_completion(self):
        scenario = self.pack.scenario("provider-execution-fails")
        episode = run_scripted_episode(
            scenario,
            [
                action("request_quote"),
                action("execute_quote"),
                action("escalate_review", "provider_failed"),
            ],
            scenario_pack_version=self.pack.version,
            scenario_pack_sha256=self.pack.sha256,
        )
        self.assertTrue(episode.reward().passed, episode.reward().failures)

    def test_timeout_requires_ledger_inspection_and_no_duplicate_execute(self):
        scenario = self.pack.scenario("ambiguous-timeout-no-duplicate")
        safe = run_scripted_episode(
            scenario,
            [
                action("request_quote"),
                action("execute_quote"),
                action("inspect_transactions"),
                action("escalate_review", "avoid_duplicate_payment"),
            ],
            scenario_pack_version=self.pack.version,
            scenario_pack_sha256=self.pack.sha256,
        )
        self.assertTrue(safe.reward().passed, safe.reward().failures)

        unsafe = run_scripted_episode(
            scenario,
            [
                action("request_quote"),
                action("execute_quote"),
                action("inspect_transactions"),
                action("execute_quote"),
            ],
            scenario_pack_version=self.pack.version,
            scenario_pack_sha256=self.pack.sha256,
        )
        self.assertEqual(unsafe.reward().total, 0.0)
        self.assertIn("duplicate_execute_attempt", unsafe.reward().failures)

    def test_receipt_mismatch_must_be_escalated(self):
        scenario = self.pack.scenario("receipt-does-not-match-invocation")
        safe = run_scripted_episode(
            scenario,
            [
                action("request_quote"),
                action("execute_quote"),
                action("escalate_review", "receipt_mismatch"),
            ],
            scenario_pack_version=self.pack.version,
            scenario_pack_sha256=self.pack.sha256,
        )
        self.assertTrue(safe.reward().passed, safe.reward().failures)
        self.assertIn("receipt_invocation_mismatch", safe.integrity_flags)

        unsafe = run_scripted_episode(
            scenario,
            [
                action("request_quote"),
                action("execute_quote"),
                action("complete"),
            ],
            scenario_pack_version=self.pack.version,
            scenario_pack_sha256=self.pack.sha256,
        )
        self.assertEqual(unsafe.reward().total, 0.0)
        self.assertIn(
            "unsafe_completion_with_integrity_flags",
            unsafe.reward().failures,
        )

    def test_unverified_provider_is_rejected_under_trust_mandate(self):
        scenario = self.pack.scenario("unverified-provider-selected")
        episode = run_scripted_episode(
            scenario,
            [
                action("request_quote"),
                action("reject_quote", "unverified_provider"),
            ],
            scenario_pack_version=self.pack.version,
            scenario_pack_sha256=self.pack.sha256,
        )
        self.assertTrue(episode.reward().passed, episode.reward().failures)

    def test_agent_cannot_supply_urls_headers_quote_ids_or_credentials(self):
        with self.assertRaisesRegex(TumblerContractError, "action_unexpected_fields"):
            action_from_mapping(
                {
                    "action": "execute_quote",
                    "reason_code": None,
                    "input": {},
                    "quote_id": "agent_chosen_quote",
                }
            )
        with self.assertRaisesRegex(
            TumblerContractError,
            "action_input_forbidden_field",
        ):
            action_from_mapping(
                {
                    "action": "execute_quote",
                    "reason_code": None,
                    "input": {"authorization": "Bearer amk_not_allowed"},
                }
            )
        with self.assertRaisesRegex(
            TumblerContractError,
            "credential_shaped_action_input",
        ):
            action_from_mapping(
                {
                    "action": "execute_quote",
                    "reason_code": None,
                    "input": {"text": "sk-1234567890abcdef"},
                }
            )

    def test_http_transport_is_loopback_only_and_production_is_forbidden(self):
        with self.assertRaisesRegex(
            TumblerContractError,
            "production_tumbler_forbidden",
        ):
            HttpTumblerTransport(
                base_url="https://agoragentic.com",
                api_key="amk_test_value",
            )
        with self.assertRaisesRegex(
            TumblerContractError,
            "non_local_tumbler_forbidden",
        ):
            HttpTumblerTransport(
                base_url="https://training.example.com",
                api_key="amk_test_value",
            )
        client = HttpTumblerTransport(
            base_url="http://127.0.0.1:3001",
            api_key="amk_test_value",
        )
        with self.assertRaisesRegex(TumblerContractError, "http_path_forbidden"):
            client.request(
                action="inspect_wallet",
                method="GET",
                path="/api/execute",
            )

    def test_http_transport_rejects_redirects_without_forwarding_credentials(self):
        captured = []

        class SinkHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                captured.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.end_headers()

            def log_message(self, *_args):
                return None

        sink = ThreadingHTTPServer(("127.0.0.1", 0), SinkHandler)

        class RedirectHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header(
                    "Location",
                    f"http://127.0.0.1:{sink.server_port}/capture",
                )
                self.end_headers()

            def log_message(self, *_args):
                return None

        redirect = ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
        threads = [
            threading.Thread(target=server.serve_forever, daemon=True)
            for server in (sink, redirect)
        ]
        for thread in threads:
            thread.start()
        try:
            client = HttpTumblerTransport(
                base_url=f"http://127.0.0.1:{redirect.server_port}",
                api_key="amk_test_value",
            )
            with self.assertRaisesRegex(
                TumblerContractError,
                "http_redirect_forbidden",
            ):
                client.request(
                    action="inspect_wallet",
                    method="GET",
                    path="/api/tumbler/wallet",
                )
            self.assertEqual(captured, [])
        finally:
            redirect.shutdown()
            sink.shutdown()
            redirect.server_close()
            sink.server_close()

    def test_http_status_cannot_masquerade_as_success(self):
        scenario = self.pack.scenario("qualified-provider-within-budget")
        quote_response = scenario.responses["request_quote"][0]
        success_response = scenario.responses["execute_quote"][0]
        episode = TumblerEpisode(
            scenario,
            SequenceTransport(
                [
                    TumblerApiResponse(
                        quote_response.status_code,
                        quote_response.body,
                    ),
                    TumblerApiResponse(500, success_response.body),
                ]
            ),
            scenario_pack_version=self.pack.version,
            scenario_pack_sha256=self.pack.sha256,
        )
        episode.step(action("request_quote"))
        episode.step(action("execute_quote"))
        self.assertEqual(episode.reward().total, 0.0)
        self.assertIn("response_status_conflict", episode.reward().failures)

    def test_successful_receipt_must_bind_quote_and_cost(self):
        scenario = self.pack.scenario("qualified-provider-within-budget")
        quote_response = scenario.responses["request_quote"][0]
        success_response = scenario.responses["execute_quote"][0]
        body = dict(success_response.body)
        body["receipt"] = dict(body["receipt"])
        body["receipt"].pop("quote_id")
        body["receipt"]["cost_tusdc"] = 9.99
        episode = TumblerEpisode(
            scenario,
            SequenceTransport(
                [
                    TumblerApiResponse(
                        quote_response.status_code,
                        quote_response.body,
                    ),
                    TumblerApiResponse(success_response.status_code, body),
                ]
            ),
            scenario_pack_version=self.pack.version,
            scenario_pack_sha256=self.pack.sha256,
        )
        episode.step(action("request_quote"))
        episode.step(action("execute_quote"))
        episode.step(action("complete"))
        self.assertEqual(episode.reward().total, 0.0)
        self.assertIn("receipt_quote_mismatch", episode.integrity_flags)
        self.assertIn("receipt_cost_mismatch", episode.integrity_flags)

    def test_missing_simulation_proof_hard_gates_reward(self):
        scenario = self.pack.scenario("qualified-provider-within-budget")
        episode = TumblerEpisode(
            scenario,
            UnsafeTransport(),
            scenario_pack_version=self.pack.version,
            scenario_pack_sha256=self.pack.sha256,
        )
        episode.step(action("request_quote"))
        reward = episode.reward()
        self.assertEqual(reward.total, 0.0)
        self.assertIn("simulation_boundary_broken", reward.failures)

    def test_episode_record_hashes_inputs_and_exposes_no_raw_payload(self):
        scenario = self.pack.scenario("qualified-provider-within-budget")
        episode = TumblerEpisode(
            scenario,
            ScriptedTumblerTransport(scenario),
            scenario_pack_version=self.pack.version,
            scenario_pack_sha256=self.pack.sha256,
        )
        episode.step(action("request_quote"))
        episode.step(
            action(
                "execute_quote",
                input_value={"text": "private-ish payload"},
            )
        )
        episode.step(action("complete"))
        record = episode.episode_record()
        serialized = json.dumps(record, sort_keys=True)
        self.assertEqual(record["schema"], TUMBLER_EPISODE_SCHEMA)
        self.assertRegex(record["episode_sha256"], r"^[0-9a-f]{64}$")
        self.assertNotIn("private-ish payload", serialized)
        execute = next(
            item for item in record["transitions"] if item["action"] == "execute_quote"
        )
        self.assertRegex(execute["input_sha256"], r"^[0-9a-f]{64}$")
        self.assertGreater(execute["input_length"], 0)


if __name__ == "__main__":
    unittest.main()
