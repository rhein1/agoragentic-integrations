from __future__ import annotations

import copy
import unittest

from agoragentic_matraix_assurance.manifest import load_json
from agoragentic_matraix_assurance.runner import DEFAULT_TASK_DIR
from agoragentic_matraix_assurance.target import (
    TargetPolicyError,
    validate_target_config,
    validate_target_response,
)

TARGET = DEFAULT_TASK_DIR / "target_config.example.json"


class TargetPolicyTests(unittest.TestCase):
    def setUp(self):
        self.config = load_json(TARGET)
        self.response = {
            "http_status": 200,
            "price_usdc": 0,
            "target_version": "fixture-v1",
            "receipt": {
                "schema": "agoragentic.synthetic-cohort-target-receipt.v1",
                "receipt_id": "fixture-receipt-001",
                "capability_path": "/mcp/resolution-desk",
                "target_version": "fixture-v1",
            },
        }

    def assert_code(self, code: str, config=None, response=None):
        with self.assertRaises(TargetPolicyError) as caught:
            if response is None:
                validate_target_config(config or self.config)
            else:
                validate_target_response(config or self.config, response)
        self.assertEqual(caught.exception.code, code)

    def test_loopback_free_receipted_target_is_valid(self):
        self.assertEqual(validate_target_config(self.config)["price_usdc"], 0)
        self.assertEqual(
            validate_target_response(self.config, self.response)["http_status"], 200
        )

    def test_remote_host_requires_https_owner_allowlist(self):
        config = copy.deepcopy(self.config)
        config["base_url"] = "https://example.test"
        self.assert_code("target_host_not_allowlisted", config=config)
        config["allowlisted_hosts"] = ["example.test"]
        self.assertEqual(
            validate_target_config(config)["base_url"], "https://example.test"
        )
        config["base_url"] = "http://example.test"
        self.assert_code("target_host_not_allowlisted", config=config)

    def test_price_payment_receipt_route_and_version_fail_closed(self):
        config = copy.deepcopy(self.config)
        config["price_usdc"] = 0.01
        self.assert_code("nonzero_price_prohibited", config=config)
        for mutation, code in (
            (("http_status", 402), "payment_challenge_prohibited"),
            (("price_usdc", 1), "nonzero_price_prohibited"),
            (("target_version", "changed"), "target_version_changed"),
            (("receipt", None), "target_receipt_missing"),
        ):
            response = copy.deepcopy(self.response)
            response[mutation[0]] = mutation[1]
            self.assert_code(code, response=response)
        response = copy.deepcopy(self.response)
        response["receipt"]["capability_path"] = "/different"
        self.assert_code("target_route_drift", response=response)

    def test_authority_cannot_be_enabled(self):
        config = copy.deepcopy(self.config)
        config["authority"]["payment_authority_granted"] = True
        self.assert_code("authority_grant_prohibited", config=config)


if __name__ == "__main__":
    unittest.main()
