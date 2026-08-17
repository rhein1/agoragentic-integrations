#!/usr/bin/env python3
"""Offline probe for isolating sequential counter drift.

The probe records compact state snapshots and compares two deterministic
sequences without performing network access, process execution, or writes.
"""

from dataclasses import dataclass
import argparse
import sys
from typing import Iterable, List, Optional, Sequence, Tuple


@dataclass(frozen=True)
class StateSnapshot:
    """A counter observation at one logical transition."""

    step: int
    counter: int
    label: str = ""

    def as_dict(self):
        return {
            "step": self.step,
            "counter": self.counter,
            "label": self.label,
        }


@dataclass(frozen=True)
class Divergence:
    """The first difference between expected and observed snapshots."""

    step: int
    reason: str
    expected: Optional[StateSnapshot]
    observed: Optional[StateSnapshot]

    def as_dict(self):
        return {
            "step": self.step,
            "reason": self.reason,
            "expected": None if self.expected is None else self.expected.as_dict(),
            "observed": None if self.observed is None else self.observed.as_dict(),
        }


class StateTransitionProbe:
    """Record a named sequence of counter snapshots for later comparison."""

    def __init__(self, name: str):
        if not name or not name.strip():
            raise ValueError("probe name must not be empty")
        self.name = name
        self._snapshots = []  # type: List[StateSnapshot]

    def record(self, counter: int, label: str = "") -> StateSnapshot:
        """Append the next snapshot and assign its one-based step number."""
        if not isinstance(counter, int) or isinstance(counter, bool):
            raise TypeError("counter must be an integer")
        snapshot = StateSnapshot(len(self._snapshots) + 1, counter, label)
        self._snapshots.append(snapshot)
        return snapshot

    def snapshots(self) -> Tuple[StateSnapshot, ...]:
        """Return an immutable view of recorded snapshots."""
        return tuple(self._snapshots)

    def counters(self) -> Tuple[int, ...]:
        return tuple(snapshot.counter for snapshot in self._snapshots)

    def labels(self) -> Tuple[str, ...]:
        return tuple(snapshot.label for snapshot in self._snapshots)


def snapshots_from(
    counters: Iterable[int],
    labels: Optional[Iterable[str]] = None,
    name: str = "sequence",
) -> Tuple[StateSnapshot, ...]:
    """Build a deterministic snapshot sequence from counters and labels."""
    probe = StateTransitionProbe(name)
    label_values = None if labels is None else iter(labels)
    for counter in counters:
        label = "" if label_values is None else next(label_values)
        probe.record(counter, label)
    if label_values is not None:
        try:
            next(label_values)
        except StopIteration:
            return probe.snapshots()
        raise ValueError("labels contains more entries than counters")
    return probe.snapshots()


def compare_snapshots(
    expected: Sequence[StateSnapshot],
    observed: Sequence[StateSnapshot],
) -> Optional[Divergence]:
    """Return the first counter, step, label, or length divergence."""
    shared = min(len(expected), len(observed))
    for index in range(shared):
        wanted = expected[index]
        actual = observed[index]
        if wanted.step != actual.step:
            return Divergence(
                index + 1, "step", wanted, actual
            )
        if wanted.counter != actual.counter:
            return Divergence(
                index + 1, "counter", wanted, actual
            )
        if wanted.label != actual.label:
            return Divergence(
                index + 1, "label", wanted, actual
            )
    if len(expected) != len(observed):
        step = shared + 1
        wanted = expected[shared] if len(expected) > shared else None
        actual = observed[shared] if len(observed) > shared else None
        return Divergence(step, "length", wanted, actual)
    return None


def compare_counters(
    expected: Iterable[int],
    observed: Iterable[int],
) -> Optional[Divergence]:
    """Compare counter-only sequences using one-based logical steps."""
    expected_snapshots = snapshots_from(expected, name="expected")
    observed_snapshots = snapshots_from(observed, name="observed")
    return compare_snapshots(expected_snapshots, observed_snapshots)


def format_report(
    expected: Sequence[StateSnapshot],
    observed: Sequence[StateSnapshot],
) -> str:
    """Render a stable, human-readable diagnostic report."""
    divergence = compare_snapshots(expected, observed)
    lines = [
        "deterministic state transition probe",
        "expected snapshots: {}".format(len(expected)),
        "observed snapshots: {}".format(len(observed)),
    ]
    if divergence is None:
        lines.append("status: match")
        lines.append("first divergent step: none")
        return "\n".join(lines)
    lines.append("status: divergent")
    lines.append("first divergent step: {}".format(divergence.step))
    lines.append("reason: {}".format(divergence.reason))
    if divergence.expected is None:
        lines.append("expected: <missing>")
    else:
        lines.append(
            "expected: step={} counter={} label={!r}".format(
                divergence.expected.step,
                divergence.expected.counter,
                divergence.expected.label,
            )
        )
    if divergence.observed is None:
        lines.append("observed: <missing>")
    else:
        lines.append(
            "observed: step={} counter={} label={!r}".format(
                divergence.observed.step,
                divergence.observed.counter,
                divergence.observed.label,
            )
        )
    return "\n".join(lines)


def _run_self_test() -> None:
    cases = [
        (
            "matching counters",
            [0, 1, 2, 3],
            [0, 1, 2, 3],
            None,
        ),
        (
            "increment skipped",
            [10, 11, 12, 13],
            [10, 11, 13, 14],
            (3, "counter"),
        ),
        (
            "initial offset",
            [1, 2, 3],
            [0, 1, 2],
            (1, "counter"),
        ),
        (
            "observed sequence truncated",
            [4, 5, 6],
            [4, 5],
            (3, "length"),
        ),
        (
            "observed sequence extended",
            [7],
            [7, 8],
            (2, "length"),
        ),
        (
            "labels identify transition",
            [2, 3],
            [2, 3],
            (2, "label"),
        ),
    ]
    for name, expected, observed, wanted in cases:
        expected_labels = ["init"] + ["advance"] * (len(expected) - 1)
        observed_labels = ["init"] + ["advance"] * (len(observed) - 1)
        if name == "labels identify transition":
            observed_labels[-1] = "drifted-label"
        expected_snapshots = snapshots_from(
            expected, expected_labels, name="expected"
        )
        observed_snapshots = snapshots_from(
            observed, observed_labels, name="observed"
        )
        result = compare_snapshots(expected_snapshots, observed_snapshots)
        if wanted is None:
            assert result is None, name
        else:
            assert result is not None, name
            assert (result.step, result.reason) == wanted, name
    assert compare_counters([1, 2], [1, 2]) is None
    assert compare_counters([1], [1, 2]).step == 2
    print("AGOS_RUNTIME_OK")


def _demo() -> int:
    expected = snapshots_from([0, 1, 2, 3], ["start", "read", "write", "done"])
    observed = snapshots_from([0, 1, 3, 4], ["start", "read", "write", "done"])
    print(format_report(expected, observed))
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="run deterministic local regression cases",
    )
    args = parser.parse_args(argv)
    if args.self_test:
        _run_self_test()
        return 0
    return _demo()


if __name__ == "__main__":
    sys.exit(main())
