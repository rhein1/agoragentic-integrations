"""Deterministic PII masking for the LangGraph guard demo."""

from __future__ import annotations

import re
from collections import Counter
from typing import Dict, Iterable, Tuple


MASKS = {
    "email": "[EMAIL_REDACTED]",
    "phone": "[PHONE_REDACTED]",
    "account_id": "[ACCOUNT_ID_REDACTED]",
    "customer_id": "[CUSTOMER_ID_REDACTED]",
    "name": "[NAME_REDACTED]",
}

EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
PHONE_RE = re.compile(r"\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b")
ACCOUNT_RE = re.compile(r"\bACCT-\d{4,}\b")
CUSTOMER_RE = re.compile(r"\bCUST-\d{3,}\b")


def raw_pii_values(record: Dict[str, str]) -> Dict[str, str]:
    """Return direct identifier values from a source record."""
    return {
        key: str(record.get(key, "")).strip()
        for key in ("email", "phone", "account_id", "customer_id", "name")
        if str(record.get(key, "")).strip()
    }


def _replace_known_value(text: str, value: str, token: str) -> Tuple[str, int]:
    if not value:
        return text, 0
    count = text.count(value)
    if count:
        text = text.replace(value, token)
    return text, count


def mask_text(text: str, record: Dict[str, str]) -> Tuple[str, Counter]:
    """Mask PII in arbitrary text using record-aware values and regex fallback."""
    masked = str(text)
    counts: Counter = Counter()
    raw_values = raw_pii_values(record)

    for kind, field in (
        ("email", "email"),
        ("phone", "phone"),
        ("account_id", "account_id"),
        ("customer_id", "customer_id"),
        ("name", "name"),
    ):
        masked, replaced = _replace_known_value(masked, raw_values.get(field, ""), MASKS[kind])
        counts[kind] += replaced

    regexes = (
        ("email", EMAIL_RE, MASKS["email"]),
        ("phone", PHONE_RE, MASKS["phone"]),
        ("account_id", ACCOUNT_RE, MASKS["account_id"]),
        ("customer_id", CUSTOMER_RE, MASKS["customer_id"]),
    )
    for kind, pattern, token in regexes:
        masked, replaced = pattern.subn(token, masked)
        counts[kind] += replaced

    return masked, counts


def mask_record(record: Dict[str, str]) -> Dict[str, object]:
    """Return a masked record and redaction metadata without storing raw values."""
    masked: Dict[str, str] = {}
    redactions: Counter = Counter()

    for key, value in record.items():
        if key in ("email", "phone", "account_id", "customer_id", "name"):
            masked[key] = MASKS[key]
            if str(value).strip():
                redactions[key] += 1
            continue

        masked_value, counts = mask_text(str(value), record)
        masked[key] = masked_value
        redactions.update(counts)

    masked["_masking_applied"] = True
    return {
        "masked_record": masked,
        "redactions": dict(redactions),
        "pii_detected": any(count > 0 for count in redactions.values()),
    }


def contains_raw_pii(text: object, raw_values: Iterable[str]) -> bool:
    """Check whether any known raw identifier is present in a public-safe value."""
    serialized = str(text)
    return any(value and value in serialized for value in raw_values)
