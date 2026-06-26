#!/usr/bin/env python3
"""No-network Interchange v0 reference helpers.

This module intentionally implements only deterministic canonicalization and
message construction. It does not submit requests, read private keys, sign
payments, or mutate Agoragentic trust state.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any, Dict


def stable_stringify(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def hash_ref(value: Any) -> str:
    payload = {} if value is None else value
    return "sha256:" + hashlib.sha256(stable_stringify(payload).encode("utf-8")).hexdigest()


def params_without_auth(params: Dict[str, Any]) -> Dict[str, Any]:
    return {key: value for key, value in (params or {}).items() if key != "auth"}


def params_for_post_pin_signing(*, method: str, params: Dict[str, Any]) -> Dict[str, Any]:
    without_auth = params_without_auth(params)
    if method == "federation/follow-referral":
        return {
            "relationship_id": without_auth.get("relationship_id"),
            "remote_origin": without_auth.get("remote_origin"),
            "referral_id": without_auth.get("referral_id"),
        }
    return without_auth


def canonical_post_pin_message(
    *,
    method: str,
    relationship_id: str,
    remote_origin: str,
    nonce: str,
    timestamp: Any,
    params: Dict[str, Any],
) -> str:
    return "\n".join(
        [
            method,
            relationship_id,
            remote_origin,
            nonce,
            str(timestamp),
            hash_ref(params or {}),
        ]
    )


def challenge_response_hash_ref(*, challenge: str, body: Dict[str, Any]) -> str:
    return hash_ref({"challenge": challenge, "body": body if isinstance(body, dict) else {}})


def create_pilot_agent_card(
    *,
    name: str,
    agent_id: str,
    agent_url: str,
    key_id: str,
    public_key_der_base64: str,
) -> Dict[str, Any]:
    return {
        "schema": "agoragentic.agent-card.v1",
        "name": name,
        "agent_id": agent_id,
        "url": agent_url,
        "description": "Partner-controlled A2A federation pilot card for Agoragentic Interchange. Protocol pilot only; not an external-demand claim.",
        "extensions": {
            "agoragentic:federation": {
                "schema": "agoragentic.agent-federation.v1",
                "key_id": key_id,
                "public_key_der_base64": public_key_der_base64,
                "capability_exchange": True,
                "federation_consent": True,
                "trust_model": "key_control_tofu_not_identity",
            }
        },
    }


def _load_vectors() -> Dict[str, Any]:
    vector_path = Path(__file__).resolve().parents[2] / "conformance" / "vectors.json"
    return json.loads(vector_path.read_text(encoding="utf-8"))


def run_self_test() -> Dict[str, Any]:
    vectors = _load_vectors()
    failures = []

    for vector in vectors.get("post_pin_signing", []):
        params_to_sign = vector.get("params_to_sign") or params_for_post_pin_signing(
            method=vector["method"],
            params=vector.get("wire_params") or vector["params_without_auth"],
        )
        params_hash = hash_ref(params_to_sign)
        message = canonical_post_pin_message(
            method=vector["method"],
            relationship_id=vector["relationship_id"],
            remote_origin=vector["remote_origin"],
            nonce=vector["nonce"],
            timestamp=vector["timestamp"],
            params=params_to_sign,
        )
        message_hex = message.encode("utf-8").hex()
        if params_hash != vector["expected_params_hash"]:
            failures.append(f"{vector['id']}: params hash mismatch")
        if message != vector["expected_canonical_message"]:
            failures.append(f"{vector['id']}: canonical message mismatch")
        if message_hex != vector["expected_canonical_message_utf8_hex"]:
            failures.append(f"{vector['id']}: UTF-8 hex mismatch")

    for vector in vectors.get("challenge_response", []):
        challenge_hash = challenge_response_hash_ref(challenge=vector["challenge"], body=vector["body"])
        if challenge_hash != vector["expected_challenge_hash"]:
            failures.append(f"{vector['id']}: challenge hash mismatch")

    return {
        "ok": not failures,
        "failures": failures,
        "vectors_checked": {
            "post_pin_signing": len(vectors.get("post_pin_signing", [])),
            "challenge_response": len(vectors.get("challenge_response", [])),
        },
        "note": "No network calls, payments, trust mutations, or registry submissions were made.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Agoragentic Interchange no-network reference client")
    parser.add_argument("--self-test", action="store_true", help="Validate bundled conformance vectors")
    args = parser.parse_args()
    if not args.self_test:
        parser.print_help()
        return 0
    result = run_self_test()
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
