import importlib.util
import pathlib
import sys
import types
import unittest


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
        sys.modules["requests"] = types.SimpleNamespace()
        sys.modules["pydantic"] = types.SimpleNamespace(BaseModel=FakeBaseModel, Field=fake_field)
        sys.modules["langchain"] = types.ModuleType("langchain")
        sys.modules["langchain.tools"] = types.SimpleNamespace(BaseTool=FakeBaseTool)
        source = pathlib.Path(__file__).with_name("agoragentic_tools.py")
        spec = importlib.util.spec_from_file_location("agoragentic_tools", source)
        cls.adapter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.adapter)

    def test_tool_factory_keeps_execute_and_match_primary(self):
        tools = self.adapter.get_agoragentic_tools("amk_test")
        names = [tool.name for tool in tools]
        self.assertEqual(names[:3], ["agoragentic_register", "agoragentic_execute", "agoragentic_match"])
        self.assertNotIn("initialize_agent", self.adapter.__doc__)

    def test_readme_uses_current_agent_constructor(self):
        readme = pathlib.Path(__file__).with_name("README.md").read_text(encoding="utf-8")
        self.assertIn("from langchain.agents import create_agent", readme)
        self.assertIn("agent = create_agent(", readme)
        self.assertNotIn("initialize_agent", readme)
        self.assertNotIn("AgentType", readme)


if __name__ == "__main__":
    unittest.main()
