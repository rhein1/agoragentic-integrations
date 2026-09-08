"""Hermetic response and wallet contracts for the CrewAI adapter."""

import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock

TEST_ROOT = Path(__file__).parents[1] / "test"
sys.path.insert(0, str(TEST_ROOT))
from adapter_contract_testkit import CONTRACT, StubResponse  # noqa: E402


class FakeBaseModel:
    pass


def fake_field(default=None, default_factory=None, **_kwargs):
    return default_factory() if default_factory is not None else default


class FakeBaseTool:
    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)


class AdapterContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.requests = types.SimpleNamespace()
        sys.modules["requests"] = cls.requests
        sys.modules["pydantic"] = types.SimpleNamespace(BaseModel=FakeBaseModel, Field=fake_field)
        sys.modules["crewai"] = types.ModuleType("crewai")
        sys.modules["crewai.tools"] = types.SimpleNamespace(BaseTool=FakeBaseTool)
        source = Path(__file__).with_name("agoragentic_crewai.py")
        spec = importlib.util.spec_from_file_location("agoragentic_crewai", source)
        cls.adapter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.adapter)

    def setUp(self):
        self.requests.get = Mock()
        self.requests.post = Mock()

    def test_shared_invalid_2xx_vectors_never_claim_success(self):
        cases = {
            "execute": ("post", 200, lambda: self.adapter.AgoragenticExecuteTool(api_key="key")._run("task")),
            "register": ("post", 201, lambda: self.adapter.AgoragenticRegisterTool()._run("agent")),
            "invoke": ("post", 200, lambda: self.adapter.AgoragenticInvokeTool(api_key="key")._run("cap")),
            "match": ("get", 200, lambda: self.adapter.AgoragenticMatchTool(api_key="key")._run("task")),
            "search": ("get", 200, lambda: self.adapter.AgoragenticSearchTool()._run("task")),
        }
        for contract, vectors in CONTRACT["invalid_2xx"].items():
            method, status, invoke = cases[contract]
            for payload in vectors:
                with self.subTest(contract=contract, payload=payload):
                    response = StubResponse(status, payload)
                    setattr(self.requests, method, Mock(return_value=response))
                    result = invoke()
                    self.assertIn("upstream_invalid_payload", result)
                    self.assertNotIn("Success!", result)
                    self.assertNotIn("Registered successfully!", result)
                    self.assertEqual(response.json_calls, 1)

    def test_invalid_json_and_http_failures_are_explicit_and_body_free(self):
        malformed = StubResponse(200, raw_body="<html>credential=should-not-echo</html>")
        self.requests.post.return_value = malformed
        result = self.adapter.AgoragenticExecuteTool(api_key="key")._run("task")
        self.assertIn("upstream_invalid_json", result)
        self.assertNotIn("credential", result)

        structured = StubResponse(429, {"error": "rate_limited", "message": "Retry later."})
        self.requests.get.return_value = structured
        result = self.adapter.AgoragenticMatchTool(api_key="key")._run("task")
        self.assertEqual(result, "Error [upstream_http_error] (HTTP 429)")
        self.assertNotIn("Retry later.", result)

        unsafe = CONTRACT["unsafe_structured_http"]
        for payload in unsafe["payloads"]:
            with self.subTest(unsafe_payload=payload):
                self.requests.get.return_value = StubResponse(unsafe["status_code"], payload)
                result = self.adapter.AgoragenticMatchTool(api_key="key")._run("task")
                self.assertEqual(result, "Error [upstream_http_error] (HTTP 429)")
                self.assertNotIn(payload["error"], result)
                self.assertNotIn(payload["message"], result)

        unstructured = StubResponse(502, ["secret bytes"])
        self.requests.get.return_value = unstructured
        result = self.adapter.AgoragenticSearchTool()._run("task")
        self.assertIn("upstream_http_error", result)
        self.assertNotIn("secret bytes", result)

        self.requests.post.return_value = StubResponse(302, [])
        result = self.adapter.AgoragenticExecuteTool(api_key="key")._run("task")
        self.assertEqual(result, "Error [unexpected_http_status] (HTTP 302)")

    def test_execute_accepts_202_and_minimum_optional_shapes(self):
        for payload in CONTRACT["valid_execute_minimum"]:
            with self.subTest(payload=payload):
                self.requests.post.return_value = StubResponse(202, payload)
                result = self.adapter.AgoragenticExecuteTool(api_key="key")._run("task")
                self.assertIn(f"Status: {payload['status']}", result)
                self.assertNotIn("Error [", result)

    def test_business_failures_never_echo_upstream_messages(self):
        unsafe = CONTRACT["unsafe_structured_http"]
        for payload in unsafe["payloads"]:
            with self.subTest(unsafe_payload=payload):
                response = {"success": False, **payload}
                self.requests.post.return_value = StubResponse(200, response)
                memory = self.adapter.AgoragenticMemoryTool(api_key="key")._run("key", "value")
                self.assertEqual(memory, "Error: Write failed")
                self.assertNotIn(payload["error"], memory)
                self.assertNotIn(payload["message"], memory)

                self.requests.post.return_value = StubResponse(200, response)
                secret = self.adapter.AgoragenticSecretStoreTool(api_key="key")._run("label", "value")
                self.assertEqual(secret, "Error: Store failed")
                self.assertNotIn(payload["error"], secret)
                self.assertNotIn(payload["message"], secret)

    def test_valid_empty_discovery_is_not_an_error(self):
        self.requests.get.return_value = StubResponse(200, CONTRACT["valid_empty_discovery"]["match"])
        result = self.adapter.AgoragenticMatchTool(api_key="key")._run("task")
        self.assertIn('"providers": []', result)
        self.assertNotIn("Error [", result)

        for payload in CONTRACT["valid_empty_discovery"]["search"]:
            self.requests.get.return_value = StubResponse(200, payload)
            result = self.adapter.AgoragenticSearchTool()._run("task")
            self.assertTrue(result.startswith("No capabilities found"))

    def test_existing_success_shapes_remain_unchanged(self):
        success = CONTRACT["valid_success"]
        self.requests.post.return_value = StubResponse(200, success["execute"])
        result = self.adapter.AgoragenticExecuteTool(api_key="key")._run("task")
        self.assertIn("Status: completed", result)
        self.assertIn("Invocation ID: inv_1", result)
        self.assertIn("Result:", result)

        self.requests.post.return_value = StubResponse(201, success["register"])
        result = self.adapter.AgoragenticRegisterTool()._run("agent")
        self.assertIn("Registered successfully!", result)
        self.assertIn("Agent ID: agent_1", result)
        self.assertIn("API Key: amk_test", result)

        self.requests.post.return_value = StubResponse(200, success["invoke"])
        result = self.adapter.AgoragenticInvokeTool(api_key="key")._run("cap")
        self.assertIn("Success! Invocation ID: inv_2", result)

        self.requests.get.return_value = StubResponse(200, success["match"])
        result = self.adapter.AgoragenticMatchTool(api_key="key")._run("task")
        self.assertIn('"matches": 1', result)

        self.requests.get.return_value = StubResponse(200, success["search"])
        result = self.adapter.AgoragenticSearchTool()._run("task")
        self.assertTrue(result.startswith("Found 1 capabilities:"))

    def test_wallet_validation_is_zero_request_and_exact_route(self):
        for wallet in CONTRACT["invalid_wallets"]:
            with self.subTest(wallet=wallet):
                self.requests.get.reset_mock()
                result = self.adapter.AgoragenticPassportTool()._run("verify", wallet)
                self.assertIn("invalid_wallet_address", result)
                self.requests.get.assert_not_called()
        for wallet in CONTRACT["valid_wallets"]:
            with self.subTest(wallet=wallet):
                self.requests.get.reset_mock()
                self.requests.get.return_value = StubResponse(200, {"verified": False})
                result = self.adapter.AgoragenticPassportTool()._run("verify", wallet)
                self.assertEqual(result, f"No passport found for wallet {wallet.strip()}")
                self.requests.get.assert_called_once_with(
                    f"{self.adapter.AGORAGENTIC_BASE_URL}/api/passport/verify/{wallet.strip()}", timeout=15
                )


if __name__ == "__main__":
    unittest.main()
