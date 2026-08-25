"""Prime Verifiers v0.3.0 multi-turn environment for Tumbler buyer policies."""

from __future__ import annotations

import json
from typing import Any, Literal

from . import verifiers_adapter as prime_adapter
from .tumbler import (
    TumblerContractError,
    TumblerEpisode,
    load_tumbler_scenario_pack,
)
from .tumbler_trace import attach_evaluator_episode, episode_record_from_trace

PRIME_VERIFIERS_AVAILABLE = prime_adapter.PRIME_VERIFIERS_AVAILABLE
PRIME_VERIFIERS_VERSION = prime_adapter.PRIME_VERIFIERS_VERSION
PRIME_VERIFIERS_RELEASE_COMMIT = prime_adapter.PRIME_VERIFIERS_RELEASE_COMMIT
PRIME_VERIFIERS_RELEASE_URL = prime_adapter.PRIME_VERIFIERS_RELEASE_URL
PRIME_VERIFIERS_WHEEL_SHA256 = prime_adapter.PRIME_VERIFIERS_WHEEL_SHA256
vf: Any = prime_adapter.vf
_PACK = load_tumbler_scenario_pack()
_ACTION_CONTRACT = (
    "You are the buyer policy inside Agoragentic Tumbler, a simulated tUSDC "
    "marketplace. Reply to every observation with only one JSON object containing "
    'exactly {"action":"inspect_wallet|browse|request_quote|execute_quote|'
    'inspect_transactions|complete|reject_quote|escalate_review",'
    '"reason_code":null|"lowercase_reason","input":{}}. '
    "Never provide URLs, headers, credentials, quote IDs, receipts, payment proofs, "
    "or claims about evaluator state. The environment owns those facts."
)
_ZERO_REWARD = {
    "total": 0.0,
    "decision": 0.0,
    "outcome": 0.0,
    "budget": 0.0,
    "evidence": 0.0,
    "simulation_boundary": 0.0,
    "efficiency": 0.0,
    "passed": False,
    "failures": ["invalid_evaluator_episode"],
}


def _reward_from_trace(trace: Any, task_data: Any) -> dict[str, Any]:
    try:
        record = episode_record_from_trace(
            trace,
            expected_scenario_id=task_data.scenario_id,
            expected_pack_version=task_data.scenario_pack_version,
            expected_pack_sha256=task_data.scenario_pack_sha256,
        )
    except TumblerContractError:
        return dict(_ZERO_REWARD)
    reward = record.get("reward")
    return dict(reward) if isinstance(reward, dict) else dict(_ZERO_REWARD)


if PRIME_VERIFIERS_AVAILABLE:

    class TumblerBuyerData(vf.TaskData):
        scenario_id: str
        title: str
        tags: list[str]
        scenario_pack_version: str
        scenario_pack_sha256: str
        real_spend_allowed: Literal[False] = False
        production_tumbler_allowed: Literal[False] = False

    class TumblerBuyerTask(vf.Task[TumblerBuyerData]):
        def _reward(self, trace: vf.Trace) -> dict[str, Any]:
            return _reward_from_trace(trace, self.data)

        @vf.reward(weight=1.0)
        async def contract_score(self, trace: vf.Trace) -> float:
            return float(self._reward(trace)["total"])

        @vf.metric
        async def decision_score(self, trace: vf.Trace) -> float:
            return float(self._reward(trace)["decision"])

        @vf.metric
        async def outcome_score(self, trace: vf.Trace) -> float:
            return float(self._reward(trace)["outcome"])

        @vf.metric
        async def budget_score(self, trace: vf.Trace) -> float:
            return float(self._reward(trace)["budget"])

        @vf.metric
        async def evidence_score(self, trace: vf.Trace) -> float:
            return float(self._reward(trace)["evidence"])

        @vf.metric
        async def simulation_boundary_score(self, trace: vf.Trace) -> float:
            return float(self._reward(trace)["simulation_boundary"])

        @vf.metric
        async def efficiency_score(self, trace: vf.Trace) -> float:
            return float(self._reward(trace)["efficiency"])

    class TumblerBuyerTaskset(vf.Taskset[TumblerBuyerTask, vf.TasksetConfig]):
        def load(self) -> list[TumblerBuyerTask]:
            tasks: list[TumblerBuyerTask] = []
            for idx, scenario in enumerate(_PACK.scenarios):
                data = TumblerBuyerData(
                    idx=idx,
                    name=scenario.title,
                    description=scenario.prompt,
                    prompt=None,
                    system_prompt=_ACTION_CONTRACT,
                    network_allow=[],
                    network_block=["*"],
                    scenario_id=scenario.scenario_id,
                    title=scenario.title,
                    tags=list(scenario.tags),
                    scenario_pack_version=_PACK.version,
                    scenario_pack_sha256=_PACK.sha256,
                    real_spend_allowed=False,
                    production_tumbler_allowed=False,
                )
                tasks.append(TumblerBuyerTask(data, self.config.task))
            return tasks

    class TumblerBuyerEnvConfig(vf.EnvConfig):
        buyer: vf.AgentConfig = vf.AgentConfig(max_turns=12)

    class TumblerBuyerEnv(vf.Env[TumblerBuyerEnvConfig]):
        async def run(self, task: TumblerBuyerTask, agents: vf.Agents) -> None:
            scenario = _PACK.scenario(task.data.scenario_id)
            episode = TumblerEpisode(
                scenario,
                scenario_pack_version=task.data.scenario_pack_version,
                scenario_pack_sha256=task.data.scenario_pack_sha256,
            )
            buyer_task = type(task)(
                task.data.model_copy(update={"prompt": None}),
                task.config,
            )
            async with agents.buyer.interaction(buyer_task) as buyer:
                segment = await buyer.turn(
                    json.dumps(episode.reset_observation(), sort_keys=True)
                )
                while not segment.terminated and not episode.terminal:
                    try:
                        observation = episode.step(segment.last_reply)
                    except TumblerContractError as exc:
                        episode.hard_failures.append("action_not_allowed")
                        buyer.trace.info["agoragentic_tumbler_action_error"] = exc.code
                        break
                    if episode.terminal:
                        break
                    segment = await buyer.turn(json.dumps(observation, sort_keys=True))
                if segment.terminated and not episode.terminal:
                    episode.hard_failures.append("max_steps_exceeded")
                attach_evaluator_episode(buyer.trace, episode.episode_record())

        async def finalize(self, task: TumblerBuyerTask, episode: vf.Episode) -> None:
            buyer_traces = [
                trace for trace in episode.traces if trace.agent.name == "buyer"
            ]
            if len(buyer_traces) != 1:
                raise ValueError(
                    "Tumbler buyer episode must contain exactly one buyer trace"
                )
            episode_record_from_trace(
                buyer_traces[0],
                expected_scenario_id=task.data.scenario_id,
                expected_pack_version=task.data.scenario_pack_version,
                expected_pack_sha256=task.data.scenario_pack_sha256,
            )

    __all__ = [
        "PRIME_VERIFIERS_AVAILABLE",
        "PRIME_VERIFIERS_RELEASE_COMMIT",
        "PRIME_VERIFIERS_RELEASE_URL",
        "PRIME_VERIFIERS_VERSION",
        "PRIME_VERIFIERS_WHEEL_SHA256",
        "TumblerBuyerData",
        "TumblerBuyerEnv",
        "TumblerBuyerEnvConfig",
        "TumblerBuyerTask",
        "TumblerBuyerTaskset",
    ]
else:

    class _PrimeUnavailable:
        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            raise RuntimeError(
                "Prime Verifiers Tumbler adapter unavailable. Install this package's "
                "'prime' extra from the exact pinned v0.3.0 release on Linux or macOS "
                "with Python 3.11-3.13."
            )

    TumblerBuyerTaskset = _PrimeUnavailable
    TumblerBuyerEnvConfig = _PrimeUnavailable
    TumblerBuyerEnv = _PrimeUnavailable
    __all__ = [
        "PRIME_VERIFIERS_AVAILABLE",
        "PRIME_VERIFIERS_RELEASE_COMMIT",
        "PRIME_VERIFIERS_RELEASE_URL",
        "PRIME_VERIFIERS_VERSION",
        "PRIME_VERIFIERS_WHEEL_SHA256",
        "TumblerBuyerEnv",
        "TumblerBuyerEnvConfig",
        "TumblerBuyerTaskset",
    ]
