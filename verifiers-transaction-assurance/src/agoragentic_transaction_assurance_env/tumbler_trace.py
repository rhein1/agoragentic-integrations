"""Runtime-only evaluator proof for Tumbler RL episode records."""

from __future__ import annotations

import json
import re
import secrets
from collections.abc import Mapping
from hashlib import sha256
from hmac import compare_digest, digest
from typing import Any

from .tumbler import TUMBLER_EPISODE_SCHEMA, TumblerContractError

TRACE_TUMBLER_EPISODE_KEY = "agoragentic_tumbler_episode"
TRACE_TUMBLER_EPISODE_PROOF_KEY = "agoragentic_tumbler_episode_proof"
_EVALUATOR_EPISODE_PROOF_SECRET = secrets.token_bytes(32)
_EPISODE_KEYS = {
    "schema",
    "scenario_id",
    "scenario_pack_version",
    "scenario_pack_sha256",
    "transport_mode",
    "terminal_action",
    "terminal_reason_code",
    "outcome_code",
    "integrity_flags",
    "evidence",
    "transitions",
    "reward",
    "episode_sha256",
}


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _validated_episode_record(
    value: Any,
    *,
    expected_scenario_id: str,
    expected_pack_version: str,
    expected_pack_sha256: str,
) -> dict[str, Any]:
    if not isinstance(value, Mapping) or set(value) != _EPISODE_KEYS:
        raise TumblerContractError("episode_record_invalid_fields")
    if value.get("schema") != TUMBLER_EPISODE_SCHEMA:
        raise TumblerContractError("episode_record_schema_mismatch")
    if value.get("scenario_id") != expected_scenario_id:
        raise TumblerContractError("episode_record_scenario_mismatch")
    if value.get("scenario_pack_version") != expected_pack_version:
        raise TumblerContractError("episode_record_pack_version_mismatch")
    if value.get("scenario_pack_sha256") != expected_pack_sha256:
        raise TumblerContractError("episode_record_pack_hash_mismatch")
    episode_sha = value.get("episode_sha256")
    if not isinstance(episode_sha, str) or not re.fullmatch(
        r"[0-9a-f]{64}", episode_sha
    ):
        raise TumblerContractError("episode_record_hash_invalid")
    unsigned = {key: item for key, item in value.items() if key != "episode_sha256"}
    expected_hash = sha256(_canonical_bytes(unsigned)).hexdigest()
    if not compare_digest(episode_sha, expected_hash):
        raise TumblerContractError("episode_record_hash_mismatch")
    reward = value.get("reward")
    if not isinstance(reward, Mapping) or not isinstance(
        reward.get("total"), (int, float)
    ):
        raise TumblerContractError("episode_record_reward_invalid")
    if not isinstance(value.get("transitions"), list):
        raise TumblerContractError("episode_record_transitions_invalid")
    if not isinstance(value.get("evidence"), list):
        raise TumblerContractError("episode_record_evidence_invalid")
    return dict(value)


def attach_evaluator_episode(trace: Any, record: Mapping[str, Any]) -> None:
    """Attach an episode with process-local proof that is absent from wire traces."""

    info = getattr(trace, "info", None)
    state = getattr(trace, "state", None)
    artifacts = getattr(state, "artifacts", None)
    trace_id = getattr(trace, "id", None)
    if not isinstance(info, dict) or not isinstance(artifacts, dict):
        raise TumblerContractError("evaluator_trace_boundary_missing")
    if not isinstance(trace_id, str) or not trace_id:
        raise TumblerContractError("trace_id_missing")
    if (
        TRACE_TUMBLER_EPISODE_KEY in info
        or TRACE_TUMBLER_EPISODE_PROOF_KEY in artifacts
    ):
        raise TumblerContractError("evaluator_episode_prefilled")
    canonical = _canonical_bytes(record)
    proof = digest(
        _EVALUATOR_EPISODE_PROOF_SECRET,
        trace_id.encode("utf-8") + b"\0" + canonical,
        "sha256",
    )
    info[TRACE_TUMBLER_EPISODE_KEY] = dict(record)
    artifacts[TRACE_TUMBLER_EPISODE_PROOF_KEY] = proof


def episode_record_from_trace(
    trace: Any,
    *,
    expected_scenario_id: str,
    expected_pack_version: str,
    expected_pack_sha256: str,
) -> dict[str, Any]:
    """Return only an episode carrying the evaluator's process-local proof."""

    info = getattr(trace, "info", None)
    if not isinstance(info, Mapping):
        raise TumblerContractError("trace_info_missing")
    candidate = info.get(TRACE_TUMBLER_EPISODE_KEY)
    if candidate is None:
        raise TumblerContractError("episode_record_missing")
    state = getattr(trace, "state", None)
    artifacts = getattr(state, "artifacts", None)
    proof = (
        artifacts.get(TRACE_TUMBLER_EPISODE_PROOF_KEY)
        if isinstance(artifacts, dict)
        else None
    )
    trace_id = getattr(trace, "id", None)
    if not isinstance(proof, bytes) or not isinstance(trace_id, str):
        raise TumblerContractError("evaluator_episode_proof_missing")
    expected_proof = digest(
        _EVALUATOR_EPISODE_PROOF_SECRET,
        trace_id.encode("utf-8") + b"\0" + _canonical_bytes(candidate),
        "sha256",
    )
    if not compare_digest(proof, expected_proof):
        raise TumblerContractError("evaluator_episode_proof_invalid")
    return _validated_episode_record(
        candidate,
        expected_scenario_id=expected_scenario_id,
        expected_pack_version=expected_pack_version,
        expected_pack_sha256=expected_pack_sha256,
    )


__all__ = [
    "TRACE_TUMBLER_EPISODE_KEY",
    "TRACE_TUMBLER_EPISODE_PROOF_KEY",
    "attach_evaluator_episode",
    "episode_record_from_trace",
]
