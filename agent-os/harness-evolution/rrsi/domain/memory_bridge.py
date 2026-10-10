"""Read-only validator for the public Agoragentic Memory SkillOpt artifacts.

The shapes in this module match ``agoragentic-memory`` at commit
3c2f17d82476d22996377ea7c07cb601ed625483.  This is an evidence importer,
not a Memory client: it performs no filesystem access or Memory writes and
never returns execution or promotion authority.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import re
from typing import Mapping


class MemoryBridgeError(ValueError):
    pass


def _fail(code: str) -> None:
    raise MemoryBridgeError(code)


def _digest(value: object) -> str:
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                             sort_keys=True, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError):
        _fail("invalid_memory_json")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _iso(value: object) -> datetime:
    if not isinstance(value, str):
        _fail("invalid_review_timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        _fail("invalid_review_timestamp")
    if parsed.tzinfo is None:
        _fail("invalid_review_timestamp")
    return parsed.astimezone(timezone.utc)


def _mapping(value: object, code: str) -> Mapping[str, object]:
    if type(value) is not dict:
        _fail(code)
    return value


def _same(actual: object, expected: object, code: str) -> None:
    if actual != expected:
        _fail(code)


def _sha(value: object, code: str) -> str:
    if type(value) is not str or re.fullmatch(r"sha256:[a-f0-9]{64}", value) is None:
        _fail(code)
    return value


def _bounded_json(value, depth=0, budget=None):
    budget = [0] if budget is None else budget
    budget[0] += 1
    if depth > 16 or budget[0] > 8192:
        _fail("memory_artifact_too_deep_or_large")
    if value is None or type(value) is bool:
        return value
    if type(value) is int and abs(value) <= 2**53 - 1:
        return value
    if type(value) is str and len(value) <= 65536:
        try: value.encode("utf-8")
        except UnicodeError: _fail("invalid_memory_json")
        return value
    if type(value) is list:
        return [_bounded_json(x, depth + 1, budget) for x in value]
    if type(value) is dict and all(type(k) is str and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k) for k in value):
        return {k: _bounded_json(v, depth + 1, budget) for k, v in value.items()}
    # This supported subset has identical canonical encoding in Python and JS.
    # Reject floating numbers, numeric/non-ASCII object keys and custom objects
    # instead of accidentally hashing them differently from Memory's Node code.
    _fail("unsupported_memory_json")


def _scope(value):
    if set(value) != {"project_id", "repo_id"} or any(type(v) is not str or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}", v) is None for v in value.values()):
        _fail("invalid_memory_scope")


def _reviewed_task_rows(stage: Mapping[str, object], candidate: Mapping[str, object]) -> list[dict[str, object]]:
    """Reconstruct the bounded task rows emitted by the pinned Memory bridge."""
    claims = candidate.get("source_claim_ids")
    if (type(claims) is not list or not 2 <= len(claims) <= 64
            or any(type(claim) is not str or re.fullmatch(r"mem_[a-f0-9]{32}", claim) is None for claim in claims)
            or len(set(claims)) != len(claims)):
        _fail("memory_task_collection_source")
    if type(stage.get("stage_id")) is not str or type(stage.get("skillopt_project")) is not str or type(candidate.get("slug")) is not str:
        _fail("memory_task_collection_source")
    rows = []
    for index, claim in enumerate(claims):
        split = "test" if index == len(claims) - 1 else "val" if len(claims) >= 3 and index == len(claims) - 2 else "train"
        rows.append({
            "id": "memory-" + claim[4:],
            "project": stage["skillopt_project"],
            "intent": f"Refine the owner-reviewed procedure represented by {stage['stage_id']}.",
            "context_excerpt": "A redacted, evidence-linked Memory candidate was selected. This task intentionally excludes transcripts, tool output, repository contents, and credentials.",
            "system": "", "attempted_solution": "", "outcome": "unknown",
            "reference_kind": "none", "reference": "", "judge": {},
            "tags": ["agoragentic-memory", "reviewed-candidate"],
            "source_sessions": [], "split": split,
            "origin": "redacted_memory_candidate", "derived_from": "",
            "skill_hint": candidate["slug"],
        })
    return rows


def validate_reviewed_memory(
    *, task: Mapping[str, object],
    stage: Mapping[str, object],
    review_claim: Mapping[str, object],
    review: Mapping[str, object],
    receipt: Mapping[str, object],
    stage_view: Mapping[str, object],
    scope: Mapping[str, str],
    now: str,
    max_age_seconds: int = 86400,
) -> Mapping[str, object]:
    """Return quarantined evidence after validating claim-bound Memory state.

    ``stage`` is the managed stage artifact, while ``review`` and ``receipt``
    are the managed artifacts loaded with it.  A stage-view alone is not
    sufficient because it omits the repository scope and candidate contents.
    """
    values = [_bounded_json(v) for v in (task, stage, review_claim, review, receipt, stage_view, scope)]
    if any(len(json.dumps(v, ensure_ascii=False).encode("utf-8")) > 262144 for v in values):
        _fail("memory_artifact_too_large")
    task, stage, review_claim, review, receipt, stage_view, scope = values
    task = _mapping(task, "memory_task_required")
    stage = _mapping(stage, "memory_stage_required")
    review_claim = _mapping(review_claim, "memory_review_claim_required")
    review = _mapping(review, "memory_review_required")
    receipt = _mapping(receipt, "memory_receipt_required")
    stage_view = _mapping(stage_view, "memory_stage_view_required")
    scope = _mapping(scope, "memory_scope_required")
    _scope(scope)
    if type(max_age_seconds) is not int or not 0 <= max_age_seconds <= 604800:
        _fail("invalid_review_freshness")
    forbidden = {"transcript", "raw_transcript", "tool_output", "stdout", "stderr", "credentials", "secret"}
    def scan(value: object, depth: int = 0) -> None:
        if depth > 16:
            _fail("memory_artifact_too_deep")
        if isinstance(value, Mapping):
            if forbidden.intersection(value):
                _fail("memory_raw_capture_forbidden")
            for child in value.values():
                scan(child, depth + 1)
        elif isinstance(value, list):
            for child in value:
                scan(child, depth + 1)
    scan(task); scan(stage); scan(review_claim); scan(review); scan(receipt)

    _same(task.get("schema"), "agoragentic.memory.skillopt-reviewed-task.v1", "memory_task_schema")
    _same(task.get("skillopt_wire_format"), "skillopt_sleep.tasks.v1", "memory_task_wire_format")
    _same(task.get("compatibility_state"), "review_aware_consumer_required", "memory_task_compatibility")
    if task.get("reviewed") is not True or task.get("active") is not False:
        _fail("memory_task_not_staged_reviewed")
    _same(stage.get("schema"), "agoragentic.memory.skillopt-stage.v1", "memory_stage_schema")
    if type(task.get("stage_id")) is not str or re.fullmatch(r"skillopt_stage_[a-f0-9]{32}", task["stage_id"]) is None:
        _fail("invalid_memory_stage_id")
    _same(stage.get("stage_id"), task.get("stage_id"), "memory_stage_id_mismatch")
    _same(stage_view.get("stage_id"), task.get("stage_id"), "memory_stage_view_id_mismatch")
    if stage_view.get("status") != "reviewed_staged_not_active":
        _fail("memory_stage_not_eligible")
    view_review = _mapping(stage_view.get("review"), "memory_stage_view_review_missing")
    if view_review.get("status") != "owner_reviewed" or view_review.get("active") is not False or view_review.get("eligible_for_external_evaluation") is not True:
        _fail("memory_stage_view_review_state")
    stage_scope = _mapping(stage.get("scope"), "memory_stage_scope_missing")
    _scope(stage_scope)
    _same(stage_scope.get("project_id"), scope.get("project_id"), "memory_project_scope_mismatch")
    _same(stage_scope.get("repo_id"), scope.get("repo_id"), "memory_repo_scope_mismatch")
    _same(stage.get("skillopt_project"), task.get("project"), "memory_project_mismatch")
    _same(stage.get("target_skill_path"), task.get("target_skill_path"), "memory_target_mismatch")

    redaction = _mapping(stage.get("redaction"), "memory_redaction_missing")
    _same(redaction.get("state"), "redacted_structured_only", "memory_redaction_state")
    excluded = redaction.get("excluded_material")
    if not isinstance(excluded, list) or not {"transcript", "tool_output", "repository_content", "credentials"}.issubset(excluded):
        _fail("memory_redaction_scope")
    authority = _mapping(task.get("authority"), "memory_task_authority_missing")
    if authority != {"optimization": "not_invoked", "adoption": "not_performed", "publication": "not_performed", "spend": "not_incurred"}:
        _fail("memory_task_authority_state")
    _same(stage.get("authority"), authority, "memory_stage_authority_state")

    candidate = _mapping(stage.get("candidate"), "memory_candidate_missing")
    provenance = _mapping(task.get("provenance"), "memory_provenance_missing")
    _same(provenance.get("candidate_id"), candidate.get("candidate_id"), "memory_candidate_mismatch")
    _same(provenance.get("candidate_hash"), candidate.get("candidate_hash"), "memory_candidate_hash_mismatch")
    candidate_projection = {key: candidate.get(key) for key in (
        "candidate_id", "slug", "trigger_terms", "support_count", "distinct_occurrence_count",
        "repo_ids", "source_claim_ids", "evidence_ids")}
    if any(value is None for value in candidate_projection.values()):
        _fail("memory_candidate_incomplete")
    _same(candidate.get("candidate_hash"), _digest(candidate_projection), "memory_candidate_hash_invalid")
    if provenance.get("redaction_state") != "redacted_structured_only":
        _fail("memory_provenance_redaction_state")
    if not all(isinstance(provenance.get(key), list) for key in ("source_claim_ids", "evidence_ids", "repo_ids")):
        _fail("memory_provenance_ids_missing")
    for key in ("source_claim_ids", "evidence_ids", "repo_ids"):
        _same(provenance[key], candidate.get(key), "memory_provenance_mismatch")
    if scope["repo_id"] not in provenance["repo_ids"]:
        _fail("memory_candidate_repo_scope_mismatch")
    task_rows = _reviewed_task_rows(stage, candidate)
    _same(task.get("tasks"), task_rows, "memory_task_collection_mismatch")

    _same(review_claim.get("schema"), "agoragentic.memory.skillopt-finalization-claim.v1", "memory_claim_schema")
    for key, expected in (("operation", "review"), ("confirmation", "REVIEWED"),
                          ("stage_id", task.get("stage_id")), ("claim_boundary", "local_owner_assertion_pending_immutable_finalization")):
        _same(review_claim.get(key), expected, "memory_review_claim_binding")
    for key in ("request_id", "owner_review_id", "reviewed_at", "stage_digest", "task_digest"):
        if key not in review_claim:
            _fail("memory_review_claim_incomplete")
    _same(review_claim.get("stage_digest"), _digest(stage), "memory_stage_digest_mismatch")
    _same(review_claim.get("task_digest"), _digest(task), "memory_claim_task_digest_mismatch")

    _same(review.get("schema"), "agoragentic.memory.skillopt-review.v1", "memory_review_schema")
    for key, expected in (("stage_id", task.get("stage_id")), ("request_id", review_claim.get("request_id")),
                          ("owner_review_id", review_claim.get("owner_review_id")),
                          ("reviewed_at", review_claim.get("reviewed_at")), ("confirmation", "REVIEWED"),
                          ("review_boundary", "local_owner_assertion_no_external_identity_verification"),
                          ("review_claim_digest", _digest(review_claim)), ("task_digest", _digest(task))):
        _same(review.get(key), expected, "memory_review_binding")
    _same(review.get("evaluation_receipt_digest"), _digest(receipt), "memory_receipt_digest_mismatch")
    reviewed_at = _iso(review.get("reviewed_at")); current = _iso(now)
    if reviewed_at > current or (current - reviewed_at).total_seconds() > max_age_seconds:
        _fail("memory_review_stale")

    _same(receipt.get("schema"), "agoragentic.memory.skillopt-evaluation-receipt.v1", "memory_receipt_schema")
    _same(receipt.get("stage_id"), task.get("stage_id"), "memory_receipt_stage_mismatch")
    _same(receipt.get("baseline"), _mapping(task.get("baseline"), "memory_task_baseline_missing"), "memory_receipt_baseline_mismatch")
    _same(receipt.get("evaluation_state"), "not_run", "memory_receipt_already_run")
    receipt_candidate = _mapping(receipt.get("candidate"), "memory_receipt_candidate")
    _same(receipt_candidate.get("task_hash"), _digest(task), "memory_receipt_task_digest_mismatch")
    _same(receipt_candidate.get("stage_hash"), _digest(stage), "memory_receipt_stage_digest_mismatch")
    provider = _mapping(receipt.get("provider"), "memory_receipt_provider")
    _same(provider, {"state": "not_invoked", "name": None, "model": None}, "memory_receipt_provider_state")
    spend = _mapping(receipt.get("spend"), "memory_receipt_spend")
    if type(spend.get("amount")) is not int:
        _fail("memory_receipt_spend_state")
    _same(spend, {"state": "not_incurred", "amount": 0, "currency": None}, "memory_receipt_spend_state")
    validation = _mapping(receipt.get("validation"), "memory_receipt_validation")
    if validation.get("held_out_split_present") is not True:
        _fail("memory_receipt_validation_state")
    _same(validation, {"state": "not_run", "harness_core": "not_invoked",
                       "held_out_split_present": any(row["split"] in {"val", "test"} for row in task_rows)},
          "memory_receipt_validation_state")
    approval = _mapping(receipt.get("approval"), "memory_receipt_approval")
    if (approval.get("owner_reviewed_for_external_evaluation") is not True
            or approval.get("adoption_approved") is not False
            or approval.get("publication_approved") is not False or approval.get("active") is not False
            or set(approval) != {"owner_reviewed_for_external_evaluation", "adoption_approved", "publication_approved", "active"}):
        _fail("memory_receipt_authority_state")

    rollback = _mapping(stage.get("rollback"), "memory_rollback_missing")
    baseline = _mapping(stage.get("baseline"), "memory_baseline_missing")
    task_baseline = _mapping(task.get("baseline"), "memory_task_baseline_missing")
    task_rollback = _mapping(task.get("rollback"), "memory_task_rollback_missing")
    for value, code in ((baseline.get("ref"), "memory_baseline_ref"), (baseline.get("hash"), "memory_baseline_hash"),
                        (rollback.get("ref"), "memory_rollback_ref"), (rollback.get("hash"), "memory_rollback_hash"),
                        (task_baseline.get("hash"), "memory_task_baseline_hash"), (task_rollback.get("hash"), "memory_task_rollback_hash")):
        if not isinstance(value, str) or not value:
            _fail(code)
    _sha(baseline.get("hash"), "memory_baseline_hash")
    _sha(rollback.get("hash"), "memory_rollback_hash")
    _same(task_baseline, baseline, "memory_task_baseline_mismatch")
    _same(task_rollback, rollback, "memory_task_rollback_mismatch")
    if rollback.get("ref") != baseline.get("ref") or rollback.get("hash") != baseline.get("hash"):
        _fail("memory_rollback_binding")

    view_candidate = _mapping(stage_view.get("candidate"), "memory_stage_view_candidate_missing")
    _same(view_candidate, {key: candidate.get(key) for key in (
        "candidate_id", "candidate_hash", "trigger_terms", "source_claim_ids", "evidence_ids", "repo_ids")},
        "memory_stage_view_candidate_mismatch")
    for field, source in (("created_at", stage.get("created_at")), ("redaction", redaction),
                          ("baseline", baseline), ("rollback", rollback), ("authority", authority)):
        _same(stage_view.get(field), source, "memory_stage_view_" + field + "_mismatch")
    for field, source in (("owner_review_id", review.get("owner_review_id")),
                          ("reviewed_at", review.get("reviewed_at")),
                          ("task_digest", _digest(task)),
                          ("evaluation_receipt_digest", _digest(receipt))):
        _same(view_review.get(field), source, "memory_stage_view_review_binding")
    if stage_view.get("rollback_record") is not None:
        _fail("memory_stage_view_rollback_state")
    view_receipt = _mapping(stage_view.get("evaluation_receipt"), "memory_stage_view_receipt_missing")
    if (view_receipt.get("adoption_approved") is not False
            or view_receipt.get("eligible_for_external_evaluation") is not True):
        _fail("memory_stage_view_receipt_mismatch")
    _same(view_receipt, {"evaluation_state": receipt.get("evaluation_state"),
                         "provider_state": provider.get("state"), "validation_state": validation.get("state"),
                         "spend_state": spend.get("state"), "adoption_approved": False,
                         "eligible_for_external_evaluation": True}, "memory_stage_view_receipt_mismatch")
    view_eligibility = _mapping(stage_view.get("eligibility"), "memory_stage_view_eligibility_missing")
    if (view_eligibility.get("external_evaluation") is not True
            or view_eligibility.get("active") is not False or view_eligibility.get("reason") is not None
            or set(view_eligibility) != {"external_evaluation", "active", "reason"}):
        _fail("memory_stage_view_eligibility_state")
    return {
        "schema": "agoragentic.rrsi.memory-envelope.v1",
        "stage_id": task.get("stage_id"),
        "stage_digest": _digest(stage),
        "task_digest": _digest(task),
        "review_claim_digest": _digest(review_claim),
        "review_digest": _digest(review),
        "receipt_digest": _digest(receipt),
        "evidence_class": "memory_reviewed_staged_unverified",
        "scope": {"project_id": scope.get("project_id"), "repo_id": scope.get("repo_id")},
        "evaluation_allowed": False,
        "promotion_allowed": False,
        "memory_written": False,
        "provider_calls": 0,
    }
