from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from enum import Enum
from fractions import Fraction
from typing import Callable, Iterable, List, Sequence, Tuple


class WorkOutcome(Enum):
    SUCCESS = "success"
    TEMPORARY_UNAVAILABLE = "temporary_unavailable"
    FAILURE = "failure"


class RecoveryState(Enum):
    IDLE = "idle"
    RUNNING = "running"
    RECOVERED = "recovered"
    EXHAUSTED = "exhausted"
    FAILED = "failed"


@dataclass(frozen=True)
class WorkResult:
    outcome: WorkOutcome
    elapsed: Fraction = Fraction(0)
    detail: str = ""


@dataclass(frozen=True)
class AttemptRecord:
    number: int
    timeout: Fraction
    elapsed: Fraction
    outcome: WorkOutcome
    detail: str


@dataclass(frozen=True)
class RecoveryReport:
    state: RecoveryState
    attempts: Tuple[AttemptRecord, ...]
    transitions: Tuple[RecoveryState, ...]
    remaining_budget: Fraction


Worker = Callable[[int, Fraction], WorkResult]


class SequentialRecovery:
    """Offline bounded recovery wrapper for temporarily unavailable work."""

    def __init__(self, max_attempts: int, total_timeout: Fraction):
        if max_attempts < 1:
            raise ValueError("max_attempts must be positive")
        if total_timeout < 0:
            raise ValueError("total_timeout must not be negative")
        self.max_attempts = max_attempts
        self.total_timeout = Fraction(total_timeout)

    @staticmethod
    def _next_timeout(
        remaining_budget: Fraction, remaining_attempts: int
    ) -> Fraction:
        if remaining_attempts < 1:
            raise ValueError("remaining_attempts must be positive")
        # Allocate only the remaining budget. This avoids multiplying the
        # original timeout once per sequential attempt.
        return remaining_budget / remaining_attempts

    def _transition(
        self,
        current: RecoveryState,
        target: RecoveryState,
        transitions: List[RecoveryState],
    ) -> RecoveryState:
        allowed = {
            RecoveryState.IDLE: {RecoveryState.RUNNING},
            RecoveryState.RUNNING: {
                RecoveryState.RECOVERED,
                RecoveryState.EXHAUSTED,
                RecoveryState.FAILED,
            },
        }
        if target not in allowed.get(current, set()):
            raise RuntimeError(
                "invalid transition: {} -> {}".format(
                    current.value, target.value
                )
            )
        transitions.append(target)
        return target

    def run(self, worker: Worker) -> RecoveryReport:
        state = RecoveryState.IDLE
        transitions = [state]
        state = self._transition(state, RecoveryState.RUNNING, transitions)
        records: List[AttemptRecord] = []
        remaining = self.total_timeout

        for number in range(1, self.max_attempts + 1):
            timeout = self._next_timeout(
                remaining, self.max_attempts - number + 1
            )
            result = worker(number, timeout)
            elapsed = Fraction(result.elapsed)
            if elapsed < 0 or elapsed > timeout:
                raise ValueError(
                    "worker elapsed time exceeds its assigned timeout"
                )
            remaining -= elapsed
            records.append(
                AttemptRecord(
                    number=number,
                    timeout=timeout,
                    elapsed=elapsed,
                    outcome=result.outcome,
                    detail=result.detail,
                )
            )

            if result.outcome is WorkOutcome.SUCCESS:
                state = self._transition(
                    state, RecoveryState.RECOVERED, transitions
                )
                break
            if result.outcome is WorkOutcome.FAILURE:
                state = self._transition(state, RecoveryState.FAILED, transitions)
                break
            if number == self.max_attempts:
                state = self._transition(
                    state, RecoveryState.EXHAUSTED, transitions
                )

        return RecoveryReport(
            state=state,
            attempts=tuple(records),
            transitions=tuple(transitions),
            remaining_budget=remaining,
        )


class ScriptedWorker:
    """Deterministic worker used by the example and its regression tests."""

    def __init__(
        self,
        results: Sequence[WorkResult],
        observed: List[Tuple[int, Fraction]],
    ):
        self._results = tuple(results)
        self._observed = observed

    def __call__(self, number: int, timeout: Fraction) -> WorkResult:
        self._observed.append((number, timeout))
        if number > len(self._results):
            raise AssertionError("script ended before the runner stopped")
        result = self._results[number - 1]
        if result.elapsed > timeout:
            raise AssertionError("script requires more time than assigned")
        return result


def _fraction_values(values: Iterable[Fraction]) -> List[Fraction]:
    return [Fraction(value) for value in values]


def test_recovery_after_temporary_unavailability() -> None:
    observed: List[Tuple[int, Fraction]] = []
    worker = ScriptedWorker(
        [
            WorkResult(WorkOutcome.TEMPORARY_UNAVAILABLE, Fraction(1), "busy"),
            WorkResult(WorkOutcome.SUCCESS, Fraction(2), "ready"),
        ],
        observed,
    )
    report = SequentialRecovery(3, Fraction(9)).run(worker)
    assert report.state is RecoveryState.RECOVERED
    assert [item.number for item in report.attempts] == [1, 2]
    assert report.transitions == (
        RecoveryState.IDLE,
        RecoveryState.RUNNING,
        RecoveryState.RECOVERED,
    )


def test_exhaustion_is_bounded() -> None:
    observed: List[Tuple[int, Fraction]] = []
    worker = ScriptedWorker(
        [
            WorkResult(WorkOutcome.TEMPORARY_UNAVAILABLE, Fraction(1)),
            WorkResult(WorkOutcome.TEMPORARY_UNAVAILABLE, Fraction(1)),
            WorkResult(WorkOutcome.TEMPORARY_UNAVAILABLE, Fraction(1)),
        ],
        observed,
    )
    report = SequentialRecovery(3, Fraction(3)).run(worker)
    assert report.state is RecoveryState.EXHAUSTED
    assert len(report.attempts) == 3
    assert report.remaining_budget == Fraction(0)


def test_attempt_order_is_sequential() -> None:
    observed: List[Tuple[int, Fraction]] = []
    worker = ScriptedWorker(
        [WorkResult(WorkOutcome.SUCCESS, Fraction(1))],
        observed,
    )
    report = SequentialRecovery(4, Fraction(8)).run(worker)
    assert report.state is RecoveryState.RECOVERED
    assert [number for number, _ in observed] == [1]


def test_failure_does_not_retry() -> None:
    observed: List[Tuple[int, Fraction]] = []
    worker = ScriptedWorker(
        [
            WorkResult(WorkOutcome.FAILURE, Fraction(1), "permanent"),
            WorkResult(WorkOutcome.SUCCESS, Fraction(1)),
        ],
        observed,
    )
    report = SequentialRecovery(2, Fraction(4)).run(worker)
    assert report.state is RecoveryState.FAILED
    assert len(report.attempts) == 1


def test_sequential_timeout_budget_is_fair() -> None:
    observed: List[Tuple[int, Fraction]] = []
    worker = ScriptedWorker(
        [
            WorkResult(WorkOutcome.TEMPORARY_UNAVAILABLE, Fraction(2)),
            WorkResult(WorkOutcome.TEMPORARY_UNAVAILABLE, Fraction(1)),
            WorkResult(WorkOutcome.TEMPORARY_UNAVAILABLE, Fraction(3)),
        ],
        observed,
    )
    report = SequentialRecovery(3, Fraction(6)).run(worker)
    assert report.state is RecoveryState.EXHAUSTED
    assert _fraction_values(timeout for _, timeout in observed) == [
        Fraction(2),
        Fraction(2),
        Fraction(3),
    ]
    assert report.remaining_budget == Fraction(0)


def run_self_test() -> None:
    tests = (
        test_recovery_after_temporary_unavailability,
        test_exhaustion_is_bounded,
        test_attempt_order_is_sequential,
        test_failure_does_not_retry,
        test_sequential_timeout_budget_is_fair,
    )
    for test in tests:
        test()
    print("AGOS_RUNTIME_OK")


def main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Deterministic bounded temporary-unavailability recovery."
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="run deterministic regression cases",
    )
    args = parser.parse_args(argv)
    if args.self_test:
        run_self_test()
        return 0
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
