"""Hermetic response and wallet contracts for the LangChain adapters."""

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


class FakeBaseModel:
    pass


def fake_field(default=None, default_factory=None, **_kwargs):
    return default_factory() if default_factory is not None else default


class FakeBaseTool:
    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)


def fake_tool(function):
    return function


class AdapterContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.requests = types.SimpleNamespace()
        sys.modules["requests"] = cls.requests
        sys.modules["pydantic"] = types.SimpleNamespace(BaseModel=FakeBaseModel, Field=fake_field)
        sys.modules["langchain"] = types.ModuleType("langchain")
        sys.modules["langchain.tools"] = types.SimpleNamespace(BaseTool=FakeBaseTool)
        sys.modules["langchain_core"] = types.ModuleType("langchain_core")
        sys.modules["langchain_core.tools"] = types.SimpleNamespace(BaseTool=FakeBaseTool, tool=fake_tool)

        source = Path(__file__).with_name("agoragentic_tools.py")
        spec = importlib.util.spec_from_file_location("agoragentic_tools", source)
        cls.adapter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.adapter)

        deep_source = Path(__file__).with_name("deepagents_adapter.py")
        deep_spec = importlib.util.spec_from_file_location("deepagents_adapter", deep_source)
        cls.deep_adapter = importlib.util.module_from_spec(deep_spec)
        deep_spec.loader.exec_module(cls.deep_adapter)

    def setUp(self):
        self.requests.get = Mock()
        self.requests.post = Mock()

    @staticmethod
    def parsed(serialized):
        return json.loads(serialized)

    def test_tool_factory_keeps_execute_and_match_primary(self):
        tools = self.adapter.get_agoragentic_tools("amk_test")
        names = [tool.name for tool in tools]
        self.assertEqual(names[:3], ["agoragentic_register", "agoragentic_execute", "agoragentic_match"])
        self.assertNotIn("initialize_agent", self.adapter.__doc__)

    def test_readme_uses_current_agent_constructor(self):
        readme = Path(__file__).with_name("README.md").read_text(encoding="utf-8")
        self.assertIn("from langchain.agents import create_agent", readme)
        self.assertIn("agent = create_agent(", readme)
        self.assertNotIn("initialize_agent", readme)
        self.assertNotIn("AgentType", readme)

    def test_shared_invalid_2xx_vectors_never_claim_success(self):
        cases = {
            "execute": ("post", 200, lambda: self.adapter.AgoragenticExecute(api_key="key")._run("task")),
            "register": ("post", 201, lambda: self.adapter.AgoragenticRegister()._run("agent")),
            "invoke": ("post", 200, lambda: self.adapter.AgoragenticInvoke(api_key="key")._run("cap")),
            "match": ("get", 200, lambda: self.adapter.AgoragenticMatch(api_key="key")._run("task")),
            "search": ("get", 200, lambda: self.adapter.AgoragenticSearch()._run("task")),
        }
        for contract, vectors in CONTRACT["invalid_2xx"].items():
            method, status, invoke = cases[contract]
            for payload in vectors:
                with self.subTest(contract=contract, payload=payload):
                    response = StubResponse(status, payload)
                    setattr(self.requests, method, Mock(return_value=response))
                    parsed = self.parsed(invoke())
                    self.assertEqual(parsed["error"], "upstream_invalid_payload")
                    self.assertEqual(response.json_calls, 1)

    def test_invalid_json_and_http_failures_are_explicit_and_body_free(self):
        malformed = StubResponse(200, raw_body="<html>credential=should-not-echo</html>")
        self.requests.post.return_value = malformed
        parsed = self.parsed(self.adapter.AgoragenticExecute(api_key="key")._run("task"))
        self.assertEqual(parsed, {"error": "upstream_invalid_json", "status_code": 200})
        self.assertNotIn("credential", json.dumps(parsed))

        structured = StubResponse(429, {"error": "rate_limited", "message": "Retry later."})
        self.requests.get.return_value = structured
        self.assertEqual(self.parsed(self.adapter.AgoragenticMatch(api_key="key")._run("task")), {
            "error": "upstream_http_error", "status_code": 429
        })

        unsafe = CONTRACT["unsafe_structured_http"]
        for payload in unsafe["payloads"]:
            with self.subTest(unsafe_payload=payload):
                self.requests.post.return_value = StubResponse(unsafe["status_code"], payload)
                parsed = self.parsed(self.adapter.AgoragenticExecute(api_key="key")._run("task"))
                serialized = json.dumps(parsed)
                self.assertEqual(parsed, {"error": "upstream_http_error", "status_code": 429})
                self.assertNotIn(payload["error"], serialized)
                self.assertNotIn(payload["message"], serialized)

                execute = self.deep_adapter.create_agoragentic_tools("key")[0]
                parsed = self.parsed(execute("task", "{}"))
                serialized = json.dumps(parsed)
                self.assertEqual(parsed, {"error": "upstream_http_error", "status_code": 429})
                self.assertNotIn(payload["error"], serialized)
                self.assertNotIn(payload["message"], serialized)

        unstructured = StubResponse(502, ["secret bytes"])
        self.requests.get.return_value = unstructured
        parsed = self.parsed(self.adapter.AgoragenticSearch()._run("task"))
        self.assertEqual(parsed, {"error": "upstream_http_error", "status_code": 502})
        self.assertNotIn("secret bytes", json.dumps(parsed))

        self.requests.post.return_value = StubResponse(302, [])
        parsed = self.parsed(self.adapter.AgoragenticExecute(api_key="key")._run("task"))
        self.assertEqual(parsed, {"error": "unexpected_http_status", "status_code": 302})

        execute = self.deep_adapter.create_agoragentic_tools("key")[0]
        parsed = self.parsed(execute("task", "{}"))
        self.assertEqual(parsed, {"error": "unexpected_http_status", "status_code": 302})

    def test_execute_accepts_202_and_minimum_optional_shapes(self):
        for payload in CONTRACT["valid_execute_minimum"]:
            with self.subTest(payload=payload):
                self.requests.post.return_value = StubResponse(202, payload)
                parsed = self.parsed(self.adapter.AgoragenticExecute(api_key="key")._run("task"))
                self.assertEqual(parsed["status"], payload["status"])
                self.assertNotIn("error", parsed)

                execute = self.deep_adapter.create_agoragentic_tools("key")[0]
                parsed = self.parsed(execute("task", "{}"))
                self.assertEqual(parsed, payload)

    def test_valid_empty_discovery_is_not_an_error(self):
        empty_match = CONTRACT["valid_empty_discovery"]["match"]
        self.requests.get.return_value = StubResponse(200, empty_match)
        self.assertEqual(self.parsed(self.adapter.AgoragenticMatch(api_key="key")._run("task")), empty_match)
        for payload in CONTRACT["valid_empty_discovery"]["search"]:
            self.requests.get.return_value = StubResponse(200, payload)
            parsed = self.parsed(self.adapter.AgoragenticSearch()._run("task"))
            self.assertEqual(parsed["total_found"], 0)

    def test_existing_success_shapes_remain_unchanged(self):
        success = CONTRACT["valid_success"]
        self.requests.post.return_value = StubResponse(200, success["execute"])
        execute = self.parsed(self.adapter.AgoragenticExecute(api_key="key")._run("task"))
        self.assertEqual(execute["status"], "completed")
        self.assertEqual(execute["invocation_id"], "inv_1")
        self.assertEqual(execute["receipt"], "rcpt_1")

        self.requests.post.return_value = StubResponse(201, success["register"])
        register = self.parsed(self.adapter.AgoragenticRegister()._run("agent"))
        self.assertEqual(register["status"], "registered")
        self.assertEqual(register["agent_id"], "agent_1")
        self.assertEqual(register["api_key"], "amk_test")

        self.requests.post.return_value = StubResponse(200, success["invoke"])
        invoke = self.parsed(self.adapter.AgoragenticInvoke(api_key="key")._run("cap"))
        self.assertEqual(invoke["status"], "success")
        self.assertEqual(invoke["invocation_id"], "inv_2")

        self.requests.get.return_value = StubResponse(200, success["match"])
        self.assertEqual(
            self.parsed(self.adapter.AgoragenticMatch(api_key="key")._run("task")),
            success["match"],
        )

        self.requests.get.return_value = StubResponse(200, success["search"])
        search = self.parsed(self.adapter.AgoragenticSearch()._run("task"))
        self.assertEqual(search["total_found"], 1)
        self.assertEqual(search["capabilities"][0]["id"], "cap_1")

    def test_wallet_validation_is_zero_request_and_exact_route(self):
        for wallet in CONTRACT["invalid_wallets"]:
            with self.subTest(wallet=wallet):
                self.requests.get.reset_mock()
                parsed = self.parsed(self.adapter.AgoragenticPassport()._run("verify", wallet))
                self.assertEqual(parsed["error"], "invalid_wallet_address")
                self.requests.get.assert_not_called()
        for wallet in CONTRACT["valid_wallets"]:
            with self.subTest(wallet=wallet):
                self.requests.get.reset_mock()
                self.requests.get.return_value = StubResponse(200, {"verified": False})
                result = self.parsed(self.adapter.AgoragenticPassport()._run("verify", wallet))
                self.assertEqual(result, {"verified": False})
                self.requests.get.assert_called_once_with(
                    f"{self.adapter.AGORAGENTIC_BASE_URL}/api/passport/verify/{wallet.strip()}", timeout=15
                )

    def test_deepagents_never_echoes_upstream_bytes(self):
        self.requests.post.return_value = StubResponse(502, raw_body="credential=should-not-echo")
        execute = self.deep_adapter.create_agoragentic_tools("key")[0]
        parsed = self.parsed(execute("task", "{}"))
        self.assertEqual(parsed, {"error": "upstream_invalid_json", "status_code": 502})
        self.assertNotIn("credential", json.dumps(parsed))


if __name__ == "__main__":
    unittest.main()
