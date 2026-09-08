"""Hermetic response and wallet contracts for the AutoGen adapter."""

import importlib.util
import inspect
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
        source = Path(__file__).with_name("agoragentic_autogen.py")
        spec = importlib.util.spec_from_file_location("agoragentic_autogen", source)
        cls.adapter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.adapter)

    def setUp(self):
        self.requests.get = Mock()
        self.requests.post = Mock()

    @staticmethod
    def parsed(serialized):
        return json.loads(serialized)

    def test_modern_tools_have_stable_names_and_signatures(self):
        tools = self.adapter.get_agoragentic_tools("amk_test")
        self.assertEqual([tool.__name__ for tool in tools], list(self.adapter.FUNCTION_MAP))
        execute = next(tool for tool in tools if tool.__name__ == "agoragentic_execute")
        self.assertEqual(list(inspect.signature(execute).parameters), ["task", "input_data", "max_cost"])

    def test_example_uses_the_canonical_tool_factory(self):
        example = Path(__file__).with_name("example_autogen.py").read_text(encoding="utf-8")
        self.assertIn("from agoragentic_autogen import get_agoragentic_tools", example)
        self.assertNotIn("def agoragentic_execute", example)
        self.assertNotIn("def agoragentic_match", example)

    def test_api_keys_are_isolated_per_tool_set(self):
        seen = []

        def fake_get(_url, **kwargs):
            seen.append(kwargs["headers"].get("Authorization"))
            return StubResponse(200, {"providers": []})

        self.requests.get = fake_get
        first = self.adapter.get_agoragentic_tools("amk_first")
        second = self.adapter.get_agoragentic_tools("amk_second")
        next(tool for tool in first if tool.__name__ == "agoragentic_match")("summarize")
        next(tool for tool in second if tool.__name__ == "agoragentic_match")("summarize")
        self.assertEqual(seen, ["Bearer amk_first", "Bearer amk_second"])

    def test_shared_invalid_2xx_vectors_never_claim_success(self):
        cases = {
            "execute": ("post", 200, lambda: self.adapter.agoragentic_execute("task")),
            "register": ("post", 201, lambda: self.adapter.agoragentic_register("agent")),
            "invoke": ("post", 200, lambda: self.adapter.agoragentic_invoke("cap")),
            "match": ("get", 200, lambda: self.adapter.agoragentic_match("task")),
            "search": ("get", 200, lambda: self.adapter.agoragentic_search("task")),
        }
        for contract, vectors in CONTRACT["invalid_2xx"].items():
            method, status, invoke = cases[contract]
            for payload in vectors:
                with self.subTest(contract=contract, payload=payload):
                    response = StubResponse(status, payload)
                    setattr(self.requests, method, Mock(return_value=response))
                    parsed = self.parsed(invoke())
                    self.assertEqual(parsed["error"], CONTRACT["errors"]["invalid_payload"])
                    self.assertEqual(response.json_calls, 1)

    def test_invalid_json_and_http_failures_are_explicit_and_body_free(self):
        malformed = StubResponse(200, raw_body="<html>credential=should-not-echo</html>")
        self.requests.post.return_value = malformed
        parsed = self.parsed(self.adapter.agoragentic_execute("task"))
        self.assertEqual(parsed, {"error": "upstream_invalid_json", "status_code": 200})
        self.assertNotIn("credential", json.dumps(parsed))

        structured = StubResponse(429, {"error": "rate_limited", "message": "Retry later."})
        self.requests.get.return_value = structured
        self.assertEqual(self.parsed(self.adapter.agoragentic_match("task")), {
            "error": "upstream_http_error", "status_code": 429
        })

        unsafe = CONTRACT["unsafe_structured_http"]
        for payload in unsafe["payloads"]:
            with self.subTest(unsafe_payload=payload):
                self.requests.get.return_value = StubResponse(unsafe["status_code"], payload)
                parsed = self.parsed(self.adapter.agoragentic_match("task"))
                serialized = json.dumps(parsed)
                self.assertEqual(parsed, {"error": "upstream_http_error", "status_code": 429})
                self.assertNotIn(payload["error"], serialized)
                self.assertNotIn(payload["message"], serialized)

        unstructured = StubResponse(502, ["secret bytes"])
        self.requests.get.return_value = unstructured
        parsed = self.parsed(self.adapter.agoragentic_search("task"))
        self.assertEqual(parsed, {"error": "upstream_http_error", "status_code": 502})
        self.assertNotIn("secret bytes", json.dumps(parsed))

        self.requests.post.return_value = StubResponse(302, [])
        parsed = self.parsed(self.adapter.agoragentic_execute("task"))
        self.assertEqual(parsed, {
            "error": CONTRACT["errors"]["unexpected_status"], "status_code": 302
        })

    def test_execute_accepts_202_and_minimum_optional_shapes(self):
        for payload in CONTRACT["valid_execute_minimum"]:
            with self.subTest(payload=payload):
                self.requests.post.return_value = StubResponse(202, payload)
                parsed = self.parsed(self.adapter.agoragentic_execute("task"))
                self.assertEqual(parsed["status"], payload["status"])
                self.assertNotIn("error", parsed)

    def test_valid_empty_discovery_is_not_an_error(self):
        empty_match = CONTRACT["valid_empty_discovery"]["match"]
        self.requests.get.return_value = StubResponse(200, empty_match)
        self.assertEqual(self.parsed(self.adapter.agoragentic_match("task")), empty_match)

        for payload in CONTRACT["valid_empty_discovery"]["search"]:
            with self.subTest(payload=payload):
                self.requests.get.return_value = StubResponse(200, payload)
                parsed = self.parsed(self.adapter.agoragentic_search("task"))
                self.assertEqual(parsed["total_found"], 0)
                self.assertEqual(parsed["capabilities"], [])

    def test_existing_success_shapes_remain_unchanged(self):
        success = CONTRACT["valid_success"]

        self.requests.post.return_value = StubResponse(200, success["execute"])
        self.assertEqual(self.parsed(self.adapter.agoragentic_execute("task")), {
            "status": "completed",
            "invocation_id": "inv_1",
            "output": {"summary": "done"},
            "cost_usdc": 0.05,
            "receipt": "rcpt_1",
        })

        self.requests.post.return_value = StubResponse(201, success["register"])
        registered = self.parsed(self.adapter.agoragentic_register("agent"))
        self.assertEqual(registered["status"], "registered")
        self.assertEqual(registered["agent_id"], "agent_1")
        self.assertEqual(registered["api_key"], "amk_test")

        self.requests.post.return_value = StubResponse(200, success["invoke"])
        self.assertEqual(self.parsed(self.adapter.agoragentic_invoke("cap")), {
            "status": "success", "output": {"value": "done"}, "cost_usdc": 0.02
        })

        self.requests.get.return_value = StubResponse(200, success["match"])
        self.assertEqual(self.parsed(self.adapter.agoragentic_match("task")), success["match"])

        self.requests.get.return_value = StubResponse(200, success["search"])
        search = self.parsed(self.adapter.agoragentic_search("task"))
        self.assertEqual(search["total_found"], 1)
        self.assertEqual(search["capabilities"][0]["id"], "cap_1")

    def test_wallet_validation_is_zero_request_and_exact_route(self):
        for wallet in CONTRACT["invalid_wallets"]:
            with self.subTest(wallet=wallet):
                self.requests.get.reset_mock()
                parsed = self.parsed(self.adapter.agoragentic_passport("verify", wallet))
                self.assertEqual(parsed["error"], CONTRACT["errors"]["invalid_wallet"])
                self.requests.get.assert_not_called()

        for wallet in CONTRACT["valid_wallets"]:
            with self.subTest(wallet=wallet):
                self.requests.get.reset_mock()
                self.requests.get.return_value = StubResponse(200, {"verified": False})
                result = self.parsed(self.adapter.agoragentic_passport("verify", wallet))
                self.assertEqual(result, {"verified": False})
                self.requests.get.assert_called_once_with(
                    f"{self.adapter.AGORAGENTIC_BASE_URL}/api/passport/verify/{wallet.strip()}",
                    timeout=15,
                )


if __name__ == "__main__":
    unittest.main()
