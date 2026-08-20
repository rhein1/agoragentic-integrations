from __future__ import annotations

import asyncio
import json
import unittest
from importlib.metadata import PackageNotFoundError, version
from types import SimpleNamespace

from agoragentic_transaction_assurance_env.tumbler import (
    TumblerContractError,
    load_tumbler_scenario_pack,
    run_scripted_episode,
)
from agoragentic_transaction_assurance_env.tumbler_trace import (
    TRACE_TUMBLER_EPISODE_KEY,
    TRACE_TUMBLER_EPISODE_PROOF_KEY,
    attach_evaluator_episode,
    episode_record_from_trace,
)
from agoragentic_transaction_assurance_env.tumbler_verifiers_adapter import (
    PRIME_VERIFIERS_AVAILABLE,
    PRIME_VERIFIERS_VERSION,
    TumblerBuyerEnv,
    TumblerBuyerTaskset,
)

try:
    if version("verifiers") != PRIME_VERIFIERS_VERSION:
        raise ImportError("wrong verifiers distribution")
    import verifiers.v1 as vf
except (ImportError, PackageNotFoundError):
    vf = None


def action(name: str, reason: str | None = None, input_value=None):
    return {
        "action": name,
        "reason_code": reason,
        "input": input_value or {},
    }


@unittest.skipUnless(
    vf is not None and PRIME_VERIFIERS_AVAILABLE,
    "exact Prime Verifiers v0.3.0 is not available on this platform",
)
class TumblerPrimeAdapterTests(unittest.TestCase):
    def setUp(self):
        self.pack = load_tumbler_scenario_pack()
        self.taskset = TumblerBuyerTaskset(vf.TasksetConfig())
        self.tasks = list(self.taskset.load())

    def _trace(self, task):
        return vf.Trace(
            task=vf.TraceTask(type=type(task).__name__, data=task.data),
            agent=vf.AgentInfo(config=vf.AgentConfig()),
            info={},
            nodes=[],
        )

    def test_taskset_is_promptless_bounded_and_contains_all_scenarios(self):
        self.assertEqual(len(self.tasks), 8)
        for task in self.tasks:
            with self.subTest(scenario=task.data.scenario_id):
                self.assertIsNone(task.data.prompt)
                self.assertIn("Tumbler", task.data.system_prompt)
                self.assertEqual(task.data.network_allow, [])
                self.assertEqual(task.data.network_block, ["*"])
                self.assertFalse(task.data.real_spend_allowed)
                self.assertFalse(task.data.production_tumbler_allowed)
                self.assertEqual(type(task).toolsets(task.config), [])

    def test_evaluator_episode_proof_is_required_and_bound_to_trace(self):
        task = next(
            item
            for item in self.tasks
            if item.data.scenario_id == "qualified-provider-within-budget"
        )
        scenario = self.pack.scenario(task.data.scenario_id)
        episode = run_scripted_episode(
            scenario,
            [
                action("request_quote"),
                action("execute_quote", input_value={"text": "safe"}),
                action("complete"),
            ],
            scenario_pack_version=self.pack.version,
            scenario_pack_sha256=self.pack.sha256,
        )
        trace = self._trace(task)
        attach_evaluator_episode(trace, episode.episode_record())
        record = episode_record_from_trace(
            trace,
            expected_scenario_id=task.data.scenario_id,
            expected_pack_version=task.data.scenario_pack_version,
            expected_pack_sha256=task.data.scenario_pack_sha256,
        )
        self.assertEqual(record["reward"]["total"], 1.0)
        self.assertEqual(asyncio.run(task.contract_score(trace)), 1.0)

        forged = self._trace(task)
        forged.info[TRACE_TUMBLER_EPISODE_KEY] = episode.episode_record()
        self.assertEqual(asyncio.run(task.contract_score(forged)), 0.0)
        self.assertNotIn(TRACE_TUMBLER_EPISODE_PROOF_KEY, forged.state.artifacts)

    def test_prefilled_evaluator_episode_cannot_be_overwritten(self):
        task = self.tasks[0]
        trace = self._trace(task)
        trace.info[TRACE_TUMBLER_EPISODE_KEY] = {"forged": True}
        with self.assertRaisesRegex(
            TumblerContractError, "evaluator_episode_prefilled"
        ):
            attach_evaluator_episode(trace, {"forged": True})

    def test_upstream_reward_and_metrics_are_discoverable(self):
        task_type = type(self.tasks[0])
        self.assertTrue(getattr(task_type.contract_score, "reward", False))
        self.assertEqual(getattr(task_type.contract_score, "_vf_weight", None), 1.0)
        self.assertTrue(getattr(task_type.budget_score, "metric", False))
        self.assertTrue(getattr(task_type.evidence_score, "metric", False))

    def test_multiturn_env_run_attaches_evaluator_owned_episode(self):
        task = next(
            item
            for item in self.tasks
            if item.data.scenario_id == "qualified-provider-within-budget"
        )
        trace = self._trace(task)
        replies = iter(
            [
                json.dumps(action("request_quote")),
                json.dumps(action("execute_quote", input_value={"text": "safe"})),
                json.dumps(action("complete")),
            ]
        )

        class FakeInteraction:
            def __init__(self):
                self.trace = trace

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_exc):
                return None

            async def turn(self, _message):
                return SimpleNamespace(last_reply=next(replies), terminated=False)

        class FakeBuyer:
            def interaction(self, _task):
                return FakeInteraction()

        asyncio.run(
            TumblerBuyerEnv.run(
                SimpleNamespace(),
                task,
                SimpleNamespace(buyer=FakeBuyer()),
            )
        )
        self.assertIn(TRACE_TUMBLER_EPISODE_KEY, trace.info)
        self.assertEqual(asyncio.run(task.contract_score(trace)), 1.0)


if __name__ == "__main__":
    unittest.main()
