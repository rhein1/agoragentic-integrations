"""Agoragentic-style local guard layer for a LangGraph pipeline run."""

from __future__ import annotations

from typing import Any, Dict

try:
    from .capabilities import guard_tool_decision
    from .pii import mask_record
    from .receipts import create_run_receipt
except ImportError:  # pragma: no cover - supports running pipeline.py directly.
    from capabilities import guard_tool_decision
    from pii import mask_record
    from receipts import create_run_receipt


def guard_model_input(record: Dict[str, str], policy: Dict[str, Any]) -> Dict[str, Any]:
    """Return masked input and evidence metadata before a simulated model call."""
    if policy.get("privacy", {}).get("pii_masking_required") is not True:
        return {
            "allowed": False,
            "reason": "PII masking is required for this demo policy",
            "masked_input": {},
            "evidence": {"pii_detected": False, "redactions": {}},
        }

    masked = mask_record(record)
    return {
        "allowed": True,
        "reason": "PII masked before simulated model call",
        "masked_input": masked["masked_record"],
        "evidence": {
            "pii_detected": masked["pii_detected"],
            "redactions": masked["redactions"],
        },
    }


def guard_tool_call(tool_name: str, payload: Dict[str, Any], policy: Dict[str, Any]) -> Dict[str, Any]:
    """Return an allow, deny, or approval_required decision before tool execution."""
    return guard_tool_decision(tool_name, payload, policy)


def create_receipt(run_state: Dict[str, Any]) -> Dict[str, Any]:
    """Return the final public-safe receipt for the guarded run."""
    return create_run_receipt(run_state)
