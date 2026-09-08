#!/usr/bin/env python3
"""Fail-closed local preflight and SDK hook shape; never a paid executor.

This module does not authenticate a principal, read files on behalf of a tool,
verify settlement, or grant approval. Production backend authorization remains
mandatory. See README.md for the evidence boundary and compatibility changes.
"""
from __future__ import annotations

import json
import math
import re
from decimal import Decimal
from pathlib import Path
from types import MappingProxyType
from typing import Any, Mapping, Optional, Tuple

READ_TOOLS = frozenset({"agoragentic_match", "agoragentic_search", "agoragentic_categories"})
EXECUTE_TOOLS = frozenset({"agoragentic_execute", "agoragentic_invoke"})
DEFAULTS = {
    "max_spend_usdc_per_call": "0.25",
    "allow_file_access_before_execution": False,
    "require_hitl_for_spend": True,
    "publish_receipts_publicly": False,
}
MONEY = re.compile(r"(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?\Z", re.ASCII)


def money(value: Any) -> Decimal:
    """Accept bounded decimal strings and legacy finite numbers; never coerce bools."""
    if type(value) not in (str, int, float):
        raise ValueError("invalid_money")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("invalid_money")
    text = value if type(value) is str else format(Decimal(str(value)), "f")
    if not MONEY.fullmatch(text):
        raise ValueError("invalid_money")
    return Decimal(text)


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_config_key")
        result[key] = value
    return result


def load_permissions(path: Optional[str]) -> Mapping[str, Any]:
    raw: Any = {}
    if path is not None:
        source = Path(path)
        # A missing or invalid explicitly requested policy is never a default policy.
        with source.open("rb") as stream:
            data = stream.read(16_385)
        if len(data) > 16_384:
            raise ValueError("config_too_large")
        raw = json.loads(data.decode("utf-8"), object_pairs_hook=_unique_object)
    if type(raw) is not dict:
        raise ValueError("config_must_be_object")
    if "permissions" in raw:
        if set(raw) - {"$schema", "version", "security_level", "permissions", "audit_trail"}:
            raise ValueError("unknown_config_field")
        raw = raw["permissions"]
    if type(raw) is not dict or set(raw) - set(DEFAULTS):
        raise ValueError("unknown_permission")
    config = {**DEFAULTS, **raw}
    config["max_spend_usdc_per_call"] = str(money(config["max_spend_usdc_per_call"]))
    for key in set(DEFAULTS) - {"max_spend_usdc_per_call"}:
        if type(config[key]) is not bool:
            raise ValueError("permission_must_be_boolean")
    return MappingProxyType(config)


def public_receipt(receipt: Any) -> dict[str, str]:
    """Allowlist a small display projection, not the original/verifiable receipt.

    No input ID, free-form message, nested field, signature, hash, or address is
    reflected. Original signed evidence must be retained separately by the host.
    This projection is intentionally lossy and must never be used for verification.
    """
    if type(receipt) is not dict:
        return {"projection": "receipt_display_only"}
    result = {"projection": "receipt_display_only"}
    if receipt.get("status") in ("recorded", "blocked", "failed", "pending", "completed"):
        result["status"] = receipt["status"]
    return result


class ClaudeAgentSdkGatingAdapter:
    def __init__(self, permissions_config_path: Optional[str] = None):
        self.permissions = load_permissions(permissions_config_path)

    def verify_tool_permission(self, tool_name: str, args: dict[str, Any]) -> Tuple[bool, str]:
        """Compatibility tuple. A pending approval ALWAYS has allowed=False.

        Even a disabled HITL preference does not open a payment path. Unknown
        tools (including arbitrary MCP prefixes) fail closed. Read preflight is
        not remote access authorization or proof of a host boundary.
        """
        if type(tool_name) is not str or type(args) is not dict:
            return False, "Invalid_Tool_Input"
        if tool_name in READ_TOOLS:
            return True, "Read_Only_Preflight"
        if tool_name not in EXECUTE_TOOLS:
            return False, "Unsupported_Tool"
        constraints = args.get("constraints")
        if type(constraints) is not dict or "max_cost_usdc" not in constraints:
            return False, "Invalid_Spend_Cap"
        try:
            requested = money(constraints["max_cost_usdc"])
        except ValueError:
            return False, "Invalid_Spend_Cap"
        if requested > money(self.permissions["max_spend_usdc_per_call"]):
            return False, "Denied_Spend_Limit_Exceeded"
        data = args.get("input_data", {})
        if type(data) is not dict:
            return False, "Invalid_Tool_Input"
        if "read_local_files" in data:
            if type(data["read_local_files"]) is not bool:
                return False, "Invalid_Tool_Input"
            if data["read_local_files"] and not self.permissions["allow_file_access_before_execution"]:
                return False, "Denied_File_Access_Blocked"
        if self.permissions["require_hitl_for_spend"]:
            return False, "Approval_Required"
        return False, "Paid_Execution_Unavailable"

    async def pre_tool_use(self, input_data: dict[str, Any], tool_use_id: Any = None,
                           context: Any = None) -> dict[str, Any]:
        """SDK callback. Deny pending work rather than relying on a textual warning.

        An allowed preflight returns no permission override, preserving other
        host permission checks. This callback never dispatches the operation.
        """
        if type(input_data) is not dict or input_data.get("hook_event_name") != "PreToolUse":
            allowed, status = False, "Invalid_Hook_Input"
        else:
            allowed, status = self.verify_tool_permission(
                input_data.get("tool_name"), input_data.get("tool_input"))
        if allowed:
            return {}
        return {"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "deny",
            "permissionDecisionReason": status,
        }}

    def sdk_hooks(self) -> dict[str, Any]:
        """Explicit opt-in registration; importing this file starts no SDK or network."""
        from claude_agent_sdk import HookMatcher
        return {"PreToolUse": [HookMatcher(matcher=None, hooks=[self.pre_tool_use])]}

    def handle_post_execution(self, result: dict[str, Any]) -> dict[str, Any]:
        """Replace only the receipt projection; not a general output/PII filter.

        A legacy publication preference cannot authorize disclosure. No original
        receipt is modified, logged, published, or represented as verified here.
        """
        if type(result) is not dict:
            raise ValueError("result_must_be_object")
        return {**result, "receipt": public_receipt(result.get("receipt"))}


if __name__ == "__main__":
    adapter = ClaudeAgentSdkGatingAdapter()
    allowed, status = adapter.verify_tool_permission(
        "agoragentic_execute", {"constraints": {"max_cost_usdc": "0.15"}})
    if allowed or status != "Approval_Required":
        raise RuntimeError("offline_verification_fail_open")
    print(json.dumps({"allowed": allowed, "status": status, "network_calls": 0}))
