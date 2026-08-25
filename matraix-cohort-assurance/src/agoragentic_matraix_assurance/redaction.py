"""Public-safe redaction and secret-shape rejection."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

from .contracts import ContractError

_SENSITIVE_KEY = re.compile(
    r"(^|_)(api[_-]?key|authorization|cookie|password|private[_-]?key|secret|token|wallet|raw[_-]?persona|transcript|customer[_-]?pii)($|_)",
    re.IGNORECASE,
)
_SECRET_VALUE = re.compile(
    r"(?i)(bearer\s+[a-z0-9._~+/=-]{12,}|github_pat_[a-z0-9_]{20,}|sk-[a-z0-9_-]{16,}|(?:postgres|mysql|mongodb(?:\+srv)?):\/\/[^\s]+|https?:\/\/[^\s/?#]+\?[^\s]*(?:token|key|secret|password)=)",
)
_PROHIBITED_PUBLIC_KEYS = frozenset(
    {
        "raw_persona",
        "raw_personas",
        "raw_sensitive_attributes",
        "full_transcript",
        "provider_response",
        "customer_pii",
        "private_ecf",
        "payment_secret",
        "settlement_secret",
    }
)


def redact_for_public(value: Any) -> Any:
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for key, item in value.items():
            if _SENSITIVE_KEY.search(str(key)):
                continue
            result[str(key)] = redact_for_public(item)
        return result
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [redact_for_public(item) for item in value]
    if isinstance(value, str):
        return _SECRET_VALUE.sub("[REDACTED]", value)
    return value


def assert_public_safe(value: Any, path: str = "$") -> None:
    if isinstance(value, Mapping):
        for key, item in value.items():
            key_text = str(key)
            declarative_false = item is False and key_text.endswith(
                ("_claimed", "_granted")
            )
            if key_text.lower() in _PROHIBITED_PUBLIC_KEYS or (
                _SENSITIVE_KEY.search(key_text) and not declarative_false
            ):
                raise ContractError(
                    "public_artifact_sensitive_field", f"{path}.{key_text}"
                )
            assert_public_safe(item, f"{path}.{key_text}")
        return
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for index, item in enumerate(value):
            assert_public_safe(item, f"{path}[{index}]")
        return
    if isinstance(value, str) and _SECRET_VALUE.search(value):
        raise ContractError("secret_shaped_public_material", path)
