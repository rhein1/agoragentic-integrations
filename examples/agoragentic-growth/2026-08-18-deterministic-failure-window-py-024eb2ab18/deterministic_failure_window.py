#!/usr/bin/env python3
"""Offline, deterministic classification of repeated availability failures."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from typing import Iterable, List, Sequence, Tuple


HEALTHY = "healthy"
DEGRADED = "degraded"
WINDOW_OPEN = "window_open"
RECOVERING = "recovering"

_FAILURE_LIMIT = 3
_RECOVERY_LIMIT = 2


@dataclass(frozen=True)
class Sample:
    index: int
    status: int
    available: bool


@dataclass(frozen=True)
class Transition:
    index: int
    before: str
    after: str
    status: int
    reason: str


def _status_number(value: object) -> int:
    """Convert one caller-provided status value into a bounded integer."""
    if isinstance(value, bool):
        raise ValueError("boolean status values are not accepted")
    if isinstance(value, int):
        status = value
    elif isinstance(value, str) and value.strip().isdigit():
        status = int(value.strip())
    else:
        raise ValueError("status values must be integer-like")
    if not 100 <= status <= 599:
        raise ValueError("status values must be between 100 and 599")
    return status


def _is_available(status: int) -> bool:
    """Treat successful and redirection responses as available."""
    return 200 <= status < 400


def normalize_samples(values: Iterable[object]) -> List[Sample]:
    """Normalize caller input while retaining its original order."""
    samples: List[Sample] = []
    for index, value in enumerate(values, start=1):
        status = _status_number(value)
        samples.append(Sample(index, status, _is_available(status)))
    return samples


def transition_samples(samples: Sequence[Sample]) -> Tuple[str, List[Transition]]:
    """Apply explicit sequential state transitions to status samples."""
    state = HEALTHY
    failures = 0
    recoveries = 0
    transitions: List[Transition] = []

    for sample in samples:
        before = state
        if sample.available:
            failures = 0
            if state == WINDOW_OPEN:
                recoveries += 1
                if recoveries >= _RECOVERY_LIMIT:
                    state = HEALTHY
                    recoveries = 0
                    reason = "recovery_limit_reached"
                else:
                    state = RECOVERING
                    reason = "available_during_open_window"
            elif state == RECOVERING:
                recoveries += 1
                if recoveries >= _RECOVERY_LIMIT:
                    state = HEALTHY
                    recoveries = 0
                    reason = "recovery_limit_reached"
                else:
                    reason = "recovery_in_progress"
            elif state == DEGRADED:
                state = HEALTHY
                recoveries = 0
                reason = "available_after_failure"
            else:
                recoveries = 0
                reason = "available"
        else:
            failures += 1
            recoveries = 0
            if state == HEALTHY and failures >= _FAILURE_LIMIT:
                state = WINDOW_OPEN
                reason = "failure_limit_reached"
            elif state == DEGRADED and failures >= _FAILURE_LIMIT:
                state = WINDOW_OPEN
                reason = "failure_limit_reached"
            elif state == RECOVERING:
                state = WINDOW_OPEN
                reason = "failure_during_recovery"
            elif state == WINDOW_OPEN:
                reason = "failure_while_window_open"
            else:
                state = DEGRADED
                reason = "availability_failure"

        transitions.append(
            Transition(sample.index, before, state, sample.status, reason)
        )

    return state, transitions


def render(samples: Sequence[Sample], final_state: str,
           transitions: Sequence[Transition]) -> str:
    """Render stable, line-oriented text for local inspection."""
    lines = [
        "AGOS_FAILURE_WINDOW",
        f"samples={len(samples)}",
        f"final_state={final_state}",
    ]
    for transition in transitions:
        lines.append(
            "step={index} status={status} from={before} to={after} "
            "reason={reason}".format(
                index=transition.index,
                status=transition.status,
                before=transition.before,
                after=transition.after,
                reason=transition.reason,
            )
        )
    return "\n".join(lines)


def parse_values(arguments: argparse.Namespace) -> List[object]:
    """Read statuses from JSON or positional command-line values."""
    if arguments.json is not None and arguments.values:
        raise ValueError("use either --json or positional statuses")
    if arguments.json is not None:
        decoded = json.loads(arguments.json)
        if not isinstance(decoded, list):
            raise ValueError("--json must contain a list")
        return decoded
    return list(arguments.values)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Classify sequential availability status samples offline."
    )
    parser.add_argument(
        "--json",
        help="JSON list of status values, for example '[200, 503, 503]'.",
    )
    parser.add_argument(
        "values",
        nargs="*",
        help="status values supplied in sequence.",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="run deterministic local assertions.",
    )
    return parser


def self_test() -> None:
    """Verify transition boundaries and stable rendering."""
    samples = normalize_samples([200, 503, 503, 503, 200, 200])
    final_state, transitions = transition_samples(samples)
    assert final_state == HEALTHY
    assert [item.after for item in transitions] == [
        HEALTHY,
        DEGRADED,
        DEGRADED,
        WINDOW_OPEN,
        RECOVERING,
        HEALTHY,
    ]
    assert transitions[3].reason == "failure_limit_reached"
    assert transitions[5].reason == "recovery_limit_reached"

    final_state, transitions = transition_samples(normalize_samples([500, 503, 504]))
    assert final_state == WINDOW_OPEN
    assert transitions[-1].reason == "failure_limit_reached"

    final_state, transitions = transition_samples(normalize_samples([200, 200]))
    assert final_state == HEALTHY
    assert all(item.before == HEALTHY for item in transitions)

    rendered = render(
        normalize_samples([200, 500, 500, 500]),
        *transition_samples(normalize_samples([200, 500, 500, 500])),
    )
    assert rendered.splitlines()[0] == "AGOS_FAILURE_WINDOW"
    assert "step=4 status=500 from=degraded to=window_open" in rendered


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    if arguments.self_test:
        self_test()
        print("AGOS_RUNTIME_OK")
        return 0
    values = parse_values(arguments)
    if not values:
        parser.error("provide statuses or use --self-test")
    samples = normalize_samples(values)
    final_state, transitions = transition_samples(samples)
    print(render(samples, final_state, transitions))
    return 0


if __name__ == "__main__":
    sys.exit(main())
