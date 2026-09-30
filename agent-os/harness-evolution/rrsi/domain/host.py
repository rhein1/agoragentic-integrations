"""Fail-closed host contracts for source-only RRSI orchestration.

This module is an adapter boundary, not an authority service.  The authority
port must be implemented by the owning host; this package never interprets a
caller supplied ``approved`` flag and never invokes the upstream Run loop.
The in-memory budget store is deliberately a deterministic test double and is
not durable production accounting.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import threading
import re
from functools import wraps
from typing import Mapping, Protocol


class HostContractError(ValueError):
    """Stable, non-sensitive host boundary error."""


def _fail(code: str) -> None:
    raise HostContractError(code)


def _digest(value: object) -> str:
    try:
        raw = json.dumps(value, sort_keys=True, separators=(",", ":"),
                         ensure_ascii=True, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError):
        _fail("invalid_digest_input")
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _iso(value: str) -> datetime:
    if not isinstance(value, str):
        _fail("invalid_authority_expiry")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        _fail("invalid_authority_expiry")
    if parsed.tzinfo is None:
        _fail("invalid_authority_expiry")
    return parsed.astimezone(timezone.utc)


def _fields(value: Mapping[str, object], required: set[str]) -> None:
    if not isinstance(value, Mapping) or set(value) != required:
        _fail("invalid_host_fields")


@dataclass(frozen=True)
class Scope:
    """Exact operation scope bound into every authority and reservation."""

    repository: str
    baseline_commit: str
    candidate_commit: str
    policy_digest: str
    evaluator_digest: str
    model_config_digest: str
    data_digest: str
    resource_digest: str

    def __post_init__(self):
        if self.repository != "rhein1/fable5-codex":
            _fail("unsupported_scope_repository")
        if any(not isinstance(x, str) or re.fullmatch(r"[0-9a-f]{40}", x) is None
               for x in (self.baseline_commit, self.candidate_commit)):
            _fail("invalid_scope_commit")
        if self.baseline_commit == self.candidate_commit:
            _fail("identical_scope_commits")
        if any(not isinstance(x, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", x) is None
               for x in (self.policy_digest, self.evaluator_digest, self.model_config_digest,
                          self.data_digest, self.resource_digest)):
            _fail("invalid_scope_digest")

    @property
    def digest(self) -> str:
        return _digest(self.__dict__)


@dataclass(frozen=True)
class AuthoritySnapshot:
    """Synthetic gate observation, never an authenticated authority record."""
    grant_id: str
    scope_digest: str
    status: str
    expires_at: str
    revision: int

    @classmethod
    def parse(cls, value: Mapping[str, object], *, scope: Scope) -> "AuthoritySnapshot":
        try:
            _fields(value, {"schema", "grant_id", "scope_digest", "status", "expires_at", "revision"})
        except HostContractError:
            _fail("invalid_authority_snapshot")
        if value["schema"] != "agoragentic.rrsi.authority-snapshot.v1":
            _fail("unsupported_authority_snapshot")
        if not isinstance(value["grant_id"], str) or not value["grant_id"]:
            _fail("invalid_authority_snapshot")
        if value["scope_digest"] != scope.digest:
            _fail("authority_scope_mismatch")
        if value["status"] not in {"active", "revoked"}:
            _fail("invalid_authority_status")
        if not isinstance(value["revision"], int) or isinstance(value["revision"], bool) or value["revision"] < 0:
            _fail("invalid_authority_revision")
        _iso(value["expires_at"])
        return cls(value["grant_id"], value["scope_digest"], value["status"], value["expires_at"], value["revision"])


class AuthorityPort(Protocol):
    """Fixture-only observation port; never an authorization implementation."""

    def read(self, grant_id: str, scope_digest: str) -> Mapping[str, object]:
        raise NotImplementedError("authority_port_not_implemented")


class UnavailableAuthority:
    """Default adapter.  Construction never implies authority."""

    def read(self, grant_id: str, scope_digest: str) -> Mapping[str, object]:
        _fail("authority_port_unavailable")


@dataclass
class _Reservation:
    key: str
    scope_digest: str
    cost: int
    tokens: int
    status: str = "reserved"
    actual_cost: int | None = None
    actual_tokens: int | None = None


@dataclass(frozen=True)
class ReservationSnapshot:
    key: str
    scope_digest: str
    cost: int
    tokens: int
    status: str
    actual_cost: int | None = None
    actual_tokens: int | None = None


class BudgetStore:
    """Atomic, process-local reservation test double; not durable accounting."""

    def __init__(self, *, max_cost: int, max_tokens: int):
        if not all(isinstance(x, int) and not isinstance(x, bool) and x >= 0 for x in (max_cost, max_tokens)):
            _fail("invalid_budget_capacity")
        self._capacity = (max_cost, max_tokens)
        self._reserved = [0, 0]
        self._spent = [0, 0]
        self._rows: dict[str, _Reservation] = {}
        self._unknown = False
        self._lock = threading.Lock()

    def reserve(self, key: str, scope_digest: str, cost: int, tokens: int) -> ReservationSnapshot:
        if (not isinstance(key, str) or re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", key) is None
                or not isinstance(scope_digest, str) or re.fullmatch(r"sha256:[a-f0-9]{64}", scope_digest) is None):
            _fail("invalid_reservation")
        if any(not isinstance(x, int) or isinstance(x, bool) or x < 0 for x in (cost, tokens)):
            _fail("invalid_reservation")
        with self._lock:
            if self._unknown:
                _fail("unknown_budget_state")
            old = self._rows.get(key)
            if old:
                if old.scope_digest != scope_digest or (old.cost, old.tokens) != (cost, tokens):
                    _fail("reservation_conflict")
                if old.status != "reserved":
                    _fail("reservation_not_available")
                return ReservationSnapshot(old.key, old.scope_digest, old.cost, old.tokens, old.status,
                                           old.actual_cost, old.actual_tokens)
            if (self._spent[0] + self._reserved[0] + cost > self._capacity[0]
                    or self._spent[1] + self._reserved[1] + tokens > self._capacity[1]):
                _fail("budget_exhausted")
            row = _Reservation(key, scope_digest, cost, tokens)
            self._rows[key] = row
            self._reserved[0] += cost
            self._reserved[1] += tokens
            return ReservationSnapshot(row.key, row.scope_digest, row.cost, row.tokens, row.status)

    def release(self, key: str) -> None:
        with self._lock:
            row = self._rows.get(key)
            if row is None:
                _fail("reservation_not_found")
            if row.status == "released":
                return
            if row.status != "reserved":
                _fail("reservation_not_releasable")
            row.status = "released"
            self._reserved[0] -= row.cost
            self._reserved[1] -= row.tokens

    def mark_unknown(self, key: str) -> None:
        """Hold the full reservation; uncertainty is never treated as free."""
        with self._lock:
            row = self._rows.get(key)
            if row is None or row.status != "reserved":
                _fail("reservation_not_unknownable")
            row.status = "unknown"
            self._unknown = True

    def settle(self, key: str, actual_cost: int, actual_tokens: int) -> None:
        with self._lock:
            row = self._rows.get(key)
            if row is None or row.status != "reserved":
                _fail("reservation_not_settleable")
            if any(not isinstance(x, int) or isinstance(x, bool) or x < 0 for x in (actual_cost, actual_tokens)):
                _fail("invalid_settlement")
            if actual_cost > row.cost or actual_tokens > row.tokens:
                row.status = "unknown"
                self._unknown = True
                _fail("settlement_exceeds_reservation")
            row.status = "settled"
            row.actual_cost = actual_cost
            row.actual_tokens = actual_tokens
            self._reserved[0] -= row.cost
            self._reserved[1] -= row.tokens
            self._spent[0] += actual_cost
            self._spent[1] += actual_tokens

    def reconcile_unknown(self, key: str, actual_cost: int, actual_tokens: int) -> None:
        with self._lock:
            row = self._rows.get(key)
            if row is None or row.status != "unknown":
                _fail("unknown_reconciliation_required")
            if any(not isinstance(x, int) or isinstance(x, bool) or x < 0 for x in (actual_cost, actual_tokens)):
                _fail("invalid_settlement")
            # Reconciliation records overruns rather than discarding real
            # consumption. An over-capacity campaign then admits no new work.
            row.status = "settled"
            row.actual_cost = actual_cost
            row.actual_tokens = actual_tokens
            self._reserved[0] -= row.cost
            self._reserved[1] -= row.tokens
            self._spent[0] += actual_cost
            self._spent[1] += actual_tokens
            self._unknown = any(item.status == "unknown" for item in self._rows.values())

    def snapshot(self) -> Mapping[str, object]:
        with self._lock:
            return {"capacity": tuple(self._capacity), "reserved": tuple(self._reserved),
                    "spent": tuple(self._spent), "unknown": self._unknown}


@dataclass(frozen=True)
class RunLease:
    request_id: str
    grant_id: str
    scope_digest: str
    reservation_key: str
    authority_revision: int
    state: str = "reserved"


class HostOrchestrator:
    """Hard-off host seam; no real authority adapter exists in this repository."""

    def __init__(self, authority: AuthorityPort | None = None, budget: BudgetStore | None = None):
        # ``authority`` is accepted only so fixture callers fail with a stable
        # hard-off result; it is never consulted as permission.
        self.authority = authority
        self.budget = budget
        self._leases: dict[str, RunLease] = {}

    def start(self, *, request_id: str, scope: Scope, grant_id: str, estimated_cost: int,
              estimated_tokens: int, now: str, run_factory=None) -> RunLease:
        """Refuse before upstream Run, analysis, model work, or reservation."""
        _fail("host_adapter_not_implemented")

    def resume(self, *, lease: RunLease, scope: Scope, now: str) -> RunLease:
        _fail("host_adapter_not_implemented")

    def revoke(self, *, lease: RunLease, scope: Scope, now: str) -> None:
        _fail("host_adapter_not_implemented")

    def invoke(self, *_args, **_kwargs):
        _fail("live_execution_disabled")


def _serialized(method):
    @wraps(method)
    def locked(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)
    return locked


class SyntheticHostSession:
    """Exercise gates and accounting using synthetic observations only.

    This is not an upstream Run replacement or a grant verifier. No callbacks,
    subprocesses, imports, files, models, worktrees, Memory or promotion run here.
    The fixed trace covers host checkpoints around one illustrative candidate;
    actual RRSI search/selection equations remain upstream responsibilities.
    """

    PHASES = ("analysis", "worktree", "proposal", "critic", "train_evaluation",
              "selection", "heldout_evaluation")

    def __init__(self, *, request_id: str, scope: Scope, budget: BudgetStore):
        if not isinstance(request_id, str) or re.fullmatch(r"[a-z0-9-]{1,48}", request_id) is None:
            _fail("invalid_request_id")
        if type(scope) is not Scope or type(budget) is not BudgetStore:
            _fail("synthetic_host_inputs_required")
        self.request_id = request_id
        self.scope = scope
        self.budget = budget
        self._events: list[dict[str, object]] = []
        self._state = "ready"
        self._next = 0
        self._grant_id = None
        self._revision = -1
        self._unknown_key = None
        self._lock = threading.RLock()

    def _gate(self, observation: Mapping[str, object], now: str) -> None:
        grant = AuthoritySnapshot.parse(observation, scope=self.scope)
        if self._state == "revoked":
            _fail("synthetic_session_revoked")
        if grant.status != "active":
            self._state = "revoked"
            _fail("synthetic_grant_revoked")
        if _iso(grant.expires_at) <= _iso(now):
            _fail("synthetic_grant_expired")
        if self._grant_id is not None and grant.grant_id != self._grant_id:
            _fail("synthetic_grant_lineage_changed")
        if grant.revision < self._revision:
            _fail("synthetic_grant_revision_regressed")
        self._grant_id = grant.grant_id
        self._revision = grant.revision

    @_serialized
    def advance(self, phase: str, *, observation: Mapping[str, object], now: str,
                estimated_cost: int, estimated_tokens: int, outcome: str,
                actual_cost: int | None = None, actual_tokens: int | None = None) -> Mapping[str, object]:
        if self._state != "ready" or self._next >= len(self.PHASES) or phase != self.PHASES[self._next]:
            _fail("synthetic_phase_not_available")
        if outcome not in {"completed", "failed", "unknown"}:
            _fail("invalid_synthetic_outcome")
        if any(type(x) is not int or x <= 0 for x in (estimated_cost, estimated_tokens)):
            _fail("positive_all_in_estimate_required")
        if outcome != "unknown" and any(type(x) is not int or x < 0 for x in (actual_cost, actual_tokens)):
            _fail("known_all_in_observation_required")
        # The checks intentionally precede recording even a simulated step.
        self._gate(observation, now)
        key = f"{self.request_id}:{len(self._events)}"
        self.budget.reserve(key, self.scope.digest, estimated_cost, estimated_tokens)
        if outcome == "unknown":
            self.budget.mark_unknown(key)
            self._unknown_key = key
            self._state = "paused"
        else:
            try:
                self.budget.settle(key, actual_cost, actual_tokens)
            except HostContractError:
                self._unknown_key = key
                self._state = "paused"
                self._events.append({"phase": phase, "outcome": "overrun", "reservation": key})
                raise
            if outcome == "failed":
                self._state = "paused"
            else:
                self._next += 1
                if self._next == len(self.PHASES):
                    self._state = "completed"
        self._events.append({"phase": phase, "outcome": outcome, "reservation": key})
        return self.snapshot()

    @_serialized
    def reconcile_unknown(self, *, actual_cost: int, actual_tokens: int) -> None:
        if self._unknown_key is None:
            _fail("synthetic_unknown_result_required")
        self.budget.reconcile_unknown(self._unknown_key, actual_cost, actual_tokens)
        self._unknown_key = None
        # The attempt remains unresolved as an outcome; explicit scoped resume
        # is required. Cost reconciliation never creates permission or success.

    @_serialized
    def snapshot(self) -> Mapping[str, object]:
        result = {"schema": "agoragentic.rrsi.synthetic-session.v1", "request_id": self.request_id,
                  "scope_digest": self.scope.digest, "state": self._state, "next_phase": self._next,
                  "grant_id": self._grant_id, "revision": self._revision, "budget": self.budget.snapshot(),
                  "evidence_class": "synthetic_control_flow", "provider_calls": 0,
                  "execution_authority": False, "promotion_allowed": False,
                  "events": [dict(event) for event in self._events]}
        return {**result, "checkpoint_digest": _digest(result)}

    @_serialized
    def revoke(self) -> None:
        self._state = "revoked"

    @_serialized
    def resume(self, *, checkpoint_digest: str, scope: Scope,
               observation: Mapping[str, object], now: str) -> Mapping[str, object]:
        if self._state != "paused" or self._unknown_key or self.budget.snapshot()["unknown"]:
            _fail("synthetic_resume_not_available")
        if scope != self.scope or checkpoint_digest != self.snapshot()["checkpoint_digest"]:
            _fail("synthetic_resume_lineage_mismatch")
        self._gate(observation, now)
        self._state = "ready"
        return self.snapshot()
