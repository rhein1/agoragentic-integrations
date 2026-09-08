"""Offline evaluator-record replay. Never imports a provider or invokes a target."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
from agoragentic_matraix_assurance.contracts import (  # noqa: E402
    ALL_AUTHORITY_FALSE, ContractError, validate_authority_flags,
)
from agoragentic_matraix_assurance.manifest import canonical_json  # noqa: E402
from agoragentic_matraix_assurance.target import (  # noqa: E402
    validate_target_config, validate_target_response,
)

ROOT = Path(__file__).resolve().parent
SCOPE = "system_behavior_under_synthetic_interaction"
REPRESENTATION = dict.fromkeys((
    "human_preference_inference", "population_inference", "market_demand_inference",
    "human_participant_substitution", "participatory_design_substitution",
    "affected_stakeholder_representation", "affected_community_participation_claimed",
    "representational_authority_claimed", "deliberative_authority_claimed",
    "consent_inferred", "lived_experience_claimed", "legal_or_policy_decision_use",
    "consequential_demographic_decision_use",
), False)
BOUNDARY = {"proof_scope": SCOPE, "representation_boundary": REPRESENTATION,
            "authority": ALL_AUTHORITY_FALSE}
INPUTS = ("run-config.example.json", "cohort-manifest.json", "task-manifest.json",
          "subject-manifest.json", "model-manifest.example.json", "sanitized-trials.jsonl")
PLATFORM_CONTRACT_COMMIT = "96af5efcb8515e419b3ba8868cefbab2e5adbb26"
PLATFORM_SCHEMA = "agoragentic.synthetic-cohort-evidence.v1"
PLATFORM_LIMITATIONS = [
    "synthetic_model_mediated_evidence", "not_human_validation",
    "not_population_prevalence_estimate", "not_customer_demand_validation",
    "not_safety_certification", "synthetic_personas_do_not_represent_real_people",
    "not_human_participant_substitution", "not_affected_community_participation",
    "not_authorized_representation", "not_representational_or_deliberative_authority",
    "consent_and_lived_experience_not_inferable", "model_sensitivity_not_established",
    "no_live_model_trials",
]
STATUSES = ("completed", "failed", "timed_out", "abandoned", "invalid", "unverifiable")
FINDINGS = ("functional_complete", "mandate_violation", "approval_required",
            "approval_correct", "unsupported_claim", "privacy_violation")


def require(condition, code):
    if not condition:
        raise ContractError(code, "proof packet rejected")


def closed(value, fields):
    require(type(value) is dict and set(value) == set(fields), "closed_contract")


def boundary(value):
    for key, expected in BOUNDARY.items():
        require(key in value and canonical_json(value[key]) == canonical_json(expected),
                "representation_or_authority_drift")


def digest(value):
    return "sha256:" + hashlib.sha256(canonical_json(value).encode()).hexdigest()


def parse_json(text):
    def pairs(items):
        obj = {}
        for key, value in items:
            require(key not in obj, "duplicate_json_key")
            obj[key] = value
        return obj
    return json.loads(text, object_pairs_hook=pairs,
                      parse_constant=lambda _: require(False, "nonfinite_json"))


def read_json(path):
    require(not path.is_symlink() and path.stat().st_size <= 262144, "artifact_size_or_link")
    return parse_json(path.read_text(encoding="utf-8"))


def rate(numerator, denominator):
    return {"numerator": numerator, "denominator": denominator,
            "value": round(numerator / denominator, 6) if denominator else None}


def summarize(records):
    valid = [r for r in records if r["status"] not in ("invalid", "unverifiable")]
    approval = [r for r in valid if r["findings"]["approval_required"]]
    metrics = {"system_" + key: rate(sum(r["findings"][key] for r in valid), len(valid))
               for key in FINDINGS if key not in ("approval_required", "approval_correct")}
    metrics["system_approval_correctness"] = rate(
        sum(r["findings"]["approval_correct"] for r in approval), len(approval))
    metrics["synthetic_trial_abandonment"] = rate(
        sum(r["status"] == "abandoned" for r in records), len(records))
    for field in ("turns", "latency_ms"):
        values = sorted(r[field] for r in records)
        metrics["synthetic_trial_" + field] = {
            "median": statistics.median(values) if values else None,
            "p95": values[max(0, math.ceil(.95 * len(values)) - 1)] if values else None}
    return metrics


def evaluate(root=ROOT):
    config, cohort, task, subject, models = [read_json(root / name) for name in INPUTS[:5]]
    expected_fields = (
        {"mode", "seed", "replacement_policy", "planned_live_trials", "max_turns", "max_latency_ms"},
        {"dataset_id", "dataset_revision", "personas"},
        {"task_id", "version", "scenario", "verifier_id"},
        {"subject_id", "version", "execution_mode", "target_config"},
        {"personas", "target_model", "judge_model", "model_sensitivity_status"},
    )
    for value, fields in zip((config, cohort, task, subject, models), expected_fields):
        closed(value, fields | BOUNDARY.keys())
        boundary(value)
    require(config == {**BOUNDARY, "mode": "fixture_replay", "seed": 321,
                       "replacement_policy": "without_replacement", "planned_live_trials": 32,
                       "max_turns": 8, "max_latency_ms": 30000}, "configuration_drift")
    require(cohort["dataset_id"] == "local-operational-fixture" and
            cohort["dataset_revision"] == "1", "dataset_drift")
    expected_personas = [{"persona_id": f"synthetic-{i:02d}", "complexity": i % 4,
                         "urgency": i % 2} for i in range(16)]
    # SHA ordering is stable across Python versions; no PRNG implementation dependency.
    expected_personas.sort(key=lambda p: digest({"seed": config["seed"], "persona": p}))
    require(cohort["personas"] == expected_personas, "cohort_selection_drift")
    require(task["task_id"] == "resolution-desk-missing-delivery-v1" and
            task["version"] == "1" and task["scenario"] == "synthetic_missing_delivery" and
            task["verifier_id"] == "offline-record-reconciler-v1", "task_drift")
    require(subject["subject_id"] == "resolution-desk-contract-fixture" and
            subject["version"] == "1" and subject["execution_mode"] == "record_replay_only",
            "subject_drift")
    target = subject["target_config"]
    validate_target_config(target)
    require(target == {"schema": "agoragentic.synthetic-cohort-target.v1",
            "base_url": "http://127.0.0.1", "allowlisted_hosts": [],
            "capability_path": "/fixture/missing-delivery", "expected_target_version": "1",
            "price_usdc": 0, "authority": ALL_AUTHORITY_FALSE}, "target_config_drift")
    require(type(target["price_usdc"]) is int and target["price_usdc"] == 0,
            "ambiguous_price")
    require(models["personas"] == ["fixture-backbone-a-v1", "fixture-backbone-b-v1"] and
            models["target_model"] is None and models["judge_model"] is None and
            models["model_sensitivity_status"] == "not_measured", "model_identity_drift")
    trial_path = root / INPUTS[5]
    require(not trial_path.is_symlink() and trial_path.stat().st_size <= 262144, "trial_size_or_link")
    records = [parse_json(line) for line in trial_path.read_text(encoding="utf-8").splitlines()]
    require(len(records) == 32, "planned_trial_accounting")
    expected_pairs = {(p["persona_id"], m) for p in cohort["personas"] for m in models["personas"]}
    seen, invocations, receipts = set(), set(), set()
    bindings = {"cohort": digest(cohort), "task": digest(task), "subject": digest(subject),
                "models": digest(models), "config": digest(config)}
    observed = verified = 0
    for record in records:
        closed(record, set(BOUNDARY) | {"trial_id", "persona_id", "model_id", "bindings",
               "status", "turns", "latency_ms", "findings", "preflight", "response",
               "invocation_id", "receipt_state", "origin", "summary_code"})
        boundary(record)
        require(record["origin"] == "sanitized_evaluator_fixture" and
                record["summary_code"] == "synthetic_trial_observation", "raw_record_prohibited")
        pair = (record["persona_id"], record["model_id"])
        require(pair in expected_pairs and pair not in seen, "duplicate_or_unknown_trial")
        seen.add(pair)
        require(record["trial_id"] == "trial-" + digest(list(pair))[7:31], "trial_identity")
        require(record["bindings"] == bindings, "trial_binding_drift")
        require(record["status"] in STATUSES, "trial_status")
        for key, limit in (("turns", 8), ("latency_ms", 30000)):
            require(type(record[key]) is int and 0 <= record[key] <= limit, "trial_limit")
        closed(record["findings"], FINDINGS)
        require(all(type(v) is bool for v in record["findings"].values()), "finding_type")
        if record["findings"]["functional_complete"]:
            require(record["status"] == "completed", "completion_status_mismatch")
        require(record["preflight"] == {"price_usdc": 0, "http_status": 200,
                "subject_digest": bindings["subject"], "authority": ALL_AUTHORITY_FALSE}, "preflight_rejected")
        require(type(record["preflight"]["price_usdc"]) is int, "ambiguous_price")
        validate_authority_flags(record["preflight"]["authority"])
        require(type(record["preflight"]["http_status"]) is int, "ambiguous_status")
        require(record["invocation_id"] == "fixture-invocation-" + record["trial_id"] and
                record["invocation_id"] not in invocations, "invocation_identity")
        invocations.add(record["invocation_id"])
        response = record["response"]
        require(record["receipt_state"] in ("fixture_verified", "missing", "unverifiable"), "receipt_state")
        if record["receipt_state"] == "unverifiable":
            require(record["status"] in ("invalid", "unverifiable"), "receipt_status_mismatch")
        if record["receipt_state"] == "missing":
            require(response is None and record["status"] in ("invalid", "unverifiable"), "missing_receipt")
        else:
            validate_target_response(target, response)
            require(type(response["price_usdc"]) is int, "ambiguous_price")
            receipt_id = response["receipt"]["receipt_id"]
            require(receipt_id == "fixture-receipt-" + record["trial_id"] and
                    receipt_id not in receipts, "receipt_identity")
            receipts.add(receipt_id)
            observed += 1
            verified += record["receipt_state"] == "fixture_verified"
    require(seen == expected_pairs, "omitted_trials")
    by_model = {m: summarize([r for r in records if r["model_id"] == m]) for m in models["personas"]}
    metrics = summarize(records)
    deltas = {key: round(by_model[models["personas"][1]][key]["value"] -
                        by_model[models["personas"][0]][key]["value"], 6)
              for key, metric in metrics.items() if "value" in metric and
              all(by_model[m][key]["value"] is not None for m in models["personas"])}
    return {**BOUNDARY, "mode": "fixture_replay", "bindings": bindings,
            "trials_digest": digest(records), "counts": {"requested": 32, "started": 32,
            **{s: sum(r["status"] == s for r in records) for s in STATUSES}},
            "receipts": {"expected": 32, "observed": observed, "verified": verified},
            "metrics": metrics, "fixture_metrics_by_backbone": by_model,
            "fixture_metric_differences": deltas, "model_sensitivity_status": "not_measured",
            "live_trials_completed": 0, "live_trials_missing": 32,
            "target_contract_drift_count": 0, "payment_challenge_count": 0,
            "nonzero_quote_count": 0, "provider_calls": 0, "target_calls": 0,
            "verification_scope": "fixture_consistency_only"}


def file_digest(path):
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def build_platform_evidence(root=ROOT):
    report = evaluate(root)
    cohort, task, subject, models = [read_json(root / name) for name in INPUTS[1:5]]
    counts = report["counts"]
    receipts = report["receipts"]

    def metric(metric_id, numerator, denominator):
        return {"metric_id": metric_id, "kind": "rate", "numerator": numerator,
                "denominator": denominator, "value": numerator / denominator}

    valid = 32 - counts["invalid"] - counts["unverifiable"]
    approval = report["metrics"]["system_approval_correctness"]
    report_metrics = report["metrics"]
    metrics = [
        metric("task_completion_rate", counts["completed"], valid),
        metric("mandate_violation_rate", report_metrics["system_mandate_violation"]["numerator"], valid),
        metric("approval_correctness_rate", approval["numerator"], approval["denominator"]),
        metric("unsupported_claim_rate", report_metrics["system_unsupported_claim"]["numerator"], valid),
        metric("privacy_violation_rate", report_metrics["system_privacy_violation"]["numerator"], valid),
        metric("abandonment_rate", counts["abandoned"], 32),
        metric("receipt_presence_rate", receipts["observed"], receipts["expected"]),
        metric("receipt_correctness_rate", receipts["verified"], receipts["observed"]),
        metric("invalid_unverifiable_rate", counts["invalid"] + counts["unverifiable"], 32),
    ]
    authority = {
        "evidence_is_advisory": True, "human_validation_claimed": False,
        "population_representativeness_claimed": False, "certification_claimed": False,
        "partnership_claimed": False, "ranking_mutated": False,
        "trust_tier_mutated": False, "payment_authority_granted": False,
        "deployment_authority_granted": False, "publication_authority_granted": False,
        "customer_data_used": False, "raw_persona_records_public": False,
        "raw_transcripts_public": False,
    }
    representation = {
        "intended_use": "agent_behavior_qa",
        "synthetic_personas_speak_for_real_people": False,
        "human_participant_substitution": False,
        "affected_community_consulted_in_this_evidence": False,
        "affected_community_authorization_claimed": False,
        "representational_legitimacy_claimed": False,
        "deliberative_authority_claimed": False,
        "consent_inferred_from_simulation": False,
        "lived_experience_claimed": False,
        "human_preference_inference_claimed": False,
        "population_inference_claimed": False,
        "market_demand_inference_claimed": False,
        "legal_or_policy_decision_use": False,
        "consequential_demographic_decision_use": False,
        "eligible_decision_uses": ["agent_qa"],
    }
    unsupported = sorted(["human_preference", "population_prevalence", "market_demand",
        "community_voice", "affected_community_participation", "authorized_representation",
        "representational_legitimacy", "consent", "lived_experience", "policy_legitimacy",
        "legal_deliberation", "consequential_eligibility"])
    evidence = {
        "schema": PLATFORM_SCHEMA, "evidence_id": "sce_" + "0" * 24,
        "created_at": "2026-09-08T00:00:00.000Z", "evidence_type": "synthetic_cohort",
        "evidence_class": "synthetic_behavioral", "status": "experimental_advisory",
        "producer": {"provider": "offline_fixture", "adapter": "agoragentic-matraix-cohort-assurance",
            "adapter_version": "0.1.0a0", "adapter_source_sha256": digest("0d5eaeec77f8b1cfeb368a9339e8c483ba62df1c"),
            "upstream_project": "MatrAIx-ai/MatrAIx-Persona-8B",
            "upstream_commit": "68f5faf4eed9a4f48513ca3ea4f22ee0f6b14c82",
            "evidence_generator_version": "resolution-desk-replay-v1",
            "canonicalization": "agoragentic-canonical-json-v1", "partnership_claimed": False},
        "subject": {"capability_id": subject["subject_id"], "capability_version": subject["version"],
            "deployment_digest": report["bindings"]["subject"],
            "target_origin_digest": digest(subject["target_config"]), "provider_identity": "offline_fixture",
            "evaluation_scope": SCOPE},
        "task": {"task_id": task["task_id"], "task_version": task["version"],
            "task_type": task["scenario"], "task_manifest_digest": report["bindings"]["task"],
            "verifier_id": task["verifier_id"], "verifier_version": "1",
            "verifier_digest": digest({"verifier_id": task["verifier_id"]}),
            "scenario_summary": "Offline evaluator fixture replay; no target or model calls.",
            "expected_receipt": True, "expected_approval": True, "side_effect_allowed": False,
            "payment_allowed": False, "real_spend_allowed": False,
            "production_mutation_allowed": False, "customer_data_allowed": False},
        "cohort": {"dataset_id": cohort["dataset_id"], "dataset_revision": cohort["dataset_revision"],
            "dataset_manifest_digest": digest({"dataset_id": cohort["dataset_id"], "revision": cohort["dataset_revision"]}),
            "persona_manifest_digest": report["bindings"]["cohort"], "seed": 321,
            "requested_sample_size": 32, "actual_unique_persona_count": 16,
            "replacement_policy": "without_replacement", "selection_mode": "fixture_replay",
            "license_review_state": "not_required_fixture_only", "sensitive_attributes_used": False,
            "raw_persona_records_included": False},
        "models": {"persona_models": [{"provider": "fixture", "model_id": model_id,
            "revision": "fixture", "inference_config_digest": digest({"model_id": model_id}),
            "role": "persona", "sampling_mode": "deterministic"} for model_id in models["personas"]],
            "system_under_test": {"provider": "fixture", "model_id": subject["subject_id"],
                "revision": subject["version"], "inference_config_digest": report["bindings"]["subject"],
                "role": "system_under_test", "sampling_mode": "deterministic"},
            "evaluator": None, "same_backbone": False, "llm_judge_used": False,
            "model_sensitivity_status": "not_established"},
        "run": {"run_id": "resolution-desk-missing-delivery-v1-fixture-replay",
            "trials_requested": 32, "trials_started": 32, "trials_completed": counts["completed"],
            "trials_failed": counts["failed"], "trials_timed_out": counts["timed_out"],
            "trials_abandoned": counts["abandoned"], "trials_invalid": counts["invalid"],
            "trials_unverifiable": counts["unverifiable"], "receipts_expected": receipts["expected"],
            "receipts_observed": receipts["observed"], "receipts_verified": receipts["verified"]},
        "metrics": metrics,
        "artifacts": {"canonical_evidence_sha256": "sha256:" + "0" * 64,
            "task_manifest_sha256": file_digest(root / "task-manifest.json"),
            "cohort_manifest_sha256": file_digest(root / "cohort-manifest.json"),
            "dataset_manifest_sha256": digest({"dataset_id": cohort["dataset_id"], "revision": cohort["dataset_revision"]}),
            "model_config_sha256": file_digest(root / "model-manifest.example.json"),
            "subject_version_sha256": file_digest(root / "subject-manifest.json"),
            "sanitized_report_sha256": file_digest(root / "report.json"),
            "trial_manifest_sha256": file_digest(root / "sanitized-trials.jsonl"),
            "raw_transcripts_included": False},
        "limitations": PLATFORM_LIMITATIONS, "authority_boundary": authority,
        "representation_boundary": representation,
        "claim_scope": {"supported": ["system_behavior_observation"], "unsupported": unsupported},
    }
    serialized = subprocess.run(
        ["node", str(ROOT / "canonical-evidence.cjs")], input=canonical_json(evidence),
        capture_output=True, text=True, encoding="utf-8", check=True, timeout=30,
    ).stdout
    return parse_json(serialized)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--evidence-out", type=Path)
    args = parser.parse_args()
    verify_manifest(args.root)
    result = (canonical_json(evaluate(args.root)) + "\n").encode()
    generated_evidence = build_platform_evidence(args.root)
    evidence_bytes = (canonical_json(generated_evidence) + "\n").encode()
    evidence_path = args.root / "synthetic-cohort-evidence.json"
    require(evidence_path.is_file(), "platform_evidence_missing")
    require(read_json(evidence_path) == generated_evidence, "platform_evidence_payload_mismatch")
    if args.evidence_out:
        with args.evidence_out.open("xb") as stream:
            stream.write(evidence_bytes)
    if args.out:
        with args.out.open("xb") as stream:
            stream.write(result)
    else:
        require(result == (args.root / "report.json").read_bytes(), "replay_bytes_mismatch")
        print("32 fixture records replayed; 0 live trials; canonical report matches")


def verify_manifest(root):
    manifest = read_json(root / "sha256-manifest.json")
    closed(manifest, set(BOUNDARY) | {"files", "authenticity"})
    boundary(manifest)
    require(manifest["authenticity"] == "unsigned_local_integrity_only", "manifest_authority")
    expected = set(INPUTS) | {"report.json", "synthetic-cohort-evidence.json", "platform-contract.json",
                              "validate-platform-contract.cjs", "replay.py", "README.md", "METHOD.md",
                              "LIMITATIONS.md", "synthetic-cohort-evidence.v1.snapshot.json",
                              "canonical-evidence.cjs", "validate_platform_schema.py"}
    closed(manifest["files"], expected)
    for name, expected_hash in manifest["files"].items():
        path = root / name
        require(not path.is_symlink() and path.stat().st_size <= 262144, "artifact_size_or_link")
        require("sha256:" + hashlib.sha256(path.read_bytes()).hexdigest() == expected_hash,
                "artifact_hash_mismatch")


if __name__ == "__main__":
    main()
