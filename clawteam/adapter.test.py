import json
import os
import unittest
from decimal import Decimal
from unittest.mock import patch

from agoragentic_clawteam import AgoragenticClawTeamAdapter, AgoragenticClawTeamError


class FakeTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout, max_response_bytes):
        self.calls.append(
            {
                "method": method,
                "url": url,
                "headers": headers,
                "body": json.loads(body) if body else None,
                "timeout": timeout,
                "max_response_bytes": max_response_bytes,
            }
        )
        status, payload = self.responses.pop(0)
        return status, json.dumps(payload).encode()


class AgoragenticClawTeamAdapterTests(unittest.TestCase):
    def test_api_key_is_required(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(AgoragenticClawTeamError, "AGORAGENTIC_API_KEY"):
                AgoragenticClawTeamAdapter()

    def test_remote_base_url_is_pinned(self):
        with self.assertRaisesRegex(AgoragenticClawTeamError, "must be https://agoragentic.com"):
            AgoragenticClawTeamAdapter(api_key="placeholder", base_url="https://example.com")

    def test_default_execute_previews_and_enforces_zero_cost(self):
        transport = FakeTransport(
            [
                (200, {"providers": [{"id": "free", "price": 0}]}),
                (200, {"result": {"echo": "ok"}, "receipt_id": "redacted"}),
            ]
        )
        adapter = AgoragenticClawTeamAdapter(api_key="placeholder", transport=transport)

        result = adapter.execute("echo", {"text": "hello"})

        self.assertEqual(result["result"], {"echo": "ok"})
        self.assertEqual([call["method"] for call in transport.calls], ["GET", "POST"])
        self.assertIn("max_cost=0", transport.calls[0]["url"])
        self.assertEqual(transport.calls[1]["body"]["constraints"], {"max_cost": "0"})
        self.assertNotIn("placeholder", json.dumps(result))

    def test_positive_cap_requires_separate_paid_authority(self):
        transport = FakeTransport([])
        adapter = AgoragenticClawTeamAdapter(api_key="placeholder", transport=transport)

        with self.assertRaisesRegex(AgoragenticClawTeamError, "allow_paid=True"):
            adapter.execute("summarize", {}, max_cost_usdc="0.01")

        self.assertEqual(transport.calls, [])

    def test_paid_execution_stays_inside_cap(self):
        transport = FakeTransport(
            [
                (200, {"providers": [{"id": "paid", "price_usdc": "0.01"}]}),
                (200, {"result": "done", "receipt_id": "redacted"}),
            ]
        )
        adapter = AgoragenticClawTeamAdapter(api_key="placeholder", transport=transport)

        adapter.execute("summarize", {}, max_cost_usdc=Decimal("0.01"), allow_paid=True)

        self.assertEqual(transport.calls[1]["body"]["constraints"]["max_cost"], "0.01")

    def test_unknown_price_fails_closed_before_execute(self):
        transport = FakeTransport([(200, {"providers": [{"id": "mystery"}]})])
        adapter = AgoragenticClawTeamAdapter(api_key="placeholder", transport=transport)

        with self.assertRaisesRegex(AgoragenticClawTeamError, "bounded price"):
            adapter.execute("echo", {})

        self.assertEqual(len(transport.calls), 1)

    def test_response_byte_cap_is_rechecked_for_injected_transports(self):
        def oversized(*_args):
            return 200, b"{" + (b"x" * 20) + b"}"

        adapter = AgoragenticClawTeamAdapter(
            api_key="placeholder",
            transport=oversized,
            max_response_bytes=10,
        )
        with self.assertRaisesRegex(AgoragenticClawTeamError, "byte cap"):
            adapter.match("echo")


if __name__ == "__main__":
    unittest.main()
