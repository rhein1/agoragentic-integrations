"""Run with: python claude-agent-sdk/commerce/demo.py

All state is synthetic and in memory. This does not run Claude or import upstream.
"""
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from commerce.fixture import FIXTURE_PRINCIPAL as P, FixtureHost, FixtureStore, GateClosed
from qualification_checks import require


def run():
    store = FixtureStore()
    try:
        store.read_listing(P)
        change = store.stage(P, {"title": "Owner-reviewed local fixture title"})
        try:
            store.apply(P, change["id"])
            raise RuntimeError("unapproved_fixture_changed")
        except GateClosed as error:
            require(str(error) == "approval_required", "unexpected_unapproved_gate_result")
        # This line simulates a host UI approval. It is not a model tool.
        FixtureHost(store).approve(change["id"], change["digest"])
        store.apply(P, change["id"])
        store.apply(P, change["id"])  # Retry must not duplicate the effect.
        require(store.read_listing(P)["title"] == "Owner-reviewed local fixture title",
                "approved_fixture_effect_missing")
        evidence = store.evidence()
        require(sum(event["kind"] == "applied" for event in evidence["events"]) == 1,
                "fixture_effect_count_mismatch")
        return evidence
    finally:
        store.close()


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
