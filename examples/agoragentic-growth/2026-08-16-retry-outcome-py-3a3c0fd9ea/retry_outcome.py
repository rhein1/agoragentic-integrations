"""Deterministic retry outcome normalization and bounded scheduling utility."""

from dataclasses import dataclass
from enum import Enum
import math
import sys
import time
from typing import Any, Callable, List, Optional, Sequence, Tuple


class RetryState(str, Enum):
    SUCCESS = "success"
    RETRYABLE = "retryable"
    TERMINAL = "terminal"
    EXHAUSTED = "exhausted"


@dataclass(frozen=True)
class AttemptResult:
    succeeded: bool
    retryable: bool = False
    reason: str = ""
    value: Any = None

    def __post_init__(self) -> None:
        if self.succeeded and self.retryable:
            raise ValueError("a successful result cannot be retryable")


@dataclass(frozen=True)
class RetryOutcome:
    state: RetryState
    attempt: int
    reason: str = ""
    value: Any = None
    next_delay: Optional[float] = None

    @property
    def terminal(self) -> bool:
        return self.state in (RetryState.SUCCESS, RetryState.TERMINAL,
                              RetryState.EXHAUSTED)

    @property
    def retry(self) -> bool:
        return self.state == RetryState.RETRYABLE


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 3
    base_delay: float = 0.25
    max_delay: float = 8.0
    multiplier: float = 2.0

    def __post_init__(self) -> None:
        if self.max_attempts < 1:
            raise ValueError("max_attempts must be at least one")
        if not math.isfinite(self.base_delay) or self.base_delay < 0:
            raise ValueError("base_delay must be finite and non-negative")
        if not math.isfinite(self.max_delay) or self.max_delay < 0:
            raise ValueError("max_delay must be finite and non-negative")
        if self.max_delay < self.base_delay:
            raise ValueError("max_delay must not be below base_delay")
        if not math.isfinite(self.multiplier) or self.multiplier < 1:
            raise ValueError("multiplier must be finite and at least one")


def normalize_result(result: AttemptResult, attempt: int) -> RetryOutcome:
    """Convert one explicit attempt result into a stable retry outcome."""
    if attempt < 1:
        raise ValueError("attempt numbers start at one")
    if not isinstance(result, AttemptResult):
        raise TypeError("result must be an AttemptResult")
    if result.succeeded:
        return RetryOutcome(RetryState.SUCCESS, attempt, result.reason, result.value)
    if result.retryable:
        return RetryOutcome(RetryState.RETRYABLE, attempt, result.reason, result.value)
    return RetryOutcome(RetryState.TERMINAL, attempt, result.reason, result.value)


def bounded_delay(attempt: int, policy: RetryPolicy) -> float:
    """Return the delay following a failed attempt, rounded deterministically."""
    if attempt < 1:
        raise ValueError("attempt numbers start at one")
    exponent = attempt - 1
    raw = policy.base_delay * (policy.multiplier ** exponent)
    bounded = min(policy.max_delay, raw)
    return round(bounded, 9)


def with_schedule(outcome: RetryOutcome, policy: RetryPolicy) -> RetryOutcome:
    """Attach a delay only when another retry is still permitted."""
    if outcome.state != RetryState.RETRYABLE:
        return outcome
    if outcome.attempt >= policy.max_attempts:
        return RetryOutcome(
            RetryState.EXHAUSTED,
            outcome.attempt,
            outcome.reason or "retry limit reached",
            outcome.value,
        )
    return RetryOutcome(
        outcome.state,
        outcome.attempt,
        outcome.reason,
        outcome.value,
        bounded_delay(outcome.attempt, policy),
    )


def execute_with_retry(
    operation: Callable[[int], AttemptResult],
    policy: RetryPolicy = RetryPolicy(),
    sleeper: Callable[[float], None] = time.sleep,
) -> RetryOutcome:
    """Run an operation with bounded attempts and deterministic scheduling."""
    if not callable(operation):
        raise TypeError("operation must be callable")
    if not callable(sleeper):
        raise TypeError("sleeper must be callable")

    for attempt in range(1, policy.max_attempts + 1):
        result = operation(attempt)
        outcome = with_schedule(normalize_result(result, attempt), policy)
        if outcome.state != RetryState.RETRYABLE:
            return outcome
        if outcome.next_delay is not None and outcome.next_delay > 0:
            sleeper(outcome.next_delay)

    return RetryOutcome(
        RetryState.EXHAUSTED,
        policy.max_attempts,
        "retry limit reached",
    )


def _check_equal(actual: Any, expected: Any) -> None:
    if actual != expected:
        raise AssertionError("expected {!r}, got {!r}".format(expected, actual))


def _test_normalization() -> None:
    success = normalize_result(AttemptResult(True, reason="done"), 1)
    _check_equal(success.state, RetryState.SUCCESS)
    _check_equal(success.attempt, 1)

    retry = normalize_result(AttemptResult(False, True, "temporary"), 2)
    _check_equal(retry.state, RetryState.RETRYABLE)
    _check_equal(retry.reason, "temporary")

    terminal = normalize_result(AttemptResult(False, False, "invalid"), 1)
    _check_equal(terminal.state, RetryState.TERMINAL)


def _test_delay_bounds() -> None:
    policy = RetryPolicy(max_attempts=5, base_delay=0.5, max_delay=1.25)
    _check_equal(
        [bounded_delay(i, policy) for i in range(1, 5)],
        [0.5, 1.0, 1.25, 1.25],
    )
    _check_equal(with_schedule(
        RetryOutcome(RetryState.RETRYABLE, 5, "late"), policy
    ).state, RetryState.EXHAUSTED)


def _test_execution() -> None:
    calls: List[int] = []
    sleeps: List[float] = []

    def operation(attempt: int) -> AttemptResult:
        calls.append(attempt)
        if attempt < 3:
            return AttemptResult(False, True, "temporary")
        return AttemptResult(True, reason="ready", value="ok")

    outcome = execute_with_retry(
        operation,
        RetryPolicy(max_attempts=4, base_delay=0.1, max_delay=1.0),
        sleeps.append,
    )
    _check_equal(outcome.state, RetryState.SUCCESS)
    _check_equal(outcome.value, "ok")
    _check_equal(calls, [1, 2, 3])
    _check_equal(sleeps, [0.1, 0.2])


def _test_terminal_stops() -> None:
    calls: List[int] = []
    sleeps: List[float] = []

    def operation(attempt: int) -> AttemptResult:
        calls.append(attempt)
        return AttemptResult(False, False, "permanent")

    outcome = execute_with_retry(
        operation, RetryPolicy(max_attempts=5), sleeps.append
    )
    _check_equal(outcome.state, RetryState.TERMINAL)
    _check_equal(calls, [1])
    _check_equal(sleeps, [])


def _test_exhaustion() -> None:
    calls: List[int] = []

    def operation(attempt: int) -> AttemptResult:
        calls.append(attempt)
        return AttemptResult(False, True, "offline")

    outcome = execute_with_retry(
        operation,
        RetryPolicy(max_attempts=2, base_delay=0),
        lambda _: None,
    )
    _check_equal(outcome.state, RetryState.EXHAUSTED)
    _check_equal(outcome.attempt, 2)
    _check_equal(calls, [1, 2])


def _test_validation() -> None:
    invalid: Sequence[Tuple[Any, ...]] = [
        (0, 0.1, 1.0, 2.0),
        (2, -1.0, 1.0, 2.0),
        (2, 1.0, 0.5, 2.0),
        (2, 0.1, 1.0, 0.5),
    ]
    for values in invalid:
        try:
            RetryPolicy(*values)
        except ValueError:
            continue
        raise AssertionError("invalid policy was accepted")


def self_test() -> None:
    tests = (
        _test_normalization,
        _test_delay_bounds,
        _test_execution,
        _test_terminal_stops,
        _test_exhaustion,
        _test_validation,
    )
    for test in tests:
        test()
    print("AGOS_RUNTIME_OK")


def main(argv: Sequence[str]) -> int:
    if len(argv) == 2 and argv[1] == "--self-test":
        self_test()
        return 0
    print("usage: {} --self-test".format(argv[0]))
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
