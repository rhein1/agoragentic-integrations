"""Closed contracts for synthetic cohort assurance tasks."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


class ContractError(ValueError):
    """A stable fail-closed contract error."""

    def __init__(self, code: str, detail: str):
        self.code = code
        super().__init__(f"{code}: {detail}")


ALLOWED_INTENDED_USES = frozenset(
    {
        "agent_behavior_qa",
        "workflow_stress_test",
        "failure_discovery",
        "mandate_compliance_test",
        "model_sensitivity_analysis",
        "ux_hypothesis_generation",
        "accessibility_hypothesis_generation",
    }
)

REPRESENTATION_FIELDS = (
    "human_participant_substitution_claimed",
    "community_voice_claimed",
    "representational_authority_claimed",
    "deliberative_authority_claimed",
    "affected_stakeholder_authorization_claimed",
    "consent_inferred_from_simulation",
    "lived_experience_claimed",
    "human_preference_inference_claimed",
    "population_inference_claimed",
    "market_demand_inference_claimed",
    "legal_or_policy_decision_use",
    "consequential_demographic_decision_use",
)
ALL_REPRESENTATION_FALSE = {field: False for field in REPRESENTATION_FIELDS}

AUTHORITY_FIELDS = (
    "wallet_authority_granted",
    "payment_authority_granted",
    "execution_authority_granted",
    "deployment_authority_granted",
    "publication_authority_granted",
    "trust_mutation_authority_granted",
    "marketplace_listing_authority_granted",
)
ALL_AUTHORITY_FALSE = {field: False for field in AUTHORITY_FIELDS}

SUPPORTED_CLAIMS = (
    "system_behavior_observation",
    "workflow_failure_observation",
    "mandate_compliance_observation",
    "model_sensitivity_observation",
)
UNSUPPORTED_CLAIMS = (
    "human_preference",
    "population_prevalence",
    "market_demand",
    "community_voice",
    "representational_legitimacy",
    "consent",
    "lived_experience",
    "policy_legitimacy",
    "legal_deliberation",
    "consequential_eligibility",
)
CLAIM_SCOPE = {
    "supported_claim_types": list(SUPPORTED_CLAIMS),
    "unsupported_claim_types": list(UNSUPPORTED_CLAIMS),
}

MANDATORY_LIMITATIONS = (
    "synthetic_model_mediated_evidence",
    "not_human_validation",
    "not_population_prevalence_estimate",
    "not_customer_demand_validation",
    "not_safety_certification",
    "synthetic_personas_do_not_represent_real_people",
    "not_human_participant_substitution",
    "not_affected_community_participation",
    "not_representational_or_deliberative_authority",
    "consent_and_lived_experience_not_inferable",
)

PUBLIC_FACETS = frozenset(
    {
        "technical_proficiency_profile",
        "interaction_complexity_profile",
        "urgency_configuration",
        "communication_detail_preference",
        "approval_requirement",
        "task_or_failure_mode_identifier",
    }
)

_PROHIBITED_PURPOSES = (
    ("human_participant_substitution_prohibited", "replace human participants"),
    ("human_participant_substitution_prohibited", "instead of human participants"),
    ("community_voice_claim_prohibited", "speak for the community"),
    ("community_voice_claim_prohibited", "represent the affected community"),
    ("affected_community_participation_required", "public consultation"),
    ("deliberative_authority_claim_prohibited", "synthetic jury"),
    ("consent_inference_prohibited", "infer consent"),
    ("lived_experience_claim_prohibited", "lived experience"),
    ("human_preference_inference_prohibited", "what customers want"),
    ("market_demand_inference_prohibited", "would buy"),
    ("market_demand_inference_prohibited", "purchase intent"),
    ("population_inference_prohibited", "population prevalence"),
    ("legal_or_policy_use_prohibited", "approve a policy"),
    ("legal_or_policy_use_prohibited", "legal decision"),
    ("consequential_demographic_use_prohibited", "eligibility by demographic"),
    ("consequential_demographic_use_prohibited", "pricing by demographic"),
)


def _require_mapping(value: Any, code: str, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ContractError(code, f"{field} must be an object")
    return value


def _require_closed(value: Mapping[str, Any], expected: set[str], field: str) -> None:
    unknown = set(value) - expected
    missing = expected - set(value)
    if unknown:
        raise ContractError(
            "unknown_security_field", f"{field} has unknown fields: {sorted(unknown)}"
        )
    if missing:
        raise ContractError(
            "required_field_missing", f"{field} is missing: {sorted(missing)}"
        )


def validate_representation_boundary(value: Any) -> dict[str, bool]:
    boundary = _require_mapping(
        value,
        "synthetic_representation_prohibited",
        "representation_boundary",
    )
    _require_closed(boundary, set(REPRESENTATION_FIELDS), "representation_boundary")
    code_by_field = {
        "human_participant_substitution_claimed": "human_participant_substitution_prohibited",
        "community_voice_claimed": "community_voice_claim_prohibited",
        "representational_authority_claimed": "representational_authority_claim_prohibited",
        "deliberative_authority_claimed": "deliberative_authority_claim_prohibited",
        "affected_stakeholder_authorization_claimed": "affected_community_participation_required",
        "consent_inferred_from_simulation": "consent_inference_prohibited",
        "lived_experience_claimed": "lived_experience_claim_prohibited",
        "human_preference_inference_claimed": "human_preference_inference_prohibited",
        "population_inference_claimed": "population_inference_prohibited",
        "market_demand_inference_claimed": "market_demand_inference_prohibited",
        "legal_or_policy_decision_use": "legal_or_policy_use_prohibited",
        "consequential_demographic_decision_use": "consequential_demographic_use_prohibited",
    }
    for field in REPRESENTATION_FIELDS:
        if boundary[field] is not False:
            raise ContractError(code_by_field[field], f"{field} must be literal false")
    return dict(boundary)


def validate_authority_flags(value: Any) -> dict[str, bool]:
    authority = _require_mapping(value, "authority_boundary_invalid", "authority")
    _require_closed(authority, set(AUTHORITY_FIELDS), "authority")
    for field in AUTHORITY_FIELDS:
        if authority[field] is not False:
            raise ContractError(
                "authority_grant_prohibited", f"{field} must be literal false"
            )
    return dict(authority)


def validate_purpose(intended_use: Any, instruction: Any) -> str:
    if not isinstance(intended_use, str) or not intended_use.strip():
        raise ContractError("intended_use_missing", "intended_use is required")
    if intended_use not in ALLOWED_INTENDED_USES:
        raise ContractError("intended_use_not_allowed", intended_use)
    if not isinstance(instruction, str) or not instruction.strip():
        raise ContractError("instruction_missing", "instruction is required")
    normalized = " ".join(instruction.lower().split())
    for code, phrase in _PROHIBITED_PURPOSES:
        if phrase in normalized:
            raise ContractError(
                code, f"instruction contains prohibited purpose: {phrase}"
            )
    return intended_use


def validate_claim_scope(value: Any) -> dict[str, list[str]]:
    scope = _require_mapping(
        value, "claim_scope_exceeds_synthetic_evidence", "claim_scope"
    )
    _require_closed(scope, set(CLAIM_SCOPE), "claim_scope")
    supported = scope["supported_claim_types"]
    unsupported = scope["unsupported_claim_types"]
    if supported != list(SUPPORTED_CLAIMS) or unsupported != list(UNSUPPORTED_CLAIMS):
        raise ContractError(
            "claim_scope_exceeds_synthetic_evidence",
            "claim_scope must match the closed synthetic evidence vocabulary",
        )
    return {
        "supported_claim_types": list(supported),
        "unsupported_claim_types": list(unsupported),
    }


def validate_task_packet(
    task: Mapping[str, Any],
    strategy: Mapping[str, Any],
    reporting: Mapping[str, Any],
) -> dict[str, Any]:
    _require_closed(
        task,
        {
            "schema",
            "task_id",
            "version",
            "intended_use",
            "instruction",
            "started_at",
            "finished_at",
            "subject",
            "limits",
        },
        "task",
    )
    if task["schema"] != "agoragentic.synthetic-cohort-task.v1":
        raise ContractError("task_schema_invalid", "unsupported task schema")
    validate_purpose(task["intended_use"], task["instruction"])
    subject = _require_mapping(task["subject"], "subject_invalid", "subject")
    _require_closed(
        subject,
        {"subject_id", "subject_version", "listing_id", "deployment_version"},
        "subject",
    )
    limits = _require_mapping(task["limits"], "limits_invalid", "limits")
    _require_closed(limits, {"max_trials", "max_turns", "max_latency_ms"}, "limits")
    for key in ("max_trials", "max_turns", "max_latency_ms"):
        if type(limits[key]) is not int or limits[key] <= 0:
            raise ContractError("limit_invalid", f"{key} must be a positive integer")
    if limits["max_trials"] > 32:
        raise ContractError("sample_size_above_policy", "max_trials exceeds 32")

    _require_closed(
        strategy,
        {
            "schema",
            "dataset",
            "cohort_query_digest",
            "sample_size",
            "seed",
            "replacement_policy",
            "model",
            "same_backbone",
            "representation_boundary",
        },
        "strategy",
    )
    if strategy["schema"] != "agoragentic.synthetic-cohort-strategy.v1":
        raise ContractError("strategy_schema_invalid", "unsupported strategy schema")
    dataset = _require_mapping(
        strategy["dataset"], "dataset_manifest_invalid", "dataset"
    )
    _require_closed(
        dataset, {"id", "revision", "source", "license_terms", "digest"}, "dataset"
    )
    model = _require_mapping(strategy["model"], "model_manifest_invalid", "model")
    _require_closed(model, {"provider", "name", "revision", "digest"}, "model")
    for field, value in (
        ("dataset.digest", dataset["digest"]),
        ("model.digest", model["digest"]),
        ("cohort_query_digest", strategy["cohort_query_digest"]),
    ):
        if (
            not isinstance(value, str)
            or not value.startswith("sha256:")
            or len(value) != 71
        ):
            raise ContractError(
                "manifest_digest_invalid", f"{field} must be a sha256 digest"
            )
    validate_representation_boundary(strategy["representation_boundary"])
    if (
        type(strategy["sample_size"]) is not int
        or not 1 <= strategy["sample_size"] <= limits["max_trials"]
    ):
        raise ContractError(
            "sample_size_above_policy", "sample_size is outside task limits"
        )
    if type(strategy["seed"]) is not int:
        raise ContractError("seed_invalid", "seed must be an integer")
    if strategy["replacement_policy"] not in {
        "without_replacement",
        "with_replacement",
    }:
        raise ContractError(
            "replacement_policy_invalid", "unsupported replacement policy"
        )
    if type(strategy["same_backbone"]) is not bool:
        raise ContractError("same_backbone_missing", "same_backbone must be a boolean")

    _require_closed(
        reporting,
        {"schema", "claim_scope", "limitations", "public_facets", "authority"},
        "reporting",
    )
    if reporting["schema"] != "agoragentic.synthetic-cohort-reporting.v1":
        raise ContractError("reporting_schema_invalid", "unsupported reporting schema")
    validate_claim_scope(reporting["claim_scope"])
    limitations = reporting["limitations"]
    if not isinstance(limitations, list) or set(limitations) != set(
        MANDATORY_LIMITATIONS
    ):
        raise ContractError(
            "required_limitation_missing",
            "limitations must exactly match the mandatory set",
        )
    facets = reporting["public_facets"]
    if not isinstance(facets, list) or not set(facets) <= PUBLIC_FACETS:
        raise ContractError(
            "public_facet_prohibited",
            "public facets must use the operational-only vocabulary",
        )
    validate_authority_flags(reporting["authority"])
    return {
        "task": dict(task),
        "strategy": dict(strategy),
        "reporting": dict(reporting),
    }
