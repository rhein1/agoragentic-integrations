"""Command-line interface for offline validation and fixture replay."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .contracts import ContractError
from .manifest import canonical_json, load_json, verify_source_lock
from .runner import (
    DEFAULT_EXPECTED_EVIDENCE,
    DEFAULT_LOCK,
    DEFAULT_TASK_DIR,
    DEFAULT_TRIALS,
    load_task_packet,
    replay_task,
    verify_fixture_evidence,
)
from .target import validate_target_config


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Agoragentic Cohort Assurance offline contract tools"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    lock = commands.add_parser(
        "verify-lock", help="verify the reviewed upstream source lock"
    )
    lock.add_argument("--lock", type=Path, default=DEFAULT_LOCK)
    lock.add_argument("--upstream-root", type=Path)
    lock.add_argument(
        "--offline-fixture",
        action="store_true",
        help="verify committed lock without an upstream checkout",
    )
    validate = commands.add_parser("validate", help="validate a closed task packet")
    validate.add_argument("--task-dir", type=Path, default=DEFAULT_TASK_DIR)
    replay = commands.add_parser(
        "replay", help="build deterministic public-safe evidence from fixtures"
    )
    replay.add_argument("--task-dir", type=Path, default=DEFAULT_TASK_DIR)
    replay.add_argument("--trials", type=Path, default=DEFAULT_TRIALS)
    replay.add_argument("--lock", type=Path, default=DEFAULT_LOCK)
    replay.add_argument("--out", type=Path)
    replay.add_argument(
        "--verify-expected",
        action="store_true",
        help="require byte identity with the committed fixture baseline",
    )
    replay.add_argument("--expected", type=Path, default=DEFAULT_EXPECTED_EVIDENCE)
    live = commands.add_parser(
        "run",
        help="validate live gates; external execution is intentionally unavailable",
    )
    live.add_argument("--task-dir", type=Path, default=DEFAULT_TASK_DIR)
    live.add_argument("--target-config", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "verify-lock":
            if args.offline_fixture and args.upstream_root is not None:
                raise ContractError(
                    "upstream_lock_invalid",
                    "choose offline fixture or an upstream root, not both",
                )
            digest = verify_source_lock(load_json(args.lock), args.upstream_root)
            print(
                canonical_json(
                    {
                        "ok": True,
                        "source_lock_sha256": digest,
                        "upstream_files_verified": args.upstream_root is not None,
                    }
                )
            )
            return 0
        if args.command == "validate":
            packet = load_task_packet(args.task_dir)
            print(canonical_json({"ok": True, "task_id": packet["task"]["task_id"]}))
            return 0
        if args.command == "replay":
            packet = replay_task(args.task_dir, args.trials, args.lock)
            if args.verify_expected:
                verify_fixture_evidence(packet, args.expected)
            payload = canonical_json(packet) + "\n"
            if args.out:
                args.out.parent.mkdir(parents=True, exist_ok=True)
                args.out.write_text(payload, encoding="utf-8")
            else:
                print(payload, end="")
            return 0
        load_task_packet(args.task_dir)
        validate_target_config(load_json(args.target_config))
        if os.environ.get("AGORAGENTIC_MATRAIX_LIVE") != "1":
            raise ContractError(
                "live_execution_not_authorized",
                "AGORAGENTIC_MATRAIX_LIVE=1 is required but not sufficient",
            )
        raise ContractError(
            "live_execution_unavailable",
            "this reviewed alpha contains no external provider runner",
        )
    except (ContractError, FileNotFoundError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
