#!/usr/bin/env python3
"""Deterministic, offline prioritization of sanitized status snapshots."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, Iterable, List, Mapping, Sequence, Tuple

MAX_DETAIL = 160
DEFAULT_LIMIT = 5
SEVERITY = {
    "critical": 0,
    "degraded": 1,
    "unknown": 2,
    "healthy": 3,
}
STATUS_ALIASES = {
    "error": "critical",
    "failed": "critical",
    "failure": "critical",
    "outage": "critical",
    "warning": "degraded",
    "degraded": "degraded",
    "ok": "healthy",
    "pass": "healthy",
    "passed": "healthy",
    "healthy": "healthy",
}


def _clean_text(value: Any, fallback: str = "") -> str:
    """Return bounded printable text suitable for local reporting."""
    if value is None:
        return fallback
    text = str(value).replace("\r", " ").replace("\n", " ").strip()
    text = "".join(char if char.isprintable() else " " for char in text)
    text = " ".join(text.split())
    return text[:MAX_DETAIL] or fallback


def _status(value: Any) -> str:
    normalized = _clean_text(value, "unknown").lower()
    return STATUS_ALIASES.get(normalized, normalized if normalized in SEVERITY else "unknown")


def _snapshot_rows(
    snapshots: Iterable[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for position, snapshot in enumerate(snapshots):
        if not isinstance(snapshot, Mapping):
            continue
        component = _clean_text(snapshot.get("component"), f"item-{position + 1}")
        status = _status(snapshot.get("status"))
        detail = _clean_text(snapshot.get("detail"), "No detail supplied.")
        rows.append(
            {
                "component": component,
                "status": status,
                "detail": detail,
                "source_index": position,
            }
        )
    return rows


def prioritize(
    snapshots: Iterable[Mapping[str, Any]],
    limit: int = DEFAULT_LIMIT,
) -> List[Dict[str, Any]]:
    """Return a stable, bounded repair queue from sanitized snapshots."""
    if not isinstance(limit, int) or isinstance(limit, bool):
        raise TypeError("limit must be an integer")
    if limit < 0:
        raise ValueError("limit must not be negative")

    rows = _snapshot_rows(snapshots)
    rows.sort(
        key=lambda row: (
            SEVERITY[row["status"]],
            row["component"].casefold(),
            row["source_index"],
        )
    )
    queue: List[Dict[str, Any]] = []
    for rank, row in enumerate(rows[:limit], start=1):
        queue.append(
            {
                "rank": rank,
                "component": row["component"],
                "status": row["status"],
                "detail": row["detail"],
                "next_step": next_step(row["status"]),
            }
        )
    return queue


def next_step(status: str) -> str:
    """Map a normalized status to a bounded, non-invasive local action."""
    actions = {
        "critical": "Confirm the snapshot and inspect the affected public surface.",
        "degraded": "Compare the snapshot with the last known-good local result.",
        "unknown": "Collect a clearer sanitized snapshot before changing anything.",
        "healthy": "Record the result and continue monitoring locally.",
    }
    return actions[_status(status)]


def summarize(queue: Sequence[Mapping[str, Any]]) -> Dict[str, Any]:
    """Produce deterministic counts and the ordered queue."""
    counts = {name: 0 for name in ("critical", "degraded", "unknown", "healthy")}
    for item in queue:
        status = _status(item.get("status"))
        counts[status] += 1
    return {"counts": counts, "queue": list(queue)}


def render(snapshots: Iterable[Mapping[str, Any]], limit: int) -> str:
    queue = prioritize(snapshots, limit)
    return json.dumps(summarize(queue), indent=2, sort_keys=True)


def _assert_equal(actual: Any, expected: Any) -> None:
    assert actual == expected, f"expected {expected!r}, got {actual!r}"


def self_test() -> None:
    source = [
        {"component": "docs", "status": "healthy", "detail": "ready"},
        {"component": "api", "status": "critical", "detail": "timeout"},
        {"component": "worker", "status": "warning", "detail": "slow\noutput"},
        {"component": "unknown-input", "status": "mystery"},
        {"component": "api", "status": "failed", "detail": "second"},
        {"component": "ignored", "status": "healthy"},
    ]
    queue = prioritize(source, limit=5)
    _assert_equal(
        [item["component"] for item in queue],
        ["api", "api", "worker", "unknown-input", "docs"],
    )
    _assert_equal(
        [item["status"] for item in queue],
        ["critical", "critical", "degraded", "unknown", "healthy"],
    )
    _assert_equal(queue[2]["detail"], "slow output")
    _assert_equal(len(prioritize(source, limit=2)), 2)
    _assert_equal(len(prioritize(source, limit=0)), 0)

    duplicate = [
        {"component": "Zeta", "status": "degraded"},
        {"component": "alpha", "status": "degraded"},
        {"component": "ALPHA", "status": "degraded"},
    ]
    _assert_equal(
        [item["component"] for item in prioritize(duplicate)],
        ["alpha", "ALPHA", "Zeta"],
    )
    _assert_equal(next_step("error"), next_step("critical"))
    _assert_equal(summarize(queue)["counts"]["critical"], 2)

    try:
        prioritize([], limit=-1)
    except ValueError:
        pass
    else:
        raise AssertionError("negative limits must fail")

    rendered = render([{"component": "x", "status": "ok"}], 1)
    _assert_equal(json.loads(rendered)["queue"][0]["status"], "healthy")


def _read_input(path: str) -> Any:
    if path == "-":
        return json.load(sys.stdin)
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--input", default="-", help="JSON list of sanitized snapshots")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    args = parser.parse_args(argv)

    if args.self_test:
        self_test()
        print("AGOS_RUNTIME_OK")
        return 0

    payload = _read_input(args.input)
    if not isinstance(payload, list):
        raise ValueError("input must be a JSON list")
    print(render(payload, args.limit))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
