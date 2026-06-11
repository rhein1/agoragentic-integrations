"""Public-safe receipt generation for the LangGraph guard demo."""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from typing import Any, Dict, Iterable, List


def _stable_hash(payload: Dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _compact_decisions(decisions: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    compact: List[Dict[str, Any]] = []
    seen = set()
    for decision in decisions:
        key = (decision.get("tool_name"), decision.get("decision"), decision.get("reason"))
        if key in seen:
            continue
        seen.add(key)
        compact.append(
            {
                "tool_name": decision.get("tool_name"),
                "decision": decision.get("decision"),
                "reason": decision.get("reason"),
            }
        )
    return compact


def create_run_receipt(run_state: Dict[str, Any]) -> Dict[str, Any]:
    """Create a deterministic, redacted receipt for the pipeline run."""
    redaction_totals: Counter = Counter()
    for counts in run_state.get("redaction_events", []):
        redaction_totals.update(counts)

    tool_decisions = list(run_state.get("tool_decisions", []))
    receipt = {
        "pipeline_name": run_state["pipeline_name"],
        "run_id": run_state["run_id"],
        "policy_version": run_state["policy_version"],
        "records_processed": run_state["records_processed"],
        "pii_detected": bool(redaction_totals),
        "redactions_applied": dict(sorted(redaction_totals.items())),
        "model_calls_guarded": len(run_state.get("model_inputs", [])),
        "tool_decisions": _compact_decisions(tool_decisions),
        "approval_required": any(item.get("decision") == "approval_required" for item in tool_decisions),
        "denied_actions": sum(1 for item in tool_decisions if item.get("decision") == "deny"),
        "external_services_called": False,
        "raw_pii_exported": False,
    }
    receipt["receipt_hash"] = _stable_hash(receipt)
    return receipt
