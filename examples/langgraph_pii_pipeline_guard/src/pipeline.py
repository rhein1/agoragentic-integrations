"""Three-node LangGraph customer ticket pipeline wrapped by local guard policy."""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any, Dict, List

try:
    from .agoragentic_guard import create_receipt, guard_model_input, guard_tool_call
    from .capabilities import load_policy
    from .mock_tools import run_mock_tool, simulated_model_call
except ImportError:  # pragma: no cover - supports `python src/pipeline.py`.
    from agoragentic_guard import create_receipt, guard_model_input, guard_tool_call
    from capabilities import load_policy
    from mock_tools import run_mock_tool, simulated_model_call


BASE_DIR = Path(__file__).resolve().parents[1]


def load_records(data_path: Path | str) -> List[Dict[str, str]]:
    with Path(data_path).open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def classify_record_node(state: Dict[str, Any]) -> Dict[str, Any]:
    guarded = guard_model_input(state["record"], state["policy"])
    if not guarded["allowed"]:
        raise RuntimeError(guarded["reason"])
    masked_record = guarded["masked_input"]
    model_result = simulated_model_call("classify_record", masked_record)
    return {
        **state,
        "masked_record": masked_record,
        "classification": model_result["classification"],
        "nodes_executed": state.get("nodes_executed", []) + ["classify_record"],
        "model_inputs": state.get("model_inputs", []) + [masked_record],
        "redaction_events": state.get("redaction_events", []) + [guarded["evidence"]["redactions"]],
    }


def summarize_record_node(state: Dict[str, Any]) -> Dict[str, Any]:
    model_result = simulated_model_call("summarize_record", state["masked_record"])
    return {
        **state,
        "summary": model_result["summary"],
        "nodes_executed": state.get("nodes_executed", []) + ["summarize_record"],
        "model_inputs": state.get("model_inputs", []) + [state["masked_record"]],
        "summaries": state.get("summaries", []) + [model_result["summary"]],
    }


def route_action_node(state: Dict[str, Any]) -> Dict[str, Any]:
    tool_name = state["masked_record"].get("requested_action", "unknown")
    payload = {
        "_masking_applied": state["masked_record"].get("_masking_applied") is True,
        "customer_id": state["masked_record"].get("customer_id"),
        "classification": state["classification"],
        "summary": state["summary"],
    }
    decision = guard_tool_call(tool_name, payload, state["policy"])
    tool_result = run_mock_tool(tool_name, payload) if decision["decision"] == "allow" else None
    return {
        **state,
        "nodes_executed": state.get("nodes_executed", []) + ["route_action"],
        "tool_payloads": state.get("tool_payloads", []) + [payload],
        "tool_decisions": state.get("tool_decisions", []) + [decision],
        "tool_results": state.get("tool_results", []) + ([tool_result] if tool_result else []),
    }


def _run_sequential_graph(state: Dict[str, Any]) -> Dict[str, Any]:
    state = classify_record_node(state)
    state = summarize_record_node(state)
    return route_action_node(state)


def _run_langgraph_or_fallback(state: Dict[str, Any]) -> Dict[str, Any]:
    try:
        from langgraph.graph import StateGraph
    except Exception:
        return _run_sequential_graph(state)

    graph = StateGraph(dict)
    graph.add_node("classify_record", classify_record_node)
    graph.add_node("summarize_record", summarize_record_node)
    graph.add_node("route_action", route_action_node)
    graph.set_entry_point("classify_record")
    graph.add_edge("classify_record", "summarize_record")
    graph.add_edge("summarize_record", "route_action")
    graph.set_finish_point("route_action")
    return graph.compile().invoke(state)


def run_pipeline(
    data_path: Path | str = BASE_DIR / "data" / "customers.csv",
    policy_path: Path | str = BASE_DIR / "policies" / "pipeline_policy.yaml",
    receipt_path: Path | str = BASE_DIR / "out" / "receipt.json",
    run_id: str = "example_run_id",
) -> Dict[str, Any]:
    policy = load_policy(policy_path)
    records = load_records(data_path)
    aggregate_state: Dict[str, Any] = {
        "pipeline_name": policy["pipeline_name"],
        "policy_version": policy["policy_version"],
        "run_id": run_id,
        "records_processed": len(records),
        "model_inputs": [],
        "summaries": [],
        "tool_payloads": [],
        "tool_decisions": [],
        "tool_results": [],
        "redaction_events": [],
        "nodes_executed": [],
    }

    for record in records:
        record_state = _run_langgraph_or_fallback({"record": record, "policy": policy})
        for key in ("model_inputs", "summaries", "tool_payloads", "tool_decisions", "tool_results", "redaction_events"):
            aggregate_state[key].extend(record_state.get(key, []))
        aggregate_state["nodes_executed"].append(record_state.get("nodes_executed", []))

    receipt = create_receipt(aggregate_state)
    receipt_output = Path(receipt_path)
    receipt_output.parent.mkdir(parents=True, exist_ok=True)
    receipt_output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    aggregate_state["receipt"] = receipt
    aggregate_state["receipt_path"] = str(receipt_output)
    return aggregate_state


def main() -> None:
    state = run_pipeline()
    print(json.dumps(state["receipt"], indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
