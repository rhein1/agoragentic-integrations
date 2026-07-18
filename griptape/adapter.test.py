import functools
import importlib.util
import pathlib
import sys
import types
import unittest


class BaseTool:
    def __init__(self, **kwargs):
        self.name = kwargs.get("name", self.__class__.__name__)


def activity(*, config):
    def decorate(function):
        @functools.wraps(function)
        def wrapped(self, *, params):
            return function(self, values=params["values"])
        wrapped.activity_config = config
        return wrapped
    return decorate


class Schema:
    def __init__(self, value):
        self.value = value


class SchemaOptional:
    def __init__(self, key, default=None):
        self.key = key
        self.default = default


class Or:
    def __init__(self, *values):
        self.values = values


griptape = types.ModuleType("griptape")
griptape_tools = types.ModuleType("griptape.tools")
griptape_tools.BaseTool = BaseTool
griptape_utils = types.ModuleType("griptape.utils")
griptape_decorators = types.ModuleType("griptape.utils.decorators")
griptape_decorators.activity = activity
schema_module = types.ModuleType("schema")
schema_module.Optional = SchemaOptional
schema_module.Or = Or
schema_module.Schema = Schema
sys.modules["griptape"] = griptape
sys.modules["griptape.tools"] = griptape_tools
sys.modules["griptape.utils"] = griptape_utils
sys.modules["griptape.utils.decorators"] = griptape_decorators
sys.modules["schema"] = schema_module

spec = importlib.util.spec_from_file_location(
    "agoragentic_griptape",
    pathlib.Path(__file__).with_name("agoragentic_griptape.py"),
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
            return FakeResponse({"receipt_id": "receipt-griptape-test"})
        return FakeResponse({"providers": []})


class GriptapeAdapterTest(unittest.TestCase):
    def test_activity_shape_request_mapping_and_cost_ceiling(self):
        session = FakeSession()
        tool = adapter.AgoragenticTool(api_key="test-key", session=session)
        self.assertEqual(session.calls, [])
        self.assertTrue(hasattr(tool.agoragentic_execute, "activity_config"))
        self.assertTrue(hasattr(tool.agoragentic_match, "activity_config"))

        result = tool.agoragentic_execute(
            params={"values": {"task": "review code", "input_data": {"repo": "demo"}, "max_cost": 0.1}}
        )
        preview = tool.agoragentic_match(params={"values": {"task": "review code", "max_cost": 0.1}})

        self.assertEqual(result["receipt_id"], "receipt-griptape-test")
        self.assertEqual(preview, {"providers": []})
        execute_call = session.calls[0]
        self.assertEqual(execute_call[0:2], ("POST", "https://agoragentic.com/api/execute"))
        self.assertEqual(execute_call[2]["json"]["constraints"], {"max_cost": 0.1})
        self.assertNotIn("provider_id", execute_call[2]["json"])
        self.assertEqual(session.calls[1][0:2], ("GET", "https://agoragentic.com/api/execute/match"))

    def test_invalid_ceiling_fails_before_network(self):
        session = FakeSession()
        tool = adapter.AgoragenticTool(session=session)
        negative = tool.agoragentic_execute(params={"values": {"task": "review", "max_cost": -1}})
        non_finite = tool.agoragentic_match(params={"values": {"task": "review", "max_cost": float("nan")}})
        self.assertEqual(negative["error"]["code"], "invalid_input")
        self.assertEqual(non_finite["error"]["code"], "invalid_input")
        self.assertEqual(session.calls, [])


if __name__ == "__main__":
    unittest.main()
