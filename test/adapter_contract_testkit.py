"""Shared hermetic fixtures for standalone Python adapter contract tests."""

import json
from pathlib import Path


CONTRACT_PATH = Path(__file__).with_name("fixtures") / "python-adapter-response-contract.v1.json"
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


class StubResponse:
    """Minimal requests-compatible response that records JSON decode count."""

    def __init__(self, status_code, payload=None, raw_body=None):
        self.status_code = status_code
        self.payload = payload
        self.raw_body = raw_body
        self.json_calls = 0

    def json(self):
        self.json_calls += 1
        if self.raw_body is not None:
            return json.loads(self.raw_body)
        return self.payload


def load_testkit():
    """Return the immutable-by-convention shared contract and response stub."""
    return CONTRACT, StubResponse
