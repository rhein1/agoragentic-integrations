import copy
import threading
import unittest
import sys
from pathlib import Path
from datetime import datetime, timezone, timedelta

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from domain.host import (
    AuthoritySnapshot, BudgetStore, HostContractError, HostOrchestrator,
    Scope, SyntheticHostSession,
)


NOW = "2026-09-30T12:00:00Z"


def scope():
    return Scope("rhein1/fable5-codex", "a" * 40, "b" * 40,
                 "sha256:" + "1" * 64, "sha256:" + "2" * 64,
                 "sha256:" + "3" * 64, "sha256:" + "4" * 64,
                 "sha256:" + "5" * 64)


class Authority:
    def __init__(self, value): self.value = value; self.calls = 0
    def read(self, grant_id, scope_digest): self.calls += 1; return copy.deepcopy(self.value)


def authority(s, status="active", expiry="2026-09-30T13:00:00Z", revision=1):
    return {"schema": "agoragentic.rrsi.authority-snapshot.v1", "grant_id": "grant-1",
            "scope_digest": s.digest, "status": status, "expires_at": expiry, "revision": revision}


class HostTests(unittest.TestCase):
    def test_denial_happens_before_run_and_provider(self):
        s = scope(); a = Authority(authority(s, status="revoked")); calls = []
        host = HostOrchestrator(a, BudgetStore(max_cost=10, max_tokens=10))
        with self.assertRaisesRegex(HostContractError, "host_adapter_not_implemented"):
            host.start(request_id="r1", scope=s, grant_id="grant-1", estimated_cost=1,
                       estimated_tokens=1, now=NOW, run_factory=lambda: calls.append(1))
        self.assertEqual(calls, []); self.assertEqual(a.calls, 0)

    def test_reservation_is_atomic_under_parallel_contention(self):
        s = scope(); budget = BudgetStore(max_cost=1, max_tokens=1); results = []
        def reserve(i):
            try: budget.reserve(f"r{i}", s.digest, 1, 1)
            except HostContractError as e: results.append(e.args[0])
        threads = [threading.Thread(target=reserve, args=(i,)) for i in range(2)]
        for t in threads: t.start()
        for t in threads: t.join()
        self.assertEqual(results, ["budget_exhausted"])

    def test_resume_and_revoke_are_hardoff_until_real_host_adapter_exists(self):
        s = scope(); host = HostOrchestrator(None, BudgetStore(max_cost=5, max_tokens=5))
        with self.assertRaisesRegex(HostContractError, "host_adapter_not_implemented"):
            host.resume(lease=None, scope=s, now=NOW)
        with self.assertRaisesRegex(HostContractError, "host_adapter_not_implemented"):
            host.revoke(lease=None, scope=s, now=NOW)

    def test_settle_retains_cumulative_spend_and_unknown_holds_capacity(self):
        budget = BudgetStore(max_cost=5, max_tokens=5)
        budget.reserve("a", "sha256:" + "a" * 64, 3, 3)
        budget.settle("a", 2, 2)
        with self.assertRaisesRegex(HostContractError, "budget_exhausted"):
            budget.reserve("b", "sha256:" + "b" * 64, 4, 1)
        budget.reserve("c", "sha256:" + "c" * 64, 1, 1)
        budget.mark_unknown("c")
        with self.assertRaisesRegex(HostContractError, "unknown_budget_state"):
            budget.reserve("d", "sha256:" + "d" * 64, 1, 1)
        budget.reconcile_unknown("c", 1, 1)

    def test_synthetic_session_gates_before_every_side_effect(self):
        s = scope()
        session = SyntheticHostSession(request_id="r1", scope=s, budget=BudgetStore(max_cost=20, max_tokens=20))
        for phase in session.PHASES:
            before = session.snapshot()
            with self.assertRaisesRegex(HostContractError, "synthetic_grant_expired"):
                session.advance(phase, observation=authority(s, expiry=NOW), now=NOW,
                                estimated_cost=2, estimated_tokens=2, outcome="completed", actual_cost=1, actual_tokens=1)
            self.assertEqual(before, session.snapshot())
            result = session.advance(phase, observation=authority(s), now=NOW,
                                     estimated_cost=2, estimated_tokens=2, outcome="completed", actual_cost=1, actual_tokens=1)
            self.assertFalse(result["execution_authority"])
            self.assertFalse(result["promotion_allowed"])
            self.assertEqual(result["provider_calls"], 0)
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["budget"]["spent"], (7, 7))
        self.assertEqual(result["budget"]["reserved"], (0, 0))

    def test_failed_attempt_costs_persist_and_resume_requires_exact_lineage(self):
        s = scope(); budget = BudgetStore(max_cost=4, max_tokens=4)
        session = SyntheticHostSession(request_id="r1", scope=s, budget=budget)
        session.advance("analysis", observation=authority(s), now=NOW,
                        estimated_cost=3, estimated_tokens=3, outcome="failed", actual_cost=2, actual_tokens=2)
        checkpoint = session.snapshot()["checkpoint_digest"]
        with self.assertRaisesRegex(HostContractError, "synthetic_phase_not_available"):
            session.advance("analysis", observation=authority(s), now=NOW,
                            estimated_cost=1, estimated_tokens=1, outcome="completed", actual_cost=1, actual_tokens=1)
        with self.assertRaisesRegex(HostContractError, "synthetic_resume_lineage_mismatch"):
            session.resume(checkpoint_digest="sha256:" + "0" * 64, scope=s, observation=authority(s), now=NOW)
        from dataclasses import replace
        with self.assertRaisesRegex(HostContractError, "synthetic_resume_lineage_mismatch"):
            session.resume(checkpoint_digest=checkpoint, scope=replace(s, model_config_digest="sha256:" + "a" * 64), observation=authority(s), now=NOW)
        session.resume(checkpoint_digest=checkpoint, scope=s, observation=authority(s, revision=2), now=NOW)
        with self.assertRaisesRegex(HostContractError, "budget_exhausted"):
            session.advance("analysis", observation=authority(s, revision=2), now=NOW,
                            estimated_cost=3, estimated_tokens=3, outcome="completed", actual_cost=1, actual_tokens=1)
        result = session.advance("analysis", observation=authority(s, revision=2), now=NOW,
                                 estimated_cost=2, estimated_tokens=2, outcome="completed", actual_cost=2, actual_tokens=2)
        self.assertEqual(result["budget"]["spent"], (4, 4))
        self.assertEqual(len(result["events"]), 2)

    def test_unknown_cost_and_overruns_suspend_every_session_until_reconciled(self):
        s = scope(); budget = BudgetStore(max_cost=3, max_tokens=3)
        session = SyntheticHostSession(request_id="r1", scope=s, budget=budget)
        before = session.snapshot()["checkpoint_digest"]
        session.advance("analysis", observation=authority(s), now=NOW,
                        estimated_cost=2, estimated_tokens=2, outcome="unknown")
        with self.assertRaisesRegex(HostContractError, "synthetic_resume_not_available"):
            session.resume(checkpoint_digest=before, scope=s, observation=authority(s), now=NOW)
        with self.assertRaisesRegex(HostContractError, "unknown_budget_state"):
            budget.reserve("other", s.digest, 1, 1)
        session.reconcile_unknown(actual_cost=1, actual_tokens=1)
        with self.assertRaisesRegex(HostContractError, "synthetic_resume_lineage_mismatch"):
            session.resume(checkpoint_digest=before, scope=s, observation=authority(s), now=NOW)
        session.resume(checkpoint_digest=session.snapshot()["checkpoint_digest"], scope=s, observation=authority(s), now=NOW)
        with self.assertRaisesRegex(HostContractError, "settlement_exceeds_reservation"):
            session.advance("analysis", observation=authority(s), now=NOW,
                            estimated_cost=1, estimated_tokens=1, outcome="completed", actual_cost=4, actual_tokens=4)
        self.assertTrue(budget.snapshot()["unknown"])
        session.reconcile_unknown(actual_cost=4, actual_tokens=4)
        self.assertEqual(budget.snapshot()["spent"], (5, 5))
        with self.assertRaisesRegex(HostContractError, "budget_exhausted"):
            budget.reserve("after", s.digest, 1, 1)

    def test_revocation_revision_regression_and_new_grant_cannot_resume(self):
        s = scope()
        for change, message in [({"revision": 0}, "revision_regressed"),
                                ({"grant_id": "different"}, "lineage_changed"),
                                ({"status": "revoked"}, "grant_revoked")]:
            session = SyntheticHostSession(request_id="r1", scope=s, budget=BudgetStore(max_cost=10, max_tokens=10))
            session.advance("analysis", observation=authority(s), now=NOW,
                            estimated_cost=1, estimated_tokens=1, outcome="failed", actual_cost=1, actual_tokens=1)
            with self.assertRaisesRegex(HostContractError, message):
                session.resume(checkpoint_digest=session.snapshot()["checkpoint_digest"], scope=s,
                               observation={**authority(s), **change}, now=NOW)
        session.revoke()
        with self.assertRaisesRegex(HostContractError, "synthetic_resume_not_available"):
            session.resume(checkpoint_digest=session.snapshot()["checkpoint_digest"], scope=s, observation=authority(s), now=NOW)

    def test_request_replay_conflicting_scope_and_mutable_snapshots_cannot_expand_budget(self):
        s = scope(); budget = BudgetStore(max_cost=2, max_tokens=2)
        row = budget.reserve("r1", s.digest, 2, 2)
        self.assertEqual(budget.reserve("r1", s.digest, 2, 2), row)
        self.assertEqual(budget.snapshot()["reserved"], (2, 2))
        from dataclasses import FrozenInstanceError
        with self.assertRaises(FrozenInstanceError): row.cost = 0
        with self.assertRaisesRegex(HostContractError, "reservation_conflict"):
            budget.reserve("r1", "sha256:" + "f" * 64, 2, 2)
        with self.assertRaisesRegex(HostContractError, "reservation_conflict"):
            budget.reserve("r1", s.digest, 1, 2)
        budget.settle("r1", 2, 2)
        with self.assertRaisesRegex(HostContractError, "reservation_not_available"):
            budget.reserve("r1", s.digest, 2, 2)
        with self.assertRaisesRegex(HostContractError, "budget_exhausted"):
            budget.reserve("r2", s.digest, 1, 1)

    def test_scope_and_revision_are_not_caller_approved_flags(self):
        s = scope(); raw = authority(s); raw["approved"] = True
        with self.assertRaisesRegex(HostContractError, "invalid_authority_snapshot"):
            AuthoritySnapshot.parse(raw, scope=s)

    def test_same_session_parallel_advance_is_serialized(self):
        s = scope(); session = SyntheticHostSession(request_id="same", scope=s, budget=BudgetStore(max_cost=10, max_tokens=10))
        barrier = threading.Barrier(2); results = []
        def advance():
            barrier.wait(timeout=5)
            try:
                session.advance("analysis", observation=authority(s), now=NOW,
                                estimated_cost=1, estimated_tokens=1, outcome="completed", actual_cost=1, actual_tokens=1)
                results.append("completed")
            except HostContractError as error:
                results.append(str(error))
        workers = [threading.Thread(target=advance) for _ in range(2)]
        for worker in workers: worker.start()
        for worker in workers: worker.join(timeout=5)
        self.assertCountEqual(results, ["completed", "synthetic_phase_not_available"])
        self.assertEqual(session.snapshot()["state"], "ready")
        self.assertEqual(session.snapshot()["budget"]["spent"], (1, 1))
        self.assertFalse(session.snapshot()["budget"]["unknown"])


if __name__ == "__main__": unittest.main()
