"""Capability policy loading and tool-call decisions for the local demo."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict


def _parse_scalar(value: str) -> Any:
    value = value.strip()
    if value.lower() == "true":
        return True
    if value.lower() == "false":
        return False
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    return value


def load_policy(policy_path: Path | str) -> Dict[str, Any]:
    """Load the demo YAML policy using a tiny parser for this fixed file shape."""
    root: Dict[str, Any] = {}
    stack = [(-1, root)]
    for raw_line in Path(policy_path).read_text(encoding="utf-8").splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        key, separator, value = raw_line.strip().partition(":")
        if not separator:
            raise ValueError(f"Invalid policy line: {raw_line}")
        while stack and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]
        if value.strip():
            parent[key] = _parse_scalar(value)
        else:
            child: Dict[str, Any] = {}
            parent[key] = child
            stack.append((indent, child))
    return root


def guard_tool_decision(tool_name: str, payload: Dict[str, Any], policy: Dict[str, Any]) -> Dict[str, Any]:
    """Return allow, deny, or approval_required before a mock tool can run."""
    capabilities = policy.get("capabilities", {})
    rule = capabilities.get(tool_name)
    if not rule:
        return {
            "tool_name": tool_name,
            "decision": "deny",
            "reason": "Unknown tools are denied by default",
            "executed": False,
        }

    decision = rule.get("decision", "deny")
    requires_masking = rule.get("requires_masking") is True
    if requires_masking and payload.get("_masking_applied") is not True:
        return {
            "tool_name": tool_name,
            "decision": "deny",
            "reason": "Masked payload required before this tool can execute",
            "executed": False,
        }

    if decision == "allow":
        return {
            "tool_name": tool_name,
            "decision": "allow",
            "reason": "Allowed by local demo policy",
            "executed": True,
        }

    if decision == "approval_required":
        return {
            "tool_name": tool_name,
            "decision": "approval_required",
            "reason": rule.get("reason", "Human approval required"),
            "executed": False,
        }

    return {
        "tool_name": tool_name,
        "decision": "deny",
        "reason": rule.get("reason", "Denied by local demo policy"),
        "executed": False,
    }
