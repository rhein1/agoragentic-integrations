from __future__ import annotations

import importlib
from pathlib import Path
import sys
import types
import unittest


class GenericBase:
    @classmethod
    def __class_getitem__(cls, _item):
        return cls


class FakeTaskData:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class FakeTask(GenericBase):
    def __init__(self, data, config):
        self.data = data
        self.config = config


class FakeTaskset(GenericBase):
    def __init__(self):
        self.config = types.SimpleNamespace(task=object())


class FakeTasksetConfig:
    pass


class FakeTrace:
    pass


def identity_decorator(function):
    return function


class AdapterContractTests(unittest.TestCase):
    def setUp(self):
        self.original = {name: sys.modules.get(name) for name in ("verifiers", "verifiers.v1")}
        verifiers = types.ModuleType("verifiers")
        v1 = types.ModuleType("verifiers.v1")
        v1.TaskData = FakeTaskData
        v1.Task = FakeTask
        v1.Taskset = FakeTaskset
        v1.TasksetConfig = FakeTasksetConfig
        v1.Trace = FakeTrace
        v1.reward = identity_decorator
        v1.metric = identity_decorator
        verifiers.v1 = v1
        sys.modules["verifiers"] = verifiers
        sys.modules["verifiers.v1"] = v1

    def tearDown(self):
        for name, module in self.original.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
        sys.modules.pop("agoragentic_transaction_assurance_env.verifiers_adapter", None)

    def test_native_taskset_loads_all_scenarios_under_contract_stub(self):
        module = importlib.import_module("agoragentic_transaction_assurance_env.verifiers_adapter")
        taskset = module.TransactionAssuranceTaskset()
        tasks = taskset.load()
        self.assertEqual(len(tasks), 8)
        self.assertEqual(tasks[0].data.idx, 0)
        self.assertTrue(tasks[0].data.prompt)

    def test_adapter_source_uses_native_v1_contract(self):
        path = Path(__file__).resolve().parents[1] / "src" / "agoragentic_transaction_assurance_env" / "verifiers_adapter.py"
        source = path.read_text(encoding="utf-8")
        for required in ("import verifiers.v1 as vf", "@vf.reward", "@vf.metric", "class TransactionAssuranceTaskset"):
            self.assertIn(required, source)


if __name__ == "__main__":
    unittest.main()
