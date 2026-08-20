"""Offline deterministic recovery example for temporary unavailability.

This module models a bounded retry loop without performing I/O. A caller
provides a deterministic sequence of outcomes, while the policy records
transitions and planned delays for inspection or focused tests.
"""

from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple
import argparse
import sys


AVAILABLE = "available"
TEMPORARILY_UNAVAILABLE = "temporarily_unavailable"
PERMANENT_FAILURE = "permanent_failure"
EXHAUSTED = "exhausted"

_ALLOWED_OUTCOMES = {
    AVAILABLE,
    TEMPORARILY_UNAVAILABLE,
    PERMANENT_FAILURE,
}


@dataclass(frozen=True)
class RecoveryPolicy:
    """Bounded policy with deterministic, exponentially increasing delays."""

    max_attempts: int = 3
    initial_delay: int = 1
    delay_cap: int = 8

    def __post_init__(self) -> None:
        if self.max_attempts < 1:
            raise ValueError("max_attempts must be positive")
        if self.initial_delay < 0:
            raise ValueError("initial_delay must not be negative")
        if self.delay_cap < self.initial_delay:
            raise ValueError("delay_cap must cover initial_delay")

    def delay_for(self, retry_number: int) -> int:
        """Return the delay before a one-based retry, without sleeping."""
        if retry_number < 1:
            raise ValueError("retry_number must be positive")
        return min(
            self.delay_cap,
            self.initial_delay * (2 ** (retry_number - 1)),
        )


@dataclass(frozen=True)
class Transition:
    attempt: int
    outcome: str
    next_state: str
    delay: Optional[int]


@dataclass(frozen=True)
class RecoveryResult:
    state: str
    attempts: int
    delays: Tuple[int, ...]
    transitions: Tuple[Transition, ...]

    @property
    def succeeded(self) -> bool:
        return self.state == AVAILABLE


class DeterministicSequence:
    """Small local outcome source used instead of a network or clock."""

    def __init__(self, outcomes: Sequence[str]) -> None:
        self._outcomes = tuple(outcomes)
        self._index = 0

    def next(self) -> str:
        if self._index >= len(self._outcomes):
            return TEMPORARILY_UNAVAILABLE
        outcome = self._outcomes[self._index]
        self._index += 1
        if outcome not in _ALLOWED_OUTCOMES:
            raise ValueError("unknown outcome: {!r}".format(outcome))
        return outcome


def recover(
    outcomes: Sequence[str],
    policy: RecoveryPolicy = RecoveryPolicy(),
) -> RecoveryResult:
    """Run a bounded deterministic state machine over supplied outcomes."""
    source = DeterministicSequence(outcomes)
    transitions: List[Transition] = []
    delays: List[int] = []
    state = TEMPORARILY_UNAVAILABLE

    for attempt in range(1, policy.max_attempts + 1):
        outcome = source.next()
        if outcome == AVAILABLE:
            state = AVAILABLE
            transitions.append(Transition(attempt, outcome, state, None))
            break

        if outcome == PERMANENT_FAILURE:
            state = PERMANENT_FAILURE
            transitions.append(Transition(attempt, outcome, state, None))
            break

        is_last = attempt == policy.max_attempts
        if is_last:
            state = EXHAUSTED
            transitions.append(Transition(attempt, outcome, state, None))
            break

        delay = policy.delay_for(attempt)
        delays.append(delay)
        state = TEMPORARILY_UNAVAILABLE
        transitions.append(Transition(attempt, outcome, state, delay))
    else:
        state = EXHAUSTED

    return RecoveryResult(
        state=state,
        attempts=len(transitions),
        delays=tuple(delays),
        transitions=tuple(transitions),
    )


def format_result(result: RecoveryResult) -> str:
    """Render stable human-readable diagnostics for local runs."""
    lines = [
        "state={}".format(result.state),
        "attempts={}".format(result.attempts),
        "delays={}".format(",".join(str(item) for item in result.delays) or "-"),
    ]
    for transition in result.transitions:
        lines.append(
            "attempt={} outcome={} next={} delay={}".format(
                transition.attempt,
                transition.outcome,
                transition.next_state,
                "-" if transition.delay is None else transition.delay,
            )
        )
    return "\n".join(lines)


def _assert_case(
    name: str,
    outcomes: Sequence[str],
    expected_state: str,
    expected_attempts: int,
    expected_delays: Tuple[int, ...],
    policy: RecoveryPolicy,
) -> None:
    result = recover(outcomes, policy)
    assert result.state == expected_state, "{}: state".format(name)
    assert result.attempts == expected_attempts, "{}: attempts".format(name)
    assert result.delays == expected_delays, "{}: delays".format(name)
    assert len(result.transitions) <= policy.max_attempts
    assert result.succeeded is (expected_state == AVAILABLE)


def self_test() -> None:
    policy = RecoveryPolicy(max_attempts=4, initial_delay=1, delay_cap=3)
    cases = (
        ("immediate success", (AVAILABLE,), AVAILABLE, 1, ()),
        (
            "recover after two outages",
            (TEMPORARILY_UNAVAILABLE, TEMPORARILY_UNAVAILABLE, AVAILABLE),
            AVAILABLE,
            3,
            (1, 2),
        ),
        (
            "delay cap",
            (
                TEMPORARILY_UNAVAILABLE,
                TEMPORARILY_UNAVAILABLE,
                TEMPORARILY_UNAVAILABLE,
                AVAILABLE,
            ),
            AVAILABLE,
            4,
            (1, 2, 3),
        ),
        (
            "permanent failure",
            (TEMPORARILY_UNAVAILABLE, PERMANENT_FAILURE, AVAILABLE),
            PERMANENT_FAILURE,
            2,
            (1,),
        ),
        (
            "bounded exhaustion",
            (TEMPORARILY_UNAVAILABLE,),
            EXHAUSTED,
            4,
            (1, 2, 3),
        ),
    )
    for case in cases:
        _assert_case(*case, policy=policy)

    assert policy.delay_for(1) == 1
    assert policy.delay_for(2) == 2
    assert policy.delay_for(5) == 3
    try:
        recover(("unknown",), policy)
    except ValueError:
        pass
    else:
        raise AssertionError("invalid outcomes must be rejected")
    print("AGOS_RUNTIME_OK")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run a deterministic bounded recovery example."
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="run local deterministic regression cases",
    )
    args = parser.parse_args(argv)
    if args.self_test:
        self_test()
        return 0

    result = recover(
        (
            TEMPORARILY_UNAVAILABLE,
            TEMPORARILY_UNAVAILABLE,
            AVAILABLE,
        )
    )
    print(format_result(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
