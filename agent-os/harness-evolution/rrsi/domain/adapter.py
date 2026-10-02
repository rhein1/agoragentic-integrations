"""RRSI Domain ABI scaffold. Copy this package to domains/agoragentic only in a lab.

Imports two upstream pure contract modules; it never constructs rrsi.loop.Run.
Offline replay is synthetic, so guards always prevent candidate acceptance.
"""
from rrsi.domain import Domain
from rrsi.evaluate import TaskResult
from .contract import ContractError, compile_packet, replay, validate_request


class AgoragenticDomain(Domain):
    name = "agoragentic"
    harness_path = "harness"
    source_exts = {".md"}
    critic_patterns = []  # No regex-only leakage protection is claimed.
    component_signals = [
        ("prompt", [r"harness/prompts/strategy\.md"]),
        ("context_mgmt", [r"harness/prompts/context\.md"]),
    ]
    briefs = {role: "Synthetic offline adapter only; no live host or model is qualified."
              for role in ("analyst", "digester", "proposer", "critic")}

    def __init__(self, request=None, observations=None, arm="candidate"):
        if arm not in ("baseline", "candidate"):
            raise ContractError("invalid_arm")
        self._arm = arm
        self._request = validate_request(request) if request is not None else None
        self._result = replay(request, observations) if request is not None and observations is not None else None

    def evolve_ids(self):
        if self._request is None:
            raise ContractError("domain_not_configured")
        return compile_packet(self._request)["evolve_ids"]

    def heldout_ids(self):
        # Holdouts must use a separate, trusted runner, not search-role access.
        return []

    def smoke_ids(self, incumbent_per_task=None):
        return self.evolve_ids()[:1]

    def run(self, root, runs_dir, job, ids, k, log_prefix=""):
        raise ContractError("live_execution_not_implemented")

    def smoke(self, root, runs_dir, job, ids):
        return False, {"reason": "live_execution_not_implemented", "provider_calls": 0}

    def score(self, runs_dir, job, ids, k):
        if self._result is None:
            raise ContractError("offline_evidence_not_configured")
        if type(k) is not int or k != self._request["limits"]["trials_per_task"] or ids != self.evolve_ids():
            raise ContractError("evaluation_scope_mismatch")
        per = {task: TaskResult(**values) for task, values in self._result["per_task"][self._arm].items()}
        return per, {"evidence_class": "synthetic_fixture", "host_qualified": False,
                     "preflight_violations": list(self._result["preflight_violations"])}

    def guards(self, incumbent, candidate):
        return ["qualified_host_evidence_missing"] + (list(self._result["preflight_violations"]) if self._result else [])

    def load_trial(self, runs_dir, job, task_id, trial):
        # Do not open caller-supplied paths or expose raw evidence to a search role.
        return None

    def render_trace(self, rec, detail=False):
        return "No trusted trace available; fixture replay is not runtime evidence."

    def task_row(self, task_id, rec, tr):
        return "Fixture-only result; not eligible for selection or promotion."


DOMAIN = AgoragenticDomain()  # Deliberately unconfigured; no import-time I/O.
