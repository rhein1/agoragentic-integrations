import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from pii import contains_raw_pii, mask_record, raw_pii_values


def test_masks_direct_identifiers_and_ticket_text():
    record = {
        "customer_id": "CUST-999",
        "name": "Test Person",
        "email": "test.person@example.test",
        "phone": "555-010-9999",
        "account_id": "ACCT-9999",
        "ticket_text": "Test Person at test.person@example.test asked about ACCT-9999.",
        "ticket_priority": "high",
        "requested_action": "summarize_ticket",
    }

    result = mask_record(record)
    masked = result["masked_record"]
    raw_values = raw_pii_values(record).values()

    assert masked["email"] == "[EMAIL_REDACTED]"
    assert masked["phone"] == "[PHONE_REDACTED]"
    assert masked["account_id"] == "[ACCOUNT_ID_REDACTED]"
    assert masked["customer_id"] == "[CUSTOMER_ID_REDACTED]"
    assert masked["name"] == "[NAME_REDACTED]"
    assert not contains_raw_pii(masked, raw_values)
    assert result["pii_detected"] is True
