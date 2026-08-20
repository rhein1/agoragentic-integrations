"""Deterministic control policies and benchmark reports for Tumbler RL tasks.

These controls are evaluator fixtures, not claims about model performance. They
make reward regressions visible before any external model or training run is
authorized.
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Callable, Mapping, Sequence
from hashlib import sha256
from pathlib import Path
from typing import Any

from .tumbler import (
    TumblerAction,
    TumblerContractError,
    TumblerEpisode,
    TumblerScenario,
    TumblerScenarioPack,
    load_tumbler_scenario_pack,
)

TUMBLER_BENCHMARK_SCHEMA = "agoragentic.tumbler-rl-benchmark.v1"
TUMBLER_BASELINE_POLICY_IDS = (
    "always_escalate_v1",
    "always_execute_v1",
    "safety_first_v1",
)
TUMBLER_BENCHMARK_AUTHORITY_BOUNDARY = {
    "external_network_allowed": False,
    "model_calls_allowed": False,
    "production_tumbler_allowed": False,
    "publication_authorized": False,
    "real_spend_allowed": False,
}

Policy = Callable[[TumblerEpisode], TumblerAction]


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _action(
    action: str,
    reason_code: str | None = None,
    input_value: Mapping[str, Any] | None = None,
) -> TumblerAction:
    return TumblerAction(
        action=action,
        reason_code=reason_code,
        input=dict(input_value or {}),
    )


def _latest_response(episode: TumblerEpisode) -> Mapping[str, Any]:
    if not episode.transitions:
        return {}
    response = episode.transitions[-1].observation.get("response")
    return response if isinstance(response, Mapping) else {}


def _selected_provider(episode: TumblerEpisode) -> Mapping[str, Any] | None:
    providers = _latest_response(episode).get("providers")
    if not isinstance(providers, list) or not providers:
        return None
    provider = providers[0]
    return provider if isinstance(provider, Mapping) else None


def safety_first_v1(episode: TumblerEpisode) -> TumblerAction:
    """A deterministic control that follows the scenario's visible safety facts."""

    if episode.last_error == "no_candidates":
        return _action("escalate_review", "no_candidates")
    if not episode.quote:
        return _action("request_quote")

    quote_price = episode.quote.get("price_tusdc")
    if (
        isinstance(quote_price, (int, float))
        and not isinstance(quote_price, bool)
        and float(quote_price) > episode.scenario.budget_tusdc
    ):
        return _action("reject_quote", "over_budget")

    provider = _selected_provider(episode)
    if provider and provider.get("sandbox_status") != "verified":
        return _action("reject_quote", "unverified_provider")

    if episode.integrity_flags:
        return _action("escalate_review", "receipt_mismatch")
    if episode.execution_status == "timeout":
        if "transactions" not in episode.evidence:
            return _action("inspect_transactions")
        return _action("escalate_review", "avoid_duplicate_payment")
    if episode.execution_status == "failed":
        return _action("escalate_review", "provider_failed")
    if episode.execution_status == "insufficient_tumbler_balance":
        return _action("escalate_review", "insufficient_balance")
    if episode.last_error == "insufficient_tumbler_balance":
        return _action("escalate_review", "insufficient_balance")
    if episode.execution_status == "success":
        return _action("complete")
    return _action("execute_quote", input_value={"task": "scenario_public_input"})


def _execute_attempt_count(episode: TumblerEpisode) -> int:
    return sum(
        1 for transition in episode.transitions if transition.action == "execute_quote"
    )


def always_execute_v1(episode: TumblerEpisode) -> TumblerAction:
    """A deliberately reckless control used to detect missing safety penalties."""

    if not episode.quote and not episode.last_error:
        return _action("request_quote")
    if episode.quote and _execute_attempt_count(episode) == 0:
        return _action("execute_quote", input_value={"task": "scenario_public_input"})
    if episode.execution_status == "timeout" and _execute_attempt_count(episode) == 1:
        return _action(
            "execute_quote", input_value={"task": "retry_without_reconciliation"}
        )
    return _action("complete")


def always_escalate_v1(_episode: TumblerEpisode) -> TumblerAction:
    """A maximally conservative control that never attempts marketplace work."""

    return _action("escalate_review", "manual_review")


BASELINE_POLICIES: dict[str, Policy] = {
    "always_escalate_v1": always_escalate_v1,
    "always_execute_v1": always_execute_v1,
    "safety_first_v1": safety_first_v1,
}


def get_baseline_policy(policy_id: str) -> Policy:
    try:
        return BASELINE_POLICIES[policy_id]
    except KeyError as exc:
        raise ValueError(f"unknown Tumbler baseline policy: {policy_id}") from exc


def run_policy_episode(
    scenario: TumblerScenario,
    policy: Policy,
    *,
    scenario_pack_version: str,
    scenario_pack_sha256: str,
) -> TumblerEpisode:
    episode = TumblerEpisode(
        scenario,
        scenario_pack_version=scenario_pack_version,
        scenario_pack_sha256=scenario_pack_sha256,
    )
    for _ in range(scenario.max_steps):
        if episode.terminal:
            break
        try:
            episode.step(policy(episode))
        except TumblerContractError as exc:
            if exc.code not in episode.hard_failures:
                episode.hard_failures.append(exc.code)
            break
    if not episode.terminal and "max_steps_exceeded" not in episode.hard_failures:
        episode.hard_failures.append("max_steps_exceeded")
    return episode


def run_baseline(
    policy_id: str,
    *,
    pack: TumblerScenarioPack | None = None,
) -> list[TumblerEpisode]:
    scenario_pack = pack or load_tumbler_scenario_pack()
    policy = get_baseline_policy(policy_id)
    return [
        run_policy_episode(
            scenario,
            policy,
            scenario_pack_version=scenario_pack.version,
            scenario_pack_sha256=scenario_pack.sha256,
        )
        for scenario in scenario_pack.scenarios
    ]


def _average(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    return round(sum(values) / len(values), 6)


def build_benchmark_report(
    policy_id: str,
    *,
    pack: TumblerScenarioPack | None = None,
) -> dict[str, Any]:
    scenario_pack = pack or load_tumbler_scenario_pack()
    episodes = run_baseline(policy_id, pack=scenario_pack)
    rows: list[dict[str, Any]] = []
    for scenario, episode in zip(scenario_pack.scenarios, episodes, strict=True):
        record = episode.episode_record()
        reward = record["reward"]
        rows.append(
            {
                "episode_sha256": record["episode_sha256"],
                "failures": list(reward["failures"]),
                "outcome_code": record["outcome_code"],
                "passed": bool(reward["passed"]),
                "reward": {
                    "budget": float(reward["budget"]),
                    "decision": float(reward["decision"]),
                    "efficiency": float(reward["efficiency"]),
                    "evidence": float(reward["evidence"]),
                    "outcome": float(reward["outcome"]),
                    "simulation_boundary": float(reward["simulation_boundary"]),
                    "total": float(reward["total"]),
                },
                "scenario_id": scenario.scenario_id,
                "step_count": len(record["transitions"]),
                "terminal_action": record["terminal_action"],
                "terminal_reason_code": record["terminal_reason_code"],
            }
        )

    totals = [row["reward"]["total"] for row in rows]
    passed_count = sum(1 for row in rows if row["passed"])
    zero_reward_count = sum(1 for total in totals if total == 0.0)
    unsigned = {
        "authority_boundary": dict(TUMBLER_BENCHMARK_AUTHORITY_BOUNDARY),
        "control_only": True,
        "disclaimer": (
            "Deterministic evaluator control; not a model, training, adoption, "
            "safety-certification, or production-performance claim."
        ),
        "policy_id": policy_id,
        "scenario_pack": {
            "scenario_count": len(scenario_pack.scenarios),
            "schema": scenario_pack.schema,
            "sha256": scenario_pack.sha256,
            "version": scenario_pack.version,
        },
        "schema": TUMBLER_BENCHMARK_SCHEMA,
        "scenarios": rows,
        "summary": {
            "average_budget_score": _average([row["reward"]["budget"] for row in rows]),
            "average_decision_score": _average(
                [row["reward"]["decision"] for row in rows]
            ),
            "average_evidence_score": _average(
                [row["reward"]["evidence"] for row in rows]
            ),
            "average_total_reward": _average(totals),
            "pass_count": passed_count,
            "pass_rate": round(passed_count / len(rows), 6) if rows else 0.0,
            "scenario_count": len(rows),
            "zero_reward_count": zero_reward_count,
        },
    }
    return {
        **unsigned,
        "benchmark_sha256": sha256(_canonical_bytes(unsigned)).hexdigest(),
    }


def write_benchmark_report(path: str | Path, report: Mapping[str, Any]) -> Path:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return destination


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run deterministic Tumbler RL benchmark controls."
    )
    parser.add_argument(
        "--policy",
        choices=sorted(BASELINE_POLICIES),
        default="safety_first_v1",
    )
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    report = build_benchmark_report(args.policy)
    if args.out:
        write_benchmark_report(args.out, report)
    else:
        print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "BASELINE_POLICIES",
    "TUMBLER_BASELINE_POLICY_IDS",
    "TUMBLER_BENCHMARK_AUTHORITY_BOUNDARY",
    "TUMBLER_BENCHMARK_SCHEMA",
    "always_escalate_v1",
    "always_execute_v1",
    "build_benchmark_report",
    "get_baseline_policy",
    "main",
    "run_baseline",
    "run_policy_episode",
    "safety_first_v1",
    "write_benchmark_report",
]
