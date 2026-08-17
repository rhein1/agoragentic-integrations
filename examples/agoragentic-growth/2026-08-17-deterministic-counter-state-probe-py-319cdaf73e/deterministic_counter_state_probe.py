#!/usr/bin/env python3
"""Offline, deterministic checks for sequential counter transitions."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence


MAX_ITEMS = 128
MAX_ABS_VALUE = 1_000_000
MAX_TEXT = 4096


@dataclass(frozen=True)
class Finding:
    code: str
    index: int
    message: str
    expected: Optional[int] = None
    observed: Optional[int] = None

    def as_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "code": self.code,
            "index": self.index,
            "message": self.message,
        }
        if self.expected is not None:
            result["expected"] = self.expected
        if self.observed is not None:
            result["observed"] = self.observed
        return result


def _bounded_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("%s must be an integer" % label)
    if abs(value) > MAX_ABS_VALUE:
        raise ValueError("%s is outside the bounded range" % label)
    return value


def _normalise(values: Iterable[Any]) -> List[int]:
    items = list(values)
    if len(items) > MAX_ITEMS:
        raise ValueError("sequence exceeds %d items" % MAX_ITEMS)
    return [_bounded_int(value, "sequence item") for value in items]


def inspect_sequence(
    observed: Iterable[Any],
    *,
    start: int = 0,
    step: int = 1,
) -> Dict[str, Any]:
    """Return stable diagnostics for a finite sequence of counter values."""
    start = _bounded_int(start, "start")
    step = _bounded_int(step, "step")
    if step <= 0:
        raise ValueError("step must be positive")

    values = _normalise(observed)
    findings: List[Finding] = []
    previous = start
    index = 0

    while index < len(values):
        value = values[index]
        expected = previous + step

        if (
            index == 0
            and len(values) > 1
            and values[index + 1] < value
        ):
            findings.append(
                Finding(
                    code="decrease",
                    index=index + 1,
                    message="value moved backwards",
                    expected=value + step,
                    observed=values[index + 1],
                )
            )
            previous = values[index + 1]
            index += 2
            continue

        if value != expected:
            if value == previous:
                code = "duplicate"
                message = "value repeated instead of advancing"
            elif value < previous:
                code = "decrease"
                message = "value moved backwards"
            elif value > expected:
                code = "gap"
                message = "value skipped one or more transitions"
            else:
                code = "unexpected"
                message = "value did not match the next transition"
            findings.append(
                Finding(
                    code=code,
                    index=index,
                    message=message,
                    expected=expected,
                    observed=value,
                )
            )
        previous = value
        index += 1

    return {
        "start": start,
        "step": step,
        "count": len(values),
        "values": values,
        "ok": not findings,
        "findings": [finding.as_dict() for finding in findings],
    }


def render(result: Dict[str, Any]) -> str:
    """Render diagnostics with stable key ordering and no platform data."""
    return json.dumps(result, sort_keys=True, separators=(",", ":"))


def parse_sequence(text: str) -> List[int]:
    if len(text) > MAX_TEXT:
        raise ValueError("sequence text is too long")
    if not text.strip():
        return []
    parts = text.split(",")
    if len(parts) > MAX_ITEMS:
        raise ValueError("sequence exceeds %d items" % MAX_ITEMS)
    values: List[int] = []
    for part in parts:
        token = part.strip()
        if not token:
            raise ValueError("sequence contains an empty item")
        try:
            values.append(int(token, 10))
        except ValueError as exc:
            raise ValueError("sequence contains a non-integer item") from exc
    return values


def _expect(condition: bool, detail: str) -> None:
    if not condition:
        raise AssertionError(detail)


def self_test() -> None:
    clean = inspect_sequence([1, 2, 3, 4])
    _expect(clean["ok"], "clean sequence should pass")
    _expect(clean["findings"] == [], "clean sequence should have no findings")

    duplicate = inspect_sequence([1, 1, 2])
    _expect(not duplicate["ok"], "duplicate should fail")
    _expect(duplicate["findings"][0]["code"] == "duplicate", "duplicate code")

    decreasing = inspect_sequence([3, 2])
    _expect(decreasing["findings"][0]["code"] == "decrease", "decrease code")

    skipped = inspect_sequence([1, 3])
    _expect(skipped["findings"][0]["code"] == "gap", "gap code")

    custom = inspect_sequence([12, 14, 16], start=10, step=2)
    _expect(custom["ok"], "custom step should pass")
    _expect(
        render(custom) == render(inspect_sequence([12, 14, 16], start=10, step=2)),
        "diagnostics must be reproducible",
    )

    try:
        inspect_sequence([1] * (MAX_ITEMS + 1))
    except ValueError:
        pass
    else:
        raise AssertionError("oversized input should fail")

    try:
        inspect_sequence([1], step=0)
    except ValueError:
        pass
    else:
        raise AssertionError("non-positive step should fail")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Check deterministic sequential counter transitions offline."
    )
    parser.add_argument(
        "--sequence",
        default="",
        help="comma-separated observed integer values",
    )
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--step", type=int, default=1)
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="run deterministic local checks",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.self_test:
        self_test()
        print("AGOS_RUNTIME_OK")
        return 0

    try:
        values = parse_sequence(args.sequence)
        result = inspect_sequence(values, start=args.start, step=args.step)
    except (TypeError, ValueError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, sort_keys=True))
        return 2

    print(render(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
