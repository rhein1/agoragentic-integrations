from __future__ import annotations

import unittest

from agoragentic_matraix_assurance.contracts import ContractError
from agoragentic_matraix_assurance.redaction import (
    assert_public_safe,
    redact_for_public,
)


class RedactionTests(unittest.TestCase):
    def test_secret_shapes_are_removed_without_losing_safe_summary(self):
        value = {
            "summary": "bounded failure observation",
            "authorization": "Bearer abcdefghijklmnopqrstuvwxyz",
            "nested": {"note": "provider key sk-abcdefghijklmnop"},
        }
        redacted = redact_for_public(value)
        self.assertEqual(redacted["summary"], value["summary"])
        self.assertNotIn("authorization", redacted)
        self.assertNotIn("sk-", redacted["nested"]["note"])
        assert_public_safe(redacted)

    def test_sensitive_fields_and_values_are_rejected(self):
        for payload in (
            {"raw_persona": {"name": "Example"}},
            {"summary": "Bearer abcdefghijklmnopqrstuvwxyz"},
            {"connection": "postgres://user:pass@example.test/db"},
        ):
            with self.subTest(payload=payload), self.assertRaises(ContractError):
                assert_public_safe(payload)


if __name__ == "__main__":
    unittest.main()
