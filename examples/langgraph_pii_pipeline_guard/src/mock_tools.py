"""Local-only simulated model and tool calls for the demo pipeline."""

from __future__ import annotations

from typing import Any, Dict


def simulated_model_call(kind: str, masked_record: Dict[str, Any]) -> Dict[str, str]:
    """Return deterministic model-like output from masked input only."""
    text = f"{masked_record.get('ticket_text', '')} {masked_record.get('requested_action', '')}".lower()
    if kind == "classify_record":
        if "billing" in text or "invoice" in text:
            category = "billing"
        elif "access" in text or "login" in text:
            category = "account access"
        elif "cancellation" in text or "complaint" in text:
            category = "cancellation risk"
        elif "operational" in text or "escalation" in text:
            category = "operational issue"
        else:
            category = "complaint"
        return {"classification": category}

    if kind == "summarize_record":
        return {
            "summary": (
                f"{masked_record.get('customer_id')} has a {masked_record.get('ticket_priority')} "
                f"priority {masked_record.get('requested_action')} request. Direct identifiers are masked."
            )
        }

    raise ValueError(f"Unsupported simulated model call: {kind}")


def run_mock_tool(tool_name: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Execute only local mock tools after policy has allowed the action."""
    return {
        "tool_name": tool_name,
        "status": "mock_executed",
        "external_service_called": False,
        "payload_summary": {
            "classification": payload.get("classification"),
            "summary_present": bool(payload.get("summary")),
        },
    }
