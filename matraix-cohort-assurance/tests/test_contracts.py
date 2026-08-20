from __future__ import annotations

import copy
import unittest

from agoragentic_matraix_assurance.contracts import (
    ALL_REPRESENTATION_FALSE,
    ContractError,
    validate_task_packet,
)
from agoragentic_matraix_assurance.runner import DEFAULT_TASK_DIR, load_task_packet


class ContractTests(unittest.TestCase):
    def setUp(self):
        packet = load_task_packet(DEFAULT_TASK_DIR)
        self.task = copy.deepcopy(packet["task"])
        self.strategy = copy.deepcopy(packet["strategy"])
        self.reporting = copy.deepcopy(packet["reporting"])

    def assert_code(self, code: str, task=None, strategy=None, reporting=None):
        with self.assertRaises(ContractError) as caught:
            validate_task_packet(
                task or self.task,
                strategy or self.strategy,
                reporting or self.reporting,
            )
        self.assertEqual(caught.exception.code, code)

    def test_closed_fixture_contract_is_valid(self):
        packet = validate_task_packet(self.task, self.strategy, self.reporting)
        self.assertEqual(
            packet["strategy"]["representation_boundary"], ALL_REPRESENTATION_FALSE
        )

    def test_intended_use_is_required_and_closed(self):
        missing = copy.deepcopy(self.task)
        missing["intended_use"] = ""
        self.assert_code("intended_use_missing", task=missing)
        disallowed = copy.deepcopy(self.task)
        disallowed["intended_use"] = "market_research"
        self.assert_code("intended_use_not_allowed", task=disallowed)

    def test_prohibited_purposes_fail_before_execution(self):
        cases = {
            "what customers want": "human_preference_inference_prohibited",
            "whether people would buy this": "market_demand_inference_prohibited",
            "approve a policy": "legal_or_policy_use_prohibited",
            "run a synthetic jury": "deliberative_authority_claim_prohibited",
            "represent the affected community": "community_voice_claim_prohibited",
            "infer consent": "consent_inference_prohibited",
            "report lived experience": "lived_experience_claim_prohibited",
            "set pricing by demographic": "consequential_demographic_use_prohibited",
        }
        for instruction, code in cases.items():
            with self.subTest(instruction=instruction):
                task = copy.deepcopy(self.task)
                task["instruction"] = instruction
                self.assert_code(code, task=task)

    def test_every_representation_flag_must_be_present_and_false(self):
        for field in ALL_REPRESENTATION_FALSE:
            with self.subTest(field=field):
                strategy = copy.deepcopy(self.strategy)
                strategy["representation_boundary"][field] = True
                with self.assertRaises(ContractError):
                    validate_task_packet(self.task, strategy, self.reporting)
        missing = copy.deepcopy(self.strategy)
        missing["representation_boundary"].pop("community_voice_claimed")
        self.assert_code("required_field_missing", strategy=missing)

    def test_unknown_security_fields_and_claim_expansion_fail(self):
        strategy = copy.deepcopy(self.strategy)
        strategy["dataset"]["private_demographics"] = True
        self.assert_code("unknown_security_field", strategy=strategy)
        reporting = copy.deepcopy(self.reporting)
        reporting["claim_scope"]["supported_claim_types"].append("market_demand")
        self.assert_code("claim_scope_exceeds_synthetic_evidence", reporting=reporting)

    def test_limits_and_required_limitations_fail_closed(self):
        task = copy.deepcopy(self.task)
        task["limits"]["max_trials"] = 33
        self.assert_code("sample_size_above_policy", task=task)
        reporting = copy.deepcopy(self.reporting)
        reporting["limitations"].pop()
        self.assert_code("required_limitation_missing", reporting=reporting)


if __name__ == "__main__":
    unittest.main()
