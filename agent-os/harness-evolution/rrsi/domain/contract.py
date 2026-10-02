"""Offline RRSI preparation contracts. No provider, Git, or promotion authority."""
from __future__ import annotations

import hashlib
import json
import math
import re

UPSTREAM_COMMIT = "be50316e1db05914068a973f322770ef08ed7ba1"
SCHEMA = "agoragentic.rrsi.request.v1"
PATH_COMPONENTS = {
    "harness/prompts/strategy.md": "prompt",
    "harness/prompts/context.md": "context_mgmt",
}
VIOLATIONS = {"authority", "privacy", "evidence", "unsupported_claim", "critical_regression"}


class ContractError(ValueError):
    """Stable, non-sensitive error code; do not include user input in errors."""


def require(ok, code):
    if not ok:
        raise ContractError(code)


def data(value, depth=0, budget=None):
    budget = [0] if budget is None else budget
    budget[0] += 1
    require(depth <= 16 and budget[0] <= 20000, "input_too_complex")
    t = type(value)
    if value is None or t is bool:
        return value
    if t is str:
        require(len(value) <= 4096, "string_too_long")
        require(not any(0xD800 <= ord(c) <= 0xDFFF for c in value), "invalid_unicode")
        return value
    if t is int:
        require(abs(value) <= 2**53 - 1, "unsafe_integer")
        return value
    if t is float:
        require(math.isfinite(value), "nonfinite_number")
        return value
    if t is list:
        return [data(v, depth + 1, budget) for v in value]
    require(t is dict, "json_data_required")
    require(all(type(k) is str and k not in {"__proto__", "constructor", "prototype"} for k in value), "unsafe_key")
    return {data(k, depth + 1, budget): data(v, depth + 1, budget) for k, v in value.items()}


def fields(value, names):
    require(type(value) is dict and set(value) == set(names.split()), "invalid_fields")


def integer(value, low, high, code):
    require(type(value) is int and low <= value <= high, code)


def identifier(value):
    require(type(value) is str and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", value) is not None, "invalid_identifier")


def sha(value, git=False):
    pattern = r"[0-9a-f]{40}" if git else r"sha256:[0-9a-f]{64}"
    require(type(value) is str and re.fullmatch(pattern, value) is not None, "invalid_digest")


def digest(value):
    encoded = json.dumps(data(value), sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def validate_request(value):
    r = data(value)
    fields(r, "schema run_id target edits tasks limits")
    require(r["schema"] == SCHEMA, "unsupported_schema")
    identifier(r["run_id"])
    t = r["target"]
    fields(t, "repository baseline_commit candidate_commit policy_digest evaluator_digest model_config_digest")
    require(t["repository"] == "rhein1/fable5-codex", "unsupported_target")
    for key in ("baseline_commit", "candidate_commit"):
        sha(t[key], git=True)
    require(t["baseline_commit"] != t["candidate_commit"], "identical_candidate")
    for key in ("policy_digest", "evaluator_digest", "model_config_digest"):
        sha(t[key])
    limits = r["limits"]
    fields(limits, "max_edits trials_per_task max_policy_tokens max_cost_microusd max_trial_seconds")
    integer(limits["max_edits"], 1, 2, "invalid_edit_budget")
    integer(limits["trials_per_task"], 1, 10, "invalid_trials")
    integer(limits["max_policy_tokens"], 1, 1000000, "invalid_token_budget")
    integer(limits["max_cost_microusd"], 1, 100000000, "invalid_cost_budget")
    integer(limits["max_trial_seconds"], 1, 600, "invalid_deadline")
    require(type(r["edits"]) is list and 1 <= len(r["edits"]) <= limits["max_edits"], "edit_budget_exceeded")
    paths, hypotheses = set(), set()
    for edit in r["edits"]:
        fields(edit, "path component hypothesis_id diff_digest")
        require(type(edit["path"]) is str and edit["path"] in PATH_COMPONENTS, "protected_or_unknown_path")
        require(edit["component"] == PATH_COMPONENTS[edit["path"]], "component_mismatch")
        identifier(edit["hypothesis_id"])
        sha(edit["diff_digest"])
        require(edit["path"] not in paths and edit["hypothesis_id"] not in hypotheses, "duplicate_edit")
        paths.add(edit["path"])
        hypotheses.add(edit["hypothesis_id"])
    require(type(r["tasks"]) is list and 3 <= len(r["tasks"]) <= 100, "invalid_tasks")
    ids, families, splits = set(), {}, set()
    for task in r["tasks"]:
        fields(task, "id family split")
        identifier(task["id"])
        identifier(task["family"])
        require(task["split"] in ("evolve", "heldout", "ood"), "invalid_split")
        require(task["id"] not in ids, "duplicate_task")
        require(families.get(task["family"], task["split"]) == task["split"], "family_split_leakage")
        ids.add(task["id"])
        families[task["family"]] = task["split"]
        splits.add(task["split"])
    require(splits == {"evolve", "heldout", "ood"}, "missing_split")
    return r


def compile_packet(value):
    r = validate_request(value)
    return {
        "schema": "agoragentic.rrsi.packet.v1",
        "run_id": r["run_id"], "request_digest": digest(r),
        "upstream_commit": UPSTREAM_COMMIT, "target": r["target"],
        "edits": r["edits"], "limits": r["limits"],
        "evolve_ids": [t["id"] for t in r["tasks"] if t["split"] == "evolve"],
        "split_digests": {s: digest([t for t in r["tasks"] if t["split"] == s]) for s in ("evolve", "heldout", "ood")},
        "status": "offline_proposal", "authority_granted": False,
        "budgets_enforced": False, "host_qualified": False,
    }


def replay(value, observations):
    """Replay synthetic evolve observations; do not select or authorize a winner."""
    r = validate_request(value)
    packet = compile_packet(r)
    rows = data(observations)
    require(type(rows) is list and len(rows) <= 2000, "invalid_observations")
    ids = packet["evolve_ids"]
    k = r["limits"]["trials_per_task"]
    indexed = {}
    evidence_ids = set()
    for row in rows:
        fields(row, "source_class request_digest arm task_id trial commit status reward policy_tokens cost_microusd duration_ms violations evidence_digest")
        require(row["source_class"] == "synthetic_fixture", "unqualified_evidence_source")
        require(row["request_digest"] == packet["request_digest"], "request_binding_mismatch")
        require(row["arm"] in ("baseline", "candidate"), "invalid_arm")
        require(row["task_id"] in ids, "non_evolve_trial")
        integer(row["trial"], 0, k - 1, "invalid_trial")
        require(row["commit"] == r["target"][row["arm"] + "_commit"], "commit_mismatch")
        key = (row["arm"], row["task_id"], row["trial"])
        require(key not in indexed, "duplicate_trial")
        sha(row["evidence_digest"])
        require(row["evidence_digest"] not in evidence_ids, "reused_evidence")
        evidence_ids.add(row["evidence_digest"])
        require(row["status"] in ("completed", "failed", "timeout"), "invalid_terminal_status")
        require(type(row["reward"]) in (int, float) and 0 <= row["reward"] <= 1, "invalid_reward")
        require(row["status"] == "completed" or row["reward"] == 0, "failed_trial_reward")
        for key_name in ("policy_tokens", "cost_microusd"):
            if row[key_name] is not None:
                integer(row[key_name], 0, 1000000000, "invalid_cost")
        integer(row["duration_ms"], 0, 86400000, "invalid_duration")
        require(type(row["violations"]) is list and all(type(v) is str and v in VIOLATIONS for v in row["violations"]), "invalid_violations")
        require(len(row["violations"]) == len(set(row["violations"])), "duplicate_violation")
        indexed[key] = row
    summaries = {}
    per_task = {}
    for arm in ("baseline", "candidate"):
        slots = [indexed.get((arm, task, trial)) for task in ids for trial in range(k)]
        missing = sum(s is None for s in slots)
        tokens_complete = all(s is not None and s["policy_tokens"] is not None for s in slots)
        cost_complete = all(s is not None and s["cost_microusd"] is not None for s in slots)
        summaries[arm] = {
            "expected": len(slots), "missing": missing,
            "failed": sum(s is not None and s["status"] != "completed" for s in slots),
            "score": sum(s["reward"] if s else 0 for s in slots) / len(slots),
            "tokens_complete": tokens_complete, "cost_complete": cost_complete,
            "policy_tokens": sum(s["policy_tokens"] for s in slots) if tokens_complete else None,
            "cost_microusd": sum(s["cost_microusd"] for s in slots) if cost_complete else None,
            "violations": sorted({v for s in slots if s for v in s["violations"]}),
            "deadline_exceeded": any(s and s["duration_ms"] > r["limits"]["max_trial_seconds"] * 1000 for s in slots),
        }
        per_task[arm] = {}
        for task in ids:
            trials = [indexed.get((arm, task, j)) for j in range(k)]
            per_task[arm][task] = {
                "rewards": [s["reward"] if s else 0.0 for s in trials],
                "weights": [1.0] * k,
                "tokens": [s["policy_tokens"] if s else None for s in trials],
                "missing": sum(s is None for s in trials),
            }
    guards = []
    for arm, s in summaries.items():
        if s["missing"]:
            guards.append(arm + "_missing_trials")
        if not s["tokens_complete"] or not s["cost_complete"]:
            guards.append(arm + "_incomplete_cost")
        if any(row["arm"] == arm and row["policy_tokens"] == 0 for row in rows):
            guards.append(arm + "_zero_token_cost_undefined")
        if s["violations"]:
            guards.append(arm + "_noncompensatory_violation")
        if s["deadline_exceeded"]:
            guards.append(arm + "_deadline_exceeded")
    if summaries["candidate"]["failed"] > summaries["baseline"]["failed"]:
        guards.append("failure_rate_regression")
    for metric, limit in (("policy_tokens", "max_policy_tokens"), ("cost_microusd", "max_cost_microusd")):
        # Include known costs of incomplete trials; missing values are never free.
        known_total = sum(row[metric] for row in rows if row[metric] is not None)
        if known_total > r["limits"][limit]:
            guards.append(metric + "_campaign_budget_exceeded")
    return {
        "schema": "agoragentic.rrsi.replay.v1", "request_digest": packet["request_digest"],
        "observations_digest": digest(rows), "summaries": summaries, "per_task": per_task,
        "preflight_violations": guards, "selection_evaluated": False,
        "evidence_class": "synthetic_fixture", "verified": False,
        "promotion_allowed": False, "provider_calls": 0,
    }


def history_proposal(value, observations):
    r = validate_request(value)
    result = replay(r, observations)
    return {
        "schema": "agoragentic.rrsi.history-proposal.v1",
        "run_id": r["run_id"], "request_digest": result["request_digest"],
        "observations_digest": result["observations_digest"],
        "hypothesis_ids": [e["hypothesis_id"] for e in r["edits"]],
        "baseline_commit": r["target"]["baseline_commit"],
        "candidate_commit": r["target"]["candidate_commit"],
        "outcome": "blocked" if result["preflight_violations"] else "offline_replay_only",
        "evidence_class": "synthetic_fixture", "memory_written": False,
        "accepted_incumbent": False, "installed": False, "authority_granted": False,
    }
