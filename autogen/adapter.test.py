import importlib.util
import inspect
import pathlib
import sys
import types
import unittest


class FakeResponse:
    status_code = 200

    @staticmethod
    def json():
        return {"providers": []}


class AdapterContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.requests = types.SimpleNamespace()
        sys.modules["requests"] = cls.requests
        source = pathlib.Path(__file__).with_name("agoragentic_autogen.py")
        spec = importlib.util.spec_from_file_location("agoragentic_autogen", source)
        cls.adapter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.adapter)

    def test_modern_tools_have_stable_names_and_signatures(self):
        tools = self.adapter.get_agoragentic_tools("amk_test")
        self.assertEqual([tool.__name__ for tool in tools], list(self.adapter.FUNCTION_MAP))
        execute = next(tool for tool in tools if tool.__name__ == "agoragentic_execute")
        self.assertEqual(list(inspect.signature(execute).parameters), ["task", "input_data", "max_cost"])

    def test_api_keys_are_isolated_per_tool_set(self):
        seen = []

        def fake_get(_url, **kwargs):
            seen.append(kwargs["headers"].get("Authorization"))
            return FakeResponse()

        self.requests.get = fake_get
        first = self.adapter.get_agoragentic_tools("amk_first")
        second = self.adapter.get_agoragentic_tools("amk_second")
        next(tool for tool in first if tool.__name__ == "agoragentic_match")("summarize")
        next(tool for tool in second if tool.__name__ == "agoragentic_match")("summarize")
        self.assertEqual(seen, ["Bearer amk_first", "Bearer amk_second"])


if __name__ == "__main__":
    unittest.main()
