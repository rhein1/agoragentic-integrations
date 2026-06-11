import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from capabilities import guard_tool_decision, load_policy


POLICY = load_policy(ROOT / "policies" / "pipeline_policy.yaml")


def test_allowed_tool_requires_masked_payload():
    denied = guard_tool_decision("summarize_ticket", {"_masking_applied": False}, POLICY)
    allowed = guard_tool_decision("summarize_ticket", {"_masking_applied": True}, POLICY)

    assert denied["decision"] == "deny"
    assert allowed["decision"] == "allow"
    assert allowed["executed"] is True


def test_raw_export_and_unknown_tools_are_denied():
    export_decision = guard_tool_decision("export_raw_rows", {"_masking_applied": True}, POLICY)
    unknown_decision = guard_tool_decision("upload_all_rows", {"_masking_applied": True}, POLICY)

    assert export_decision["decision"] == "deny"
    assert "Raw PII export" in export_decision["reason"]
    assert unknown_decision["decision"] == "deny"
    assert unknown_decision["executed"] is False
