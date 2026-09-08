"""Hermetic response and wallet contracts for the Syrin adapter."""

import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock

TEST_ROOT = Path(__file__).parents[1] / "test"
sys.path.insert(0, str(TEST_ROOT))
from adapter_contract_testkit import CONTRACT, StubResponse  # noqa: E402


class AdapterContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.requests = types.SimpleNamespace()
        sys.modules["requests"] = cls.requests
        source = Path(__file__).with_name("agoragentic_syrin.py")
        spec = importlib.util.spec_from_file_location("agoragentic_syrin", source)
        cls.adapter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.adapter)

    def setUp(self):
        self.requests.get = Mock()
        self.requests.post = Mock()

    def test_shared_invalid_2xx_vectors_never_claim_success(self):
        cases = {
            "execute": ("post", 200, lambda: self.adapter.agoragentic_execute("task", _api_key="key")),
            "register": ("post", 201, lambda: self.adapter.agoragentic_register("agent")),
            "invoke": ("post", 200, lambda: self.adapter.agoragentic_invoke("cap", _api_key="key")),
            "match": ("get", 200, lambda: self.adapter.agoragentic_match("task", _api_key="key")),
            "search": ("get", 200, lambda: self.adapter.agoragentic_search("task")),
        }
        for contract, vectors in CONTRACT["invalid_2xx"].items():
            method, status, invoke = cases[contract]
            for payload in vectors:
                with self.subTest(contract=contract, payload=payload):
                    response = StubResponse(status, payload)
                    setattr(self.requests, method, Mock(return_value=response))
                    result = invoke()
                    self.assertEqual(result["error"], "upstream_invalid_payload")
                    self.assertNotIn("status", result)
                    self.assertEqual(response.json_calls, 1)

    def test_invalid_json_and_http_failures_are_explicit_and_body_free(self):
        malformed = StubResponse(200, raw_body="<html>credential=should-not-echo</html>")
        self.requests.post.return_value = malformed
        result = self.adapter.agoragentic_execute("task", _api_key="key")
        self.assertEqual(result, {"error": "upstream_invalid_json", "status_code": 200})
        self.assertNotIn("credential", json.dumps(result))

        structured = StubResponse(429, {"error": "rate_limited", "message": "Retry later."})
        self.requests.get.return_value = structured
        self.assertEqual(self.adapter.agoragentic_match("task", _api_key="key"), {
            "error": "upstream_http_error", "status_code": 429
        })

        unsafe = CONTRACT["unsafe_structured_http"]
        for payload in unsafe["payloads"]:
            with self.subTest(unsafe_payload=payload):
                self.requests.get.return_value = StubResponse(unsafe["status_code"], payload)
                result = self.adapter.agoragentic_match("task", _api_key="key")
                serialized = json.dumps(result)
                self.assertEqual(result, {"error": "upstream_http_error", "status_code": 429})
                self.assertNotIn(payload["error"], serialized)
                self.assertNotIn(payload["message"], serialized)

        unstructured = StubResponse(502, ["secret bytes"])
        self.requests.get.return_value = unstructured
        result = self.adapter.agoragentic_search("task")
        self.assertEqual(result, {"error": "upstream_http_error", "status_code": 502})
        self.assertNotIn("secret bytes", json.dumps(result))

        self.requests.post.return_value = StubResponse(302, [])
        result = self.adapter.agoragentic_execute("task", _api_key="key")
        self.assertEqual(result, {"error": "unexpected_http_status", "status_code": 302})

    def test_execute_accepts_202_and_minimum_optional_shapes(self):
        for payload in CONTRACT["valid_execute_minimum"]:
            with self.subTest(payload=payload):
                self.requests.post.return_value = StubResponse(202, payload)
                result = self.adapter.agoragentic_execute("task", _api_key="key")
                self.assertEqual(result["status"], payload["status"])
                self.assertNotIn("error", result)

    def test_valid_empty_discovery_is_not_an_error(self):
        self.requests.get.return_value = StubResponse(200, CONTRACT["valid_empty_discovery"]["match"])
        match = self.adapter.agoragentic_match("task", _api_key="key")
        self.assertEqual(match["top_providers"], [])
        self.assertEqual(match["matches"], 0)
        for payload in CONTRACT["valid_empty_discovery"]["search"]:
            self.requests.get.return_value = StubResponse(200, payload)
            search = self.adapter.agoragentic_search("task")
            self.assertEqual(search["total_found"], 0)
            self.assertEqual(search["capabilities"], [])

    def test_existing_success_shapes_remain_unchanged(self):
        success = CONTRACT["valid_success"]
        self.requests.post.return_value = StubResponse(200, success["execute"])
        self.assertEqual(self.adapter.agoragentic_execute("task", _api_key="key"), {
            "status": "completed",
            "provider": "Provider One",
            "output": {"summary": "done"},
            "cost_usdc": 0.05,
            "invocation_id": "inv_1",
        })

        self.requests.post.return_value = StubResponse(201, success["register"])
        register = self.adapter.agoragentic_register("agent")
        self.assertEqual(register["status"], "registered")
        self.assertEqual(register["agent_id"], "agent_1")
        self.assertEqual(register["api_key"], "amk_test")

        self.requests.post.return_value = StubResponse(200, success["invoke"])
        invoke = self.adapter.agoragentic_invoke("cap", _api_key="key")
        self.assertEqual(invoke["status"], "success")
        self.assertEqual(invoke["invocation_id"], "inv_2")

        self.requests.get.return_value = StubResponse(200, success["match"])
        match = self.adapter.agoragentic_match("task", _api_key="key")
        self.assertEqual(match["matches"], 1)
        self.assertEqual(match["top_providers"][0]["name"], "Provider One")

        self.requests.get.return_value = StubResponse(200, success["search"])
        search = self.adapter.agoragentic_search("task")
        self.assertEqual(search["total_found"], 1)
        self.assertEqual(search["capabilities"][0]["id"], "cap_1")

    def test_wallet_validation_is_zero_request_and_exact_route(self):
        for wallet in CONTRACT["invalid_wallets"]:
            with self.subTest(wallet=wallet):
                self.requests.get.reset_mock()
                result = self.adapter.agoragentic_passport("verify", wallet)
                self.assertEqual(result["error"], "invalid_wallet_address")
                self.requests.get.assert_not_called()
        for wallet in CONTRACT["valid_wallets"]:
            with self.subTest(wallet=wallet):
                self.requests.get.reset_mock()
                self.requests.get.return_value = StubResponse(200, {"verified": False})
                result = self.adapter.agoragentic_passport("verify", wallet)
                self.assertEqual(result, {"verified": False})
                self.requests.get.assert_called_once_with(
                    f"{self.adapter.AGORAGENTIC_BASE_URL}/api/passport/verify/{wallet.strip()}", timeout=15
                )


if __name__ == "__main__":
    unittest.main()
