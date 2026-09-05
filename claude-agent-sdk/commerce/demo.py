"""Run with: python claude-agent-sdk/commerce/demo.py

All state is synthetic and in memory. This does not run Claude or import upstream.
"""
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from commerce.fixture import FIXTURE_PRINCIPAL as P, FixtureHost, FixtureStore, GateClosed


def run():
    store = FixtureStore()
    try:
        store.read_listing(P)
        change = store.stage(P, {"title": "Owner-reviewed local fixture title"})
        try:
            store.apply(P, change["id"])
            raise AssertionError("unapproved fixture changed")
        except GateClosed as error:
            assert str(error) == "approval_required"
        # This line simulates a host UI approval. It is not a model tool.
        FixtureHost(store).approve(change["id"], change["digest"])
        store.apply(P, change["id"])
        store.apply(P, change["id"])  # Retry must not duplicate the effect.
        assert store.read_listing(P)["title"] == "Owner-reviewed local fixture title"
        evidence = store.evidence()
        assert sum(event["kind"] == "applied" for event in evidence["events"]) == 1
        return evidence
    finally:
        store.close()


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
