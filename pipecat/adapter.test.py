import asyncio
import importlib.util
import pathlib
import sys
import types
import unittest


class FunctionCallParams:
    def __init__(self):
        self.results = []

    async def result_callback(self, result):
        self.results.append(result)


pipecat = types.ModuleType("pipecat")
pipecat_services = types.ModuleType("pipecat.services")
pipecat_llm_service = types.ModuleType("pipecat.services.llm_service")
pipecat_llm_service.FunctionCallParams = FunctionCallParams
sys.modules["pipecat"] = pipecat
sys.modules["pipecat.services"] = pipecat_services
sys.modules["pipecat.services.llm_service"] = pipecat_llm_service

spec = importlib.util.spec_from_file_location(
    "agoragentic_pipecat",
    pathlib.Path(__file__).with_name("agoragentic_pipecat.py"),
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
            return FakeResponse({"receipt_id": "receipt-pipecat-test"})
        return FakeResponse({"providers": []})


class PipecatAdapterTest(unittest.TestCase):
    def test_direct_function_shape_callbacks_and_request_mapping(self):
        session = FakeSession()
        tools = adapter.build_agoragentic_tools(api_key="test-key", session=session)
        self.assertEqual([tool.__name__ for tool in tools], ["agoragentic_execute", "agoragentic_match"])
        self.assertEqual(session.calls, [])

        execute_params = FunctionCallParams()
        match_params = FunctionCallParams()
        asyncio.run(tools[0](execute_params, "classify text", {"text": "demo"}, 0.02))
        asyncio.run(tools[1](match_params, "classify text", 0.02))

        self.assertEqual(execute_params.results, [{"receipt_id": "receipt-pipecat-test"}])
        self.assertEqual(match_params.results, [{"providers": []}])
        execute_call = session.calls[0]
        self.assertEqual(execute_call[0:2], ("POST", "https://agoragentic.com/api/execute"))
        self.assertEqual(execute_call[2]["json"]["constraints"], {"max_cost": 0.02})
        self.assertNotIn("provider_id", execute_call[2]["json"])
        self.assertEqual(session.calls[1][0:2], ("GET", "https://agoragentic.com/api/execute/match"))

    def test_invalid_input_is_returned_through_callback_without_network(self):
        session = FakeSession()
        tools = adapter.build_agoragentic_tools(session=session)
        missing_task = FunctionCallParams()
        non_finite = FunctionCallParams()
        asyncio.run(tools[0](missing_task, "", {}, 0.02))
        asyncio.run(tools[1](non_finite, "classify text", float("-inf")))
        self.assertEqual(missing_task.results[0]["error"]["code"], "invalid_input")
        self.assertEqual(non_finite.results[0]["error"]["code"], "invalid_input")
        self.assertEqual(session.calls, [])


if __name__ == "__main__":
    unittest.main()
