import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from pii import contains_raw_pii, raw_pii_values
from pipeline import load_records, run_pipeline


def test_pipeline_processes_three_nodes_and_keeps_pii_out_of_public_artifacts(tmp_path):
    data_path = ROOT / "data" / "customers.csv"
    receipt_path = tmp_path / "receipt.json"
    state = run_pipeline(
        data_path=data_path,
        policy_path=ROOT / "policies" / "pipeline_policy.yaml",
        receipt_path=receipt_path,
    )
    records = load_records(data_path)
    raw_values = []
    for record in records:
        raw_values.extend(raw_pii_values(record).values())

    public_artifacts = {
        "model_inputs": state["model_inputs"],
        "summaries": state["summaries"],
        "tool_payloads": state["tool_payloads"],
        "receipt": state["receipt"],
    }
    assert state["records_processed"] == 10
    assert all(nodes == ["classify_record", "summarize_record", "route_action"] for nodes in state["nodes_executed"])
    assert not contains_raw_pii(json.dumps(public_artifacts, sort_keys=True), raw_values)
    assert any(decision["decision"] == "deny" and decision["tool_name"] == "export_raw_rows" for decision in state["tool_decisions"])
    assert any(decision["decision"] == "approval_required" and decision["tool_name"] == "send_email_to_customer" for decision in state["tool_decisions"])
    assert receipt_path.exists()
    assert json.loads(receipt_path.read_text(encoding="utf-8")) == state["receipt"]
