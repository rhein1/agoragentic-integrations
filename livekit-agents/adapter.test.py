import asyncio
import importlib.util
import pathlib
import sys
import types
import unittest


class FakeFunctionTool:
    def __init__(self, function, name, description):
        self.function = function
        self.id = name
        self.description = description


def function_tool(function, *, name=None, description=None):
    return FakeFunctionTool(function, name or function.__name__, description or function.__doc__)


livekit = types.ModuleType("livekit")
livekit_agents = types.ModuleType("livekit.agents")
livekit_agents.function_tool = function_tool
sys.modules["livekit"] = livekit
sys.modules["livekit.agents"] = livekit_agents

spec = importlib.util.spec_from_file_location(
    "agoragentic_livekit",
    pathlib.Path(__file__).with_name("agoragentic_livekit.py"),
)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class FakeResponse:
    def __init__(self, payload=None):
        self.status_code = 200
        self._payload = payload or {"ok": True}
        self.headers = {}
        self.text = ""

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self):
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if url.endswith("/api/execute"):
            return FakeResponse({"receipt_id": "receipt-livekit-test"})
        return FakeResponse({"providers": []})


class LiveKitAdapterTest(unittest.TestCase):
    def test_async_tools_do_not_block_registration_or_hardcode_provider(self):
        session = FakeSession()
        tools = adapter.build_agoragentic_tools(api_key="test-key", session=session)
        self.assertEqual([tool.id for tool in tools], ["agoragentic_execute", "agoragentic_match"])
        self.assertEqual(session.calls, [])

        result = asyncio.run(tools[0].function("summarize a document", {"text": "demo"}, 0.05))
        preview = asyncio.run(tools[1].function("summarize a document", 0.05))

        self.assertEqual(result["receipt_id"], "receipt-livekit-test")
        self.assertEqual(preview, {"providers": []})
        execute_call = session.calls[0]
        self.assertEqual(execute_call[0:2], ("POST", "https://agoragentic.com/api/execute"))
        self.assertEqual(execute_call[2]["json"]["constraints"], {"max_cost": 0.05})
        self.assertNotIn("provider_id", execute_call[2]["json"])
        self.assertEqual(session.calls[1][0:2], ("GET", "https://agoragentic.com/api/execute/match"))

    def test_invalid_ceiling_fails_before_network(self):
        session = FakeSession()
        tools = adapter.build_agoragentic_tools(session=session)
        negative = asyncio.run(tools[0].function("summarize", {}, -1))
        non_finite = asyncio.run(tools[1].function("summarize", float("inf")))
        self.assertEqual(negative["error"]["code"], "invalid_input")
        self.assertEqual(non_finite["error"]["code"], "invalid_input")
        self.assertEqual(session.calls, [])


if __name__ == "__main__":
    unittest.main()
