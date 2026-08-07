"""Optional Prime Verifiers v1 adapter.

The deterministic core is dependency-free. This module exposes a native
``verifiers.v1`` Taskset when that package is installed. The package remains an
unpublished alpha until an exact upstream Verifiers release is exercised.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .core import evaluate, load_scenarios, observation_from_trace

try:
    import verifiers.v1 as vf
except ImportError:  # pragma: no cover - tested through the explicit fallback
    vf = None

_SCENARIO_PATH = Path(__file__).resolve().parent / "scenarios" / "transaction-assurance-v1.json"


if vf is not None:
    class TransactionAssuranceData(vf.TaskData):
        scenario_id: str
        title: str
        expected_decision: str
        required_signals: list[str]
        forbidden_signals: list[str]
        expected_next_safe_actions: list[str]
        required_evidence: list[str]
        tags: list[str]


    class TransactionAssuranceTask(vf.Task[TransactionAssuranceData]):
        @vf.reward
        async def contract_score(self, trace: vf.Trace) -> float:
            scenario = next(
                item for item in load_scenarios(_SCENARIO_PATH)
                if item.scenario_id == self.data.scenario_id
            )
            return evaluate(scenario, observation_from_trace(trace)).total

        @vf.metric
        async def decision_match(self, trace: vf.Trace) -> float:
            scenario = next(
                item for item in load_scenarios(_SCENARIO_PATH)
                if item.scenario_id == self.data.scenario_id
            )
            return evaluate(scenario, observation_from_trace(trace)).decision

        @vf.metric
        async def privacy_preserved(self, trace: vf.Trace) -> float:
            scenario = next(
                item for item in load_scenarios(_SCENARIO_PATH)
                if item.scenario_id == self.data.scenario_id
            )
            return evaluate(scenario, observation_from_trace(trace)).privacy

        @vf.metric
        async def authority_boundary_preserved(self, trace: vf.Trace) -> float:
            scenario = next(
                item for item in load_scenarios(_SCENARIO_PATH)
                if item.scenario_id == self.data.scenario_id
            )
            return evaluate(scenario, observation_from_trace(trace)).authority_boundary


    class TransactionAssuranceTaskset(vf.Taskset[TransactionAssuranceTask, vf.TasksetConfig]):
        def load(self) -> list[TransactionAssuranceTask]:
            tasks: list[TransactionAssuranceTask] = []
            for idx, scenario in enumerate(load_scenarios(_SCENARIO_PATH)):
                data = TransactionAssuranceData(
                    idx=idx,
                    prompt=scenario.prompt,
                    scenario_id=scenario.scenario_id,
                    title=scenario.title,
                    expected_decision=scenario.expected_decision,
                    required_signals=list(scenario.required_signals),
                    forbidden_signals=list(scenario.forbidden_signals),
                    expected_next_safe_actions=list(scenario.expected_next_safe_actions),
                    required_evidence=list(scenario.required_evidence),
                    tags=list(scenario.tags),
                )
                tasks.append(TransactionAssuranceTask(data, self.config.task))
            return tasks


    __all__ = ["TransactionAssuranceTaskset"]
else:
    class TransactionAssuranceTaskset:
        """Explicit missing-dependency sentinel; not a functional Taskset."""

        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            raise RuntimeError(
                "Prime Verifiers is not installed. Install the optional 'prime' extra "
                "and validate against an exact upstream version before use."
            )


    __all__ = ["TransactionAssuranceTaskset"]
