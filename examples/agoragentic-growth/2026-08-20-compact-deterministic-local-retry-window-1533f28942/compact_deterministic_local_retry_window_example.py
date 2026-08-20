"""Deterministic, offline retry-window example for bounded local decisions."""

from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import Dict, Iterable, List, Tuple


RETRYABLE_SIGNALS = frozenset(
    {
        "temporary_failure",
        "busy",
        "timeout",
        "connection_reset",
    }
)

TERMINAL_SIGNALS = frozenset(
    {
        "success",
        "invalid_input",
        "permission_denied",
        "not_found",
        "cancelled",
    }
)


@dataclass(frozen=True)
class RetryWindow:
    """Limits both the number of attempts and elapsed local time."""

    max_attempts: int = 3
    window_ms: int = 1_000

    def __post_init__(self) -> None:
        if self.max_attempts < 1:
            raise ValueError("max_attempts must be positive")
        if self.window_ms < 0:
            raise ValueError("window_ms must not be negative")


@dataclass(frozen=True)
class RetryDecision:
    """The stable result of evaluating one local retry observation."""

    action: str
    bucket: str
    attempt: int
    elapsed_ms: int
    reason: str

    @property
    def should_retry(self) -> bool:
        return self.action == "retry"


def canonical_signal(signal: str) -> str:
    """Normalize hand-authored labels without depending on locale or hashing."""

    if not isinstance(signal, str):
        raise TypeError("signal must be a string")
    normalized = "_".join(signal.strip().lower().split())
    if not normalized:
        raise ValueError("signal must not be empty")
    return normalized


def stable_outcome_bucket(signal: str) -> str:
    """Map a signal to a small, versionable set of outcome buckets."""

    value = canonical_signal(signal)
    if value in RETRYABLE_SIGNALS:
        return "transient"
    if value in TERMINAL_SIGNALS:
        return "terminal"
    return "unknown"


class LocalRetryPolicy:
    """Pure retry policy with no clocks, I/O, randomness, or side effects."""

    def __init__(self, window: RetryWindow = RetryWindow()) -> None:
        self.window = window

    def decide(self, signal: str, attempt: int, elapsed_ms: int) -> RetryDecision:
        """Return a bounded action for a one-indexed attempt observation."""

        value = canonical_signal(signal)
        bucket = stable_outcome_bucket(value)

        if not isinstance(attempt, int) or isinstance(attempt, bool):
            raise TypeError("attempt must be an integer")
        if not isinstance(elapsed_ms, int) or isinstance(elapsed_ms, bool):
            raise TypeError("elapsed_ms must be an integer")
        if attempt < 1:
            raise ValueError("attempt must be at least one")
        if elapsed_ms < 0:
            raise ValueError("elapsed_ms must not be negative")

        if bucket == "terminal":
            return RetryDecision(
                "stop", bucket, attempt, elapsed_ms, "terminal outcome"
            )
        if bucket == "unknown":
            return RetryDecision(
                "stop", bucket, attempt, elapsed_ms, "unrecognized outcome"
            )
        if attempt >= self.window.max_attempts:
            return RetryDecision(
                "stop", bucket, attempt, elapsed_ms, "attempt limit reached"
            )
        if elapsed_ms >= self.window.window_ms:
            return RetryDecision(
                "stop", bucket, attempt, elapsed_ms, "retry window expired"
            )
        return RetryDecision(
            "retry", bucket, attempt, elapsed_ms, "bounded transient outcome"
        )


def evaluate_sequence(
    signals: Iterable[str],
    window: RetryWindow = RetryWindow(),
) -> List[RetryDecision]:
    """Evaluate observations in order, using deterministic elapsed increments."""

    policy = LocalRetryPolicy(window)
    decisions: List[RetryDecision] = []
    elapsed_ms = 0

    for attempt, signal in enumerate(signals, start=1):
        decision = policy.decide(signal, attempt, elapsed_ms)
        decisions.append(decision)
        elapsed_ms += 100
        if not decision.should_retry:
            break
    return decisions


def format_decision(decision: RetryDecision) -> str:
    """Produce a stable single-line representation useful in local logs."""

    return (
        "attempt={0.attempt} elapsed_ms={0.elapsed_ms} "
        "bucket={0.bucket} action={0.action} reason={0.reason}"
    ).format(decision)


def _assert_equal(actual: object, expected: object, label: str) -> None:
    if actual != expected:
        raise AssertionError(
            "{0}: expected {1!r}, got {2!r}".format(label, expected, actual)
        )


def _assert_raises(exc_type: type, function, label: str) -> None:
    try:
        function()
    except exc_type:
        return
    except Exception as exc:
        raise AssertionError(
            "{0}: expected {1.__name__}, got {2.__class__.__name__}".format(
                label, exc_type, exc
            )
        ) from exc
    raise AssertionError("{0}: expected {1.__name__}".format(label, exc_type))


def run_self_test() -> None:
    """Exercise hand-authored regression cases without touching the filesystem."""

    policy = LocalRetryPolicy(RetryWindow(max_attempts=3, window_ms=250))
    cases: Tuple[Tuple[str, str, str, int, int], ...] = (
        ("temporary_failure", "transient", "retry", 1, 0),
        ("busy", "transient", "retry", 2, 100),
        ("timeout", "transient", "stop", 3, 200),
        ("connection reset", "transient", "stop", 2, 250),
        ("success", "terminal", "stop", 1, 0),
        ("permission_denied", "terminal", "stop", 1, 0),
        ("future_signal", "unknown", "stop", 1, 0),
        ("  TEMPORARY   FAILURE ", "transient", "retry", 1, 0),
    )

    for signal, bucket, action, attempt, elapsed_ms in cases:
        decision = policy.decide(signal, attempt, elapsed_ms)
        _assert_equal(decision.bucket, bucket, signal + " bucket")
        _assert_equal(decision.action, action, signal + " action")

    sequence = evaluate_sequence(
        ("temporary_failure", "timeout", "success"),
        RetryWindow(max_attempts=4, window_ms=500),
    )
    _assert_equal(
        [item.action for item in sequence],
        ["retry", "retry", "stop"],
        "sequence actions",
    )
    _assert_equal(sequence[-1].bucket, "terminal", "sequence terminal bucket")

    _assert_raises(
        ValueError,
        lambda: policy.decide("timeout", 0, 0),
        "zero attempt",
    )
    _assert_raises(
        ValueError,
        lambda: policy.decide("timeout", 1, -1),
        "negative elapsed time",
    )
    _assert_raises(
        TypeError,
        lambda: policy.decide("timeout", True, 0),
        "boolean attempt",
    )

    rendered = format_decision(policy.decide("busy", 1, 0))
    _assert_equal(
        rendered,
        "attempt=1 elapsed_ms=0 bucket=transient "
        "action=retry reason=bounded transient outcome",
        "stable rendering",
    )


def main(argv: List[str]) -> int:
    if argv == ["--self-test"]:
        run_self_test()
        print("AGOS_RUNTIME_OK")
        return 0
    print("usage: compact_deterministic_local_retry_window_example.py --self-test")
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
