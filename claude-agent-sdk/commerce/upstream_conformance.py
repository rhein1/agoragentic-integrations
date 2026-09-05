"""Provider-free integration driver against an explicit, clean upstream checkout.

Missing dependencies, wrong source revision, or import mismatch are failures, not
skips. It exercises the real shared executor, NOT a Messages API/SDK model turn.
"""
import argparse
import asyncio
from pathlib import Path
import sys

from verify_upstream import verify


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkout", required=True, type=Path)
    args = parser.parse_args()
    root = args.checkout.resolve(strict=True)
    verify(root)  # Before importing any upstream Python.
    sys.dont_write_bytecode = True
    sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(root / "commerce-common"),
                    str(root / "merchant-agent" / "core")]
    import merchant_agent
    import commerce_common
    for module, expected in [(merchant_agent, root / "merchant-agent/core/merchant_agent"),
                             (commerce_common, root / "commerce-common/commerce_common")]:
        if Path(module.__file__).resolve().parent != expected.resolve():
            raise RuntimeError("upstream_import_origin_mismatch")
    from commerce.backend import CommerceFixtureBackend, CommerceFixtureExecutor
    from commerce.fixture import FIXTURE_PRINCIPAL as P, FixtureHost, FixtureStore
    from merchant_agent.config import MerchantAgentConfig
    from merchant_agent.types import MerchantSessionContext, MerchantSessionState
    from commerce_common.skills import SkillRegistry

    async def exercise():
        store = FixtureStore()
        try:
            session = MerchantSessionContext(merchant_id=P.merchant_id, operator=P.operator, session_id=P.session_id)
            state = MerchantSessionState()
            config = MerchantAgentConfig(brand_name="Local fixture", require_host_approval=True, enable_memory=False,
                enable_pricing=False, enable_inventory=False, enable_campaigns=False)
            executor = CommerceFixtureExecutor(backend=CommerceFixtureBackend(store), config=config,
                skills=SkillRegistry.from_dir(root / "merchant-agent/skills"), session=session, state=state)
            await executor.execute("stage_listing_update", {"listing_id": "fixture-listing", "fields": {"title": "read required"}})
            assert not store.pending(P), "upstream provenance gate missing"
            await executor.execute("get_listing", {"listing_id": "fixture-listing"})
            await executor.execute("stage_listing_update", {"listing_id": "fixture-listing", "fields": {"title": "upstream fixture edit"}})
            rows = store.pending(P)
            assert len(rows) == 1, "staging did not reach fixture backend"
            change = rows[0]
            await executor.execute("apply_change", {"change_id": change["id"]})
            assert store.change(P, change["id"])["status"] == "staged", "upstream approval gate missing"
            # Upstream approval alone must not bypass the fixture backend gate.
            state.approved_change_ids.add(change["id"])
            await executor.execute("apply_change", {"change_id": change["id"]})
            assert store.change(P, change["id"])["status"] == "staged", "backend gate missing"
            FixtureHost(store).approve(change["id"], change["digest"])
            await executor.execute("apply_change", {"change_id": change["id"]})
            assert store.read_listing(P)["title"] == "upstream fixture edit", "approved effect not applied"
            assert store.change(P, change["id"])["status"] == "applied"
            # A stale upstream approval mark must not authorize a revoked backend change.
            await executor.execute("get_listing", {"listing_id": "fixture-listing"})
            await executor.execute("stage_listing_update", {"listing_id": "fixture-listing", "fields": {"title": "must stay blocked"}})
            revoked = store.pending(P)[0]
            state.approved_change_ids.add(revoked["id"])
            host = FixtureHost(store); host.approve(revoked["id"], revoked["digest"]); host.revoke(revoked["id"])
            await executor.execute("apply_change", {"change_id": revoked["id"]})
            assert store.read_listing(P)["title"] == "upstream fixture edit"
            print("PASS: real pinned shared executor + local fixture backend; model/SDK/MCP runtimes not exercised")
        finally:
            store.close()
    asyncio.run(exercise())


if __name__ == "__main__":
    main()
