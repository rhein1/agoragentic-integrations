"""Hermetic response and wallet contracts for the smolagents adapter."""

import importlib.util
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

TEST_ROOT = Path(__file__).parents[1] / "test"
sys.path.insert(0, str(TEST_ROOT))
from adapter_contract_testkit import CONTRACT, StubResponse  # noqa: E402

try:
    import requests
except ImportError:
    requests = types.ModuleType("requests")

    class Response:
        def __init__(self):
            self.status_code = 0
            self.url = ""
            self.headers = {}
            self._content = b""
            self.encoding = "utf-8"

        def json(self):
            return json.loads(self._content.decode(self.encoding))

    requests.Response = Response
    requests.get = None
    requests.post = None
    sys.modules["requests"] = requests


MODULE_PATH = Path(__file__).with_name("agoragentic_smolagents.py")
SPEC = importlib.util.spec_from_file_location("agoragentic_smolagents_under_test", MODULE_PATH)
ADAPTER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ADAPTER
SPEC.loader.exec_module(ADAPTER)
REQUIRE_REAL_SMOLAGENTS = os.environ.get("AGORAGENTIC_REQUIRE_REAL_SMOLAGENTS") == "1"


def response(status_code, payload=None, raw_body=None):
    """Build a real requests.Response without making a network request."""
    result = requests.Response()
    result.status_code = status_code
    result.url = "https://agoragentic.com/test"
    if raw_body is None:
        raw_body = json.dumps(payload)
        result.headers["Content-Type"] = "application/json"
    else:
        result.headers["Content-Type"] = "text/plain"
    result._content = raw_body.encode("utf-8")
    result.encoding = "utf-8"
    return result


class MalformedResponseTests(unittest.TestCase):
    def assert_explicit_decode_error(self, serialized, status_code):
        parsed = json.loads(serialized)
        self.assertEqual(parsed, {
            "error": "upstream_invalid_json",
            "status_code": status_code,
        })
        self.assertNotIn("status", parsed)
        self.assertNotIn("total_found", parsed)
        self.assertNotIn("top_providers", parsed)

    def test_malformed_success_responses_never_claim_success(self):
        cases = [
            (
                ADAPTER.AgoragenticExecuteTool(api_key="test-key"),
                "post",
                {"task": "summarize"},
                response(200, raw_body="<html>gateway</html>"),
            ),
            (
                ADAPTER.AgoragenticRegisterTool(),
                "post",
                {"agent_name": "test-agent"},
                response(201, raw_body='{"api_key":'),
            ),
            (
                ADAPTER.AgoragenticInvokeTool(api_key="test-key"),
                "post",
                {"capability_id": "cap_test"},
                response(200, raw_body="not-json"),
            ),
        ]

        for tool, method, kwargs, mocked_response in cases:
            with self.subTest(tool=tool.name):
                with patch.object(ADAPTER.requests, method, return_value=mocked_response):
                    self.assert_explicit_decode_error(tool.forward(**kwargs), mocked_response.status_code)

    def test_malformed_discovery_failures_never_look_empty(self):
        cases = [
            (
                ADAPTER.AgoragenticMatchTool(api_key="test-key"),
                {"task": "summarize"},
                response(429, raw_body="rate limited"),
            ),
            (
                ADAPTER.AgoragenticSearchTool(),
                {"query": "summarize"},
                response(502, raw_body="bad gateway"),
            ),
            (
                ADAPTER.AgoragenticSearchTool(),
                {"query": "summarize"},
                response(504, raw_body="gateway timeout"),
            ),
        ]

        for tool, kwargs, mocked_response in cases:
            with self.subTest(tool=tool.name, status=mocked_response.status_code):
                with patch.object(ADAPTER.requests, "get", return_value=mocked_response):
                    self.assert_explicit_decode_error(tool.forward(**kwargs), mocked_response.status_code)

    def test_structured_http_failure_remains_an_explicit_error(self):
        mocked_response = response(429, {
            "error": "rate_limited",
            "message": "Retry later.",
        })
        with patch.object(ADAPTER.requests, "get", return_value=mocked_response):
            parsed = json.loads(
                ADAPTER.AgoragenticMatchTool(api_key="test-key").forward("summarize")
            )

        self.assertEqual(parsed, {
            "error": "upstream_http_error",
            "status_code": 429,
        })

        unsafe = CONTRACT["unsafe_structured_http"]
        for payload in unsafe["payloads"]:
            with self.subTest(unsafe_payload=payload):
                mocked_response = response(unsafe["status_code"], payload)
                with patch.object(ADAPTER.requests, "get", return_value=mocked_response):
                    parsed = json.loads(
                        ADAPTER.AgoragenticMatchTool(api_key="test-key").forward("summarize")
                    )
                serialized = json.dumps(parsed)
                self.assertEqual(parsed, {"error": "upstream_http_error", "status_code": 429})
                self.assertNotIn(payload["error"], serialized)
                self.assertNotIn(payload["message"], serialized)

        mocked_response = response(302, [])
        with patch.object(ADAPTER.requests, "post", return_value=mocked_response):
            parsed = json.loads(
                ADAPTER.AgoragenticExecuteTool(api_key="test-key").forward("task")
            )
        self.assertEqual(parsed, {"error": "unexpected_http_status", "status_code": 302})

    def test_shared_invalid_2xx_vectors_never_claim_success(self):
        cases = {
            "execute": (
                "post", 200, lambda: ADAPTER.AgoragenticExecuteTool(api_key="test-key").forward("task")
            ),
            "register": (
                "post", 201, lambda: ADAPTER.AgoragenticRegisterTool().forward("agent")
            ),
            "invoke": (
                "post", 200, lambda: ADAPTER.AgoragenticInvokeTool(api_key="test-key").forward("cap")
            ),
            "match": (
                "get", 200, lambda: ADAPTER.AgoragenticMatchTool(api_key="test-key").forward("task")
            ),
            "search": (
                "get", 200, lambda: ADAPTER.AgoragenticSearchTool().forward("task")
            ),
        }
        for contract, vectors in CONTRACT["invalid_2xx"].items():
            method, status_code, invoke = cases[contract]
            for payload in vectors:
                with self.subTest(contract=contract, payload=payload):
                    mocked_response = response(status_code, payload)
                    with patch.object(ADAPTER.requests, method, return_value=mocked_response):
                        parsed = json.loads(invoke())
                    self.assertEqual(parsed["error"], "upstream_invalid_payload")
                    self.assertNotIn("status", parsed)


class HealthyResponseTests(unittest.TestCase):
    def test_execute_accepts_202_and_minimum_optional_shapes(self):
        for payload in CONTRACT["valid_execute_minimum"]:
            with self.subTest(payload=payload):
                mocked_response = response(202, payload)
                with patch.object(ADAPTER.requests, "post", return_value=mocked_response):
                    parsed = json.loads(
                        ADAPTER.AgoragenticExecuteTool(api_key="test-key").forward("task")
                    )
                self.assertEqual(parsed["status"], payload["status"])
                self.assertNotIn("error", parsed)

    def test_search_accepts_both_supported_payload_shapes_and_decodes_once(self):
        capability = {
            "id": "cap_test",
            "name": "Summarizer",
            "description": "Summarizes text",
            "price_per_unit": 0.1,
            "category": "ai-services",
            "seller_name": "Example Seller",
            "success_rate": 0.99,
        }

        for payload in ([capability], {"capabilities": [capability]}):
            with self.subTest(shape=type(payload).__name__):
                mocked_response = response(200, payload)
                original_json = mocked_response.json
                mocked_response.json = Mock(wraps=original_json)
                with patch.object(ADAPTER.requests, "get", return_value=mocked_response):
                    parsed = json.loads(ADAPTER.AgoragenticSearchTool().forward(query="summary"))

                self.assertEqual(parsed["total_found"], 1)
                self.assertEqual(parsed["capabilities"][0]["id"], "cap_test")
                self.assertEqual(mocked_response.json.call_count, 1)

    def test_existing_success_shapes_remain_unchanged(self):
        execute_response = response(200, {
            "status": "completed",
            "provider": {"name": "Provider One"},
            "output": {"summary": "done"},
            "cost": 0.05,
            "invocation_id": "inv_1",
        })
        with patch.object(ADAPTER.requests, "post", return_value=execute_response):
            execute = json.loads(
                ADAPTER.AgoragenticExecuteTool(api_key="test-key").forward("summarize")
            )
        self.assertEqual(execute, {
            "status": "completed",
            "provider": "Provider One",
            "output": {"summary": "done"},
            "cost_usdc": 0.05,
            "invocation_id": "inv_1",
        })

        register_response = response(201, {
            "agent": {"id": "agent_1"},
            "api_key": "test-key",
            "credits": 1,
        })
        with patch.object(ADAPTER.requests, "post", return_value=register_response):
            register = json.loads(ADAPTER.AgoragenticRegisterTool().forward("test-agent"))
        self.assertEqual(register["status"], "registered")
        self.assertEqual(register["agent_id"], "agent_1")
        self.assertEqual(register["api_key"], "test-key")

        invoke_response = response(200, {
            "invocation_id": "inv_2",
            "result": "done",
            "cost": 0.02,
            "seller_name": "Provider Two",
        })
        with patch.object(ADAPTER.requests, "post", return_value=invoke_response):
            invoke = json.loads(
                ADAPTER.AgoragenticInvokeTool(api_key="test-key").forward("cap_test")
            )
        self.assertEqual(invoke, {
            "status": "success",
            "invocation_id": "inv_2",
            "output": "done",
            "cost_usdc": 0.02,
            "seller": "Provider Two",
        })

        match_response = response(200, {
            "matches": 1,
            "providers": [{"name": "Provider One", "price": 0.05, "score": {"composite": 0.9}}],
        })
        with patch.object(ADAPTER.requests, "get", return_value=match_response):
            match = json.loads(
                ADAPTER.AgoragenticMatchTool(api_key="test-key").forward("summarize")
            )
        self.assertEqual(match, {
            "task": "summarize",
            "matches": 1,
            "top_providers": [{"name": "Provider One", "price": 0.05, "score": 0.9}],
        })

    def test_valid_empty_discovery_is_not_an_error(self):
        mocked_response = response(200, CONTRACT["valid_empty_discovery"]["match"])
        with patch.object(ADAPTER.requests, "get", return_value=mocked_response):
            parsed = json.loads(
                ADAPTER.AgoragenticMatchTool(api_key="test-key").forward("summarize")
            )
        self.assertEqual(parsed["matches"], 0)
        self.assertEqual(parsed["top_providers"], [])

        for payload in CONTRACT["valid_empty_discovery"]["search"]:
            with self.subTest(payload=payload):
                mocked_response = response(200, payload)
                with patch.object(ADAPTER.requests, "get", return_value=mocked_response):
                    parsed = json.loads(ADAPTER.AgoragenticSearchTool().forward("summary"))
                self.assertEqual(parsed["total_found"], 0)
                self.assertEqual(parsed["capabilities"], [])


class WalletValidationTests(unittest.TestCase):
    def test_invalid_wallets_are_rejected_before_any_request(self):
        for wallet in CONTRACT["invalid_wallets"]:
            with self.subTest(wallet=wallet):
                with patch.object(ADAPTER.requests, "get") as mocked_get:
                    parsed = json.loads(
                        ADAPTER.AgoragenticPassportTool().forward("verify", wallet)
                    )
                self.assertEqual(parsed["error"], "invalid_wallet_address")
                mocked_get.assert_not_called()

    def test_valid_wallets_use_the_exact_trimmed_verification_route(self):
        for wallet in CONTRACT["valid_wallets"]:
            with self.subTest(wallet=wallet):
                mocked_response = response(200, {"verified": False})
                with patch.object(ADAPTER.requests, "get", return_value=mocked_response) as mocked_get:
                    parsed = json.loads(
                        ADAPTER.AgoragenticPassportTool().forward("verify", wallet)
                    )

                self.assertEqual(parsed, {"verified": False})
                mocked_get.assert_called_once_with(
                    f"{ADAPTER.AGORAGENTIC_BASE_URL}/api/passport/verify/{wallet.strip()}",
                    timeout=15,
                )


class HubParityTests(unittest.TestCase):
    @unittest.skipUnless(REQUIRE_REAL_SMOLAGENTS, "real smolagents runtime not required")
    def test_canonical_execute_serializes_to_a_standalone_hub_tool(self):
        definition = ADAPTER.AgoragenticExecuteTool().to_dict()
        code = definition["code"]
        compile(code, "<agoragentic-hub-tool>", "exec")
        namespace = {}
        exec(code, namespace)
        generated_tool = namespace["AgoragenticExecuteTool"](api_key="test-key")

        malformed = StubResponse(200, raw_body="credential=should-not-echo")
        with patch("requests.post", return_value=malformed):
            parsed = json.loads(generated_tool.forward("task"))
        self.assertEqual(parsed, {"error": "upstream_invalid_json", "status_code": 200})
        self.assertNotIn("credential", json.dumps(parsed))

        with patch("requests.post", return_value=StubResponse(200, {})):
            parsed = json.loads(generated_tool.forward("task"))
        self.assertEqual(parsed, {"error": "upstream_invalid_payload", "status_code": 200})

        structured = StubResponse(429, {"error": "rate_limited", "message": "Retry later."})
        with patch("requests.post", return_value=structured):
            parsed = json.loads(generated_tool.forward("task"))
        self.assertEqual(parsed, {
            "error": "upstream_http_error", "status_code": 429
        })

        unsafe = CONTRACT["unsafe_structured_http"]
        for payload in unsafe["payloads"]:
            with self.subTest(unsafe_payload=payload):
                with patch("requests.post", return_value=StubResponse(unsafe["status_code"], payload)):
                    parsed = json.loads(generated_tool.forward("task"))
                serialized = json.dumps(parsed)
                self.assertEqual(parsed, {"error": "upstream_http_error", "status_code": 429})
                self.assertNotIn(payload["error"], serialized)
                self.assertNotIn(payload["message"], serialized)

        with patch("requests.post", return_value=StubResponse(302, [])):
            parsed = json.loads(generated_tool.forward("task"))
        self.assertEqual(parsed, {"error": "unexpected_http_status", "status_code": 302})

        accepted = StubResponse(202, CONTRACT["valid_execute_minimum"][0])
        with patch("requests.post", return_value=accepted):
            parsed = json.loads(generated_tool.forward("task"))
        self.assertEqual(parsed["status"], "accepted")
        self.assertNotIn("error", parsed)

        healthy = StubResponse(200, CONTRACT["valid_success"]["execute"])
        with patch("requests.post", return_value=healthy):
            parsed = json.loads(generated_tool.forward("task"))
        self.assertEqual(parsed, {
            "status": "completed",
            "provider": "Provider One",
            "output": {"summary": "done"},
            "cost_usdc": 0.05,
            "invocation_id": "inv_1",
        })

    @unittest.skipUnless(REQUIRE_REAL_SMOLAGENTS, "real smolagents runtime not required")
    def test_publisher_and_example_import_the_same_canonical_classes(self):
        module_dir = str(MODULE_PATH.parent)
        sys.path.insert(0, module_dir)
        try:
            publisher_spec = importlib.util.spec_from_file_location(
                "agoragentic_publish_hub_under_test", MODULE_PATH.with_name("_publish_hub.py")
            )
            publisher = importlib.util.module_from_spec(publisher_spec)
            publisher_spec.loader.exec_module(publisher)

            example_spec = importlib.util.spec_from_file_location(
                "agoragentic_smolagents_example_under_test", MODULE_PATH.with_name("example_smolagents.py")
            )
            example = importlib.util.module_from_spec(example_spec)
            example_spec.loader.exec_module(example)
        finally:
            sys.path.remove(module_dir)

        self.assertIs(publisher.AgoragenticExecuteTool, example.AgoragenticExecuteTool)
        self.assertEqual(example.InferenceClientModel.__name__, "InferenceClientModel")


class RuntimeContractTests(unittest.TestCase):
    @unittest.skipUnless(REQUIRE_REAL_SMOLAGENTS, "real smolagents runtime not required")
    def test_ci_uses_the_real_smolagents_tool_contract(self):
        self.assertEqual(ADAPTER.Tool.__module__, "smolagents.tools")
        tools = ADAPTER.get_all_tools("test-key")
        self.assertEqual(len(tools), 10)
        for tool in tools:
            tool.validate_arguments()


if __name__ == "__main__":
    unittest.main()
