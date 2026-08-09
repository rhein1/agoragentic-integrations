from __future__ import annotations

import asyncio
import json
import unittest
from importlib.metadata import PackageNotFoundError, distribution, version
from pathlib import Path
from types import SimpleNamespace

from agoragentic_transaction_assurance_env import (
    PRIME_VERIFIERS_AVAILABLE,
    PRIME_VERIFIERS_RELEASE_COMMIT,
    PRIME_VERIFIERS_RELEASE_URL,
    PRIME_VERIFIERS_VERSION,
    PRIME_VERIFIERS_WHEEL_SHA256,
    TRACE_OBSERVATION_KEY,
    TransactionAssuranceTaskset,
)
from agoragentic_transaction_assurance_env.verifiers_adapter import (
    _provenance_error,
    _runtime_error,
)

try:
    _installed_version = version("verifiers")
    if _installed_version != PRIME_VERIFIERS_VERSION:
        raise ImportError("wrong verifiers distribution")
    import verifiers.v1 as vf
except (ImportError, PackageNotFoundError):
    vf = None

ROOT = Path(__file__).resolve().parents[1]
ATTESTATIONS = ROOT / "tests" / "fixtures" / "attested-observations-v1.json"


class ProvenanceContractTests(unittest.TestCase):
    @staticmethod
    def _installed(record):
        return SimpleNamespace(read_text=lambda _name: record)

    def test_exact_release_record_is_accepted(self):
        record = json.dumps(
            {
                "url": PRIME_VERIFIERS_RELEASE_URL,
                "archive_info": {"hashes": {"sha256": PRIME_VERIFIERS_WHEEL_SHA256}},
            }
        )
        self.assertIsNone(_provenance_error(self._installed(record)))

    def test_missing_or_malformed_release_record_is_rejected(self):
        for record in (None, "not-json", "[]", "{}"):
            with self.subTest(record=record):
                self.assertIsNotNone(_provenance_error(self._installed(record)))

    def test_wrong_release_source_or_digest_is_rejected(self):
        records = (
            {
                "url": "https://example.invalid/verifiers-0.3.0.whl",
                "archive_info": {"hashes": {"sha256": PRIME_VERIFIERS_WHEEL_SHA256}},
            },
            {
                "url": PRIME_VERIFIERS_RELEASE_URL,
                "archive_info": {"hashes": {"sha256": "0" * 64}},
            },
        )
        for record in records:
            with self.subTest(record=record):
                self.assertIsNotNone(
                    _provenance_error(self._installed(json.dumps(record)))
                )

    def test_adapter_runtime_is_bounded_to_upstream_support(self):
        self.assertIsNone(_runtime_error("linux", (3, 11)))
        self.assertIsNone(_runtime_error("darwin", (3, 13)))
        self.assertIn("Python 3.11-3.13", _runtime_error("linux", (3, 14)))
        self.assertIn("POSIX-only fcntl", _runtime_error("win32", (3, 13)))


@unittest.skipUnless(
    vf is not None and PRIME_VERIFIERS_AVAILABLE,
    "exact Prime Verifiers v0.3.0 is not available on this platform",
)
class AdapterContractTests(unittest.TestCase):
    def setUp(self):
        fixture = json.loads(ATTESTATIONS.read_text(encoding="utf-8"))
        self.envelopes = {item["scenario_id"]: item for item in fixture["observations"]}
        self.taskset = TransactionAssuranceTaskset(vf.TasksetConfig())
        self.tasks = list(self.taskset.load())

    @staticmethod
    def _agent_response(envelope):
        observation = envelope["observation"]
        return {
            "decision": observation["decision"],
            "signals": observation["signals"],
            "next_safe_actions": observation["next_safe_actions"],
        }

    def _trace(self, task, response, *, info=None):
        return vf.Trace(
            task=vf.TraceTask(type=type(task).__name__, data=task.data),
            agent=vf.AgentInfo(config=vf.AgentConfig()),
            info=info or {},
            nodes=[
                vf.MessageNode(
                    parent=None,
                    message=vf.AssistantMessage(content=json.dumps(response)),
                    sampled=True,
                )
            ],
        )

    def test_exact_official_release_identity(self):
        installed = distribution("verifiers")
        self.assertEqual(installed.version, "0.3.0")
        self.assertEqual(
            PRIME_VERIFIERS_RELEASE_COMMIT,
            "0a4d872f021022310a08ec213a25f4efb4a0244a",
        )
        self.assertEqual(
            PRIME_VERIFIERS_RELEASE_URL,
            "https://github.com/PrimeIntellect-ai/verifiers/releases/download/"
            "v0.3.0/verifiers-0.3.0-py3-none-any.whl",
        )
        self.assertEqual(
            PRIME_VERIFIERS_WHEEL_SHA256,
            "b4c734c962a48afc1f9e836f20c04b1790b168ec8d47dbbefe45d175ecc58569",
        )
        provenance = json.loads(installed.read_text("direct_url.json"))
        self.assertEqual(provenance["url"], PRIME_VERIFIERS_RELEASE_URL)
        self.assertEqual(
            provenance["archive_info"]["hashes"]["sha256"],
            PRIME_VERIFIERS_WHEEL_SHA256,
        )
        self.assertEqual(vf.Taskset.__module__, "verifiers.v1.taskset")

    def test_native_taskset_loads_bounded_tasks_without_gold_labels(self):
        self.assertEqual(len(self.tasks), 8)
        for index, task in enumerate(self.tasks):
            with self.subTest(index=index):
                self.assertEqual(task.data.idx, index)
                self.assertTrue(task.data.prompt)
                self.assertEqual(task.data.network_allow, [])
                self.assertEqual(task.data.network_block, ["*"])
                self.assertFalse(task.data.real_spend_allowed)
                self.assertFalse(task.data.external_authority_granted)
                self.assertFalse(hasattr(task.data, "expected_decision"))
                self.assertFalse(hasattr(task.data, "required_signals"))
                self.assertEqual(type(task).toolsets(task.config), [])
        self.assertEqual(type(self.taskset).toolsets(self.taskset.config), [])

    def test_native_finalize_derives_observation_and_rejects_prefilled_info(self):
        task = next(
            item
            for item in self.tasks
            if item.data.scenario_id == "ambiguous-paid-timeout"
        )
        trace = self._trace(
            task,
            self._agent_response(self.envelopes[task.data.scenario_id]),
        )
        asyncio.run(task.finalize(trace, SimpleNamespace()))
        self.assertIn(TRACE_OBSERVATION_KEY, trace.info)
        self.assertEqual(asyncio.run(task.contract_score(trace)), 1.0)

        prefilled = self._trace(
            task,
            self._agent_response(self.envelopes[task.data.scenario_id]),
            info={TRACE_OBSERVATION_KEY: self.envelopes[task.data.scenario_id]},
        )
        self.assertEqual(asyncio.run(task.contract_score(prefilled)), 0.0)
        self.assertEqual(asyncio.run(task.privacy_preserved(prefilled)), 0.0)
        self.assertEqual(
            asyncio.run(task.authority_boundary_preserved(prefilled)),
            0.0,
        )

    def test_upstream_decorators_are_discoverable(self):
        task_type = type(self.tasks[0])
        self.assertTrue(getattr(task_type.contract_score, "reward", False))
        self.assertEqual(getattr(task_type.contract_score, "_vf_weight", None), 1.0)
        self.assertTrue(getattr(task_type.decision_match, "metric", False))

    def test_upstream_finalize_then_score_pipeline_covers_every_scenario(self):
        for task in self.tasks:
            with self.subTest(scenario=task.data.scenario_id):
                response = self._agent_response(self.envelopes[task.data.scenario_id])
                trace = self._trace(task, response)
                asyncio.run(task.finalize(trace, SimpleNamespace()))
                asyncio.run(task.score(trace))
                self.assertEqual(trace.rewards["contract_score"].score, 1.0)
                self.assertEqual(trace.rewards["contract_score"].weight, 1.0)
                self.assertEqual(trace.metrics["diagnostic_score"], 1.0)
                self.assertEqual(trace.metrics["network_boundary_preserved"], 1.0)
                self.assertEqual(trace.metrics["no_real_spend"], 1.0)


if __name__ == "__main__":
    unittest.main()
