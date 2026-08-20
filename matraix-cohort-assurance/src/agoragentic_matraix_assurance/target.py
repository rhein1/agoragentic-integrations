"""No-spend target policy for a later owner-authorized live runner."""

from __future__ import annotations

import ipaddress
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlparse

from .contracts import ContractError, validate_authority_flags


class TargetPolicyError(ContractError):
    pass


def _is_loopback(hostname: str | None) -> bool:
    if not hostname:
        return False
    if hostname.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _validate_authority(value: Any) -> None:
    try:
        validate_authority_flags(value)
    except ContractError as exc:
        raise TargetPolicyError(exc.code, str(exc).partition(": ")[2]) from exc


def validate_target_config(config: Mapping[str, Any]) -> dict[str, Any]:
    expected = {
        "schema",
        "base_url",
        "allowlisted_hosts",
        "capability_path",
        "expected_target_version",
        "price_usdc",
        "authority",
    }
    if set(config) != expected:
        raise TargetPolicyError(
            "target_config_invalid",
            "target config is missing fields or has unknown fields",
        )
    if config["schema"] != "agoragentic.synthetic-cohort-target.v1":
        raise TargetPolicyError("target_config_invalid", "unsupported target schema")
    parsed = urlparse(config["base_url"])
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise TargetPolicyError(
            "target_url_invalid",
            "target URL must be an origin without credentials, query, or fragment",
        )
    allowlist = config["allowlisted_hosts"]
    if not isinstance(allowlist, list) or any(
        not isinstance(item, str) for item in allowlist
    ):
        raise TargetPolicyError(
            "target_allowlist_invalid", "allowlisted_hosts must be strings"
        )
    if not _is_loopback(parsed.hostname):
        if parsed.scheme != "https" or parsed.hostname not in allowlist:
            raise TargetPolicyError("target_host_not_allowlisted", parsed.hostname)
    if config["price_usdc"] != 0:
        raise TargetPolicyError(
            "nonzero_price_prohibited", "cohort assurance target must be free"
        )
    if not isinstance(config["capability_path"], str) or not config[
        "capability_path"
    ].startswith("/"):
        raise TargetPolicyError(
            "target_path_invalid", "capability_path must be absolute"
        )
    if (
        not isinstance(config["expected_target_version"], str)
        or not config["expected_target_version"]
    ):
        raise TargetPolicyError(
            "target_version_missing", "expected_target_version is required"
        )
    _validate_authority(config["authority"])
    return dict(config)


def validate_target_response(
    config: Mapping[str, Any], response: Mapping[str, Any]
) -> dict[str, Any]:
    validate_target_config(config)
    expected = {"http_status", "price_usdc", "target_version", "receipt"}
    if set(response) != expected:
        raise TargetPolicyError(
            "target_response_invalid",
            "response is missing fields or has unknown fields",
        )
    status = response["http_status"]
    if status == 402:
        raise TargetPolicyError(
            "payment_challenge_prohibited", "HTTP 402 is never payable here"
        )
    if type(status) is not int or not 200 <= status < 300:
        raise TargetPolicyError("target_response_failed", f"unexpected status {status}")
    if response["price_usdc"] != 0:
        raise TargetPolicyError(
            "nonzero_price_prohibited", "target response is not free"
        )
    if response["target_version"] != config["expected_target_version"]:
        raise TargetPolicyError(
            "target_version_changed", "target version drifted during run"
        )
    receipt = response["receipt"]
    if not isinstance(receipt, Mapping):
        raise TargetPolicyError("target_receipt_missing", "receipt is required")
    if set(receipt) != {"schema", "receipt_id", "capability_path", "target_version"}:
        raise TargetPolicyError("target_receipt_invalid", "receipt contract is closed")
    if (
        receipt["schema"] != "agoragentic.synthetic-cohort-target-receipt.v1"
        or not receipt["receipt_id"]
    ):
        raise TargetPolicyError("target_receipt_invalid", "receipt identity is invalid")
    if receipt["capability_path"] != config["capability_path"]:
        raise TargetPolicyError(
            "target_route_drift", "receipt route differs from configured capability"
        )
    if receipt["target_version"] != config["expected_target_version"]:
        raise TargetPolicyError(
            "target_version_changed", "receipt version drifted during run"
        )
    return dict(response)
