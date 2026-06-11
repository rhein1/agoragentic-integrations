import copy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from receipts import create_run_receipt


def _run_state():
    return {
        "pipeline_name": "langgraph_customer_ticket_guard_demo",
        "run_id": "example_run_id",
        "policy_version": "local_demo_v1",
        "records_processed": 2,
        "redaction_events": [{"email": 2, "phone": 2, "account_id": 2, "customer_id": 2, "name": 2}],
        "model_inputs": [{"masked": True}, {"masked": True}, {"masked": True}, {"masked": True}],
        "tool_decisions": [
            {"tool_name": "export_raw_rows", "decision": "deny", "reason": "Raw PII export is not allowed by policy"},
            {"tool_name": "send_email_to_customer", "decision": "approval_required", "reason": "External send requires human approval"},
        ],
    }


def test_receipt_schema_and_hash_are_stable():
    receipt = create_run_receipt(_run_state())
    repeated = create_run_receipt(copy.deepcopy(_run_state()))

    assert receipt == repeated
    assert receipt["pipeline_name"] == "langgraph_customer_ticket_guard_demo"
    assert receipt["run_id"] == "example_run_id"
    assert receipt["policy_version"] == "local_demo_v1"
    assert receipt["records_processed"] == 2
    assert receipt["pii_detected"] is True
    assert receipt["model_calls_guarded"] == 4
    assert receipt["approval_required"] is True
    assert receipt["denied_actions"] == 1
    assert receipt["external_services_called"] is False
    assert receipt["raw_pii_exported"] is False
    assert receipt["receipt_hash"].startswith("sha256:")
