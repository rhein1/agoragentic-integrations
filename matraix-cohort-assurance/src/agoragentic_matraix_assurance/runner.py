"""Offline task loading and deterministic fixture replay."""

from __future__ import annotations

import sysconfig
import tomllib
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .contracts import ContractError, validate_task_packet
from .evidence import build_evidence_packet
from .manifest import canonical_json, load_json, verify_source_lock

SOURCE_ROOT = Path(__file__).resolve().parents[2]
INSTALLED_DATA_ROOT = Path(sysconfig.get_path("data")) / "share" / "agos-matraix"
SOURCE_AVAILABLE = (SOURCE_ROOT / "UPSTREAM_LOCK.json").is_file()
DEFAULT_TASK_DIR = (
    SOURCE_ROOT / "tasks" / "resolution-desk-mcp-smoke"
    if SOURCE_AVAILABLE
    else INSTALLED_DATA_ROOT / "t"
)
DEFAULT_TRIALS = (
    SOURCE_ROOT / "fixtures" / "sanitized_trials.json"
    if SOURCE_AVAILABLE
    else INSTALLED_DATA_ROOT / "f" / "sanitized_trials.json"
)
DEFAULT_LOCK = (
    SOURCE_ROOT / "UPSTREAM_LOCK.json"
    if SOURCE_AVAILABLE
    else INSTALLED_DATA_ROOT / "UPSTREAM_LOCK.json"
)
DEFAULT_EXPECTED_EVIDENCE = (
    SOURCE_ROOT / "fixtures" / "expected_evidence.json"
    if SOURCE_AVAILABLE
    else INSTALLED_DATA_ROOT / "f" / "expected_evidence.json"
)
ADAPTER_VERSION = "0.1.0a0"


def load_task_packet(task_dir: Path) -> dict[str, Any]:
    task = tomllib.loads((task_dir / "task.toml").read_text(encoding="utf-8"))
    instruction = (task_dir / "instruction.md").read_text(encoding="utf-8").strip()
    task["instruction"] = instruction
    strategy = load_json(task_dir / "persona_strategy.json")
    reporting = load_json(task_dir / "reporting.json")
    return validate_task_packet(task, strategy, reporting)


def replay_task(
    task_dir: Path = DEFAULT_TASK_DIR,
    trials_path: Path = DEFAULT_TRIALS,
    lock_path: Path = DEFAULT_LOCK,
) -> dict[str, Any]:
    validated = load_task_packet(task_dir)
    lock = load_json(lock_path)
    verify_source_lock(lock)
    trials = load_json(trials_path)
    return build_evidence_packet(validated, trials, lock, ADAPTER_VERSION)


def require_no_caller_overrides(payload: Mapping[str, Any]) -> None:
    forbidden = {"evidence_hash", "metrics", "run_id", "authority", "receipt"}
    attempted = forbidden & set(payload)
    if attempted:
        raise ContractError(
            "caller_override_prohibited",
            f"caller supplied evaluator fields: {sorted(attempted)}",
        )


def verify_fixture_evidence(
    packet: Mapping[str, Any],
    expected_path: Path = DEFAULT_EXPECTED_EVIDENCE,
) -> None:
    expected = expected_path.read_text(encoding="utf-8")
    actual = canonical_json(packet) + "\n"
    if actual != expected:
        raise ContractError(
            "fixture_evidence_mismatch",
            "task, dataset, seed, replacement policy, trial fixture, or evaluator output drifted",
        )
