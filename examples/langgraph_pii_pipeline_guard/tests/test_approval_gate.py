import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from agoragentic_guard import guard_tool_call
from capabilities import load_policy


def test_external_send_requires_approval_and_does_not_execute():
    policy = load_policy(ROOT / "policies" / "pipeline_policy.yaml")
    decision = guard_tool_call(
        "send_email_to_customer",
        {"_masking_applied": True, "summary": "masked summary"},
        policy,
    )

    assert decision["decision"] == "approval_required"
    assert decision["executed"] is False
    assert "human approval" in decision["reason"].lower()
