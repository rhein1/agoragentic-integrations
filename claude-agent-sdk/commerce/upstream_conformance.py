"""Provider-free integration driver against an explicit, clean upstream checkout.

Missing dependencies, wrong source revision, or import mismatch are failures, not
skips. It exercises the real shared executor, NOT a Messages API/SDK model turn.
"""
import argparse
import asyncio
import json
from importlib.metadata import version
from pathlib import Path
import sys

from verify_upstream import verify
from verify_upstream import PINS


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
    from commerce.fixture import FIXTURE_PRINCIPAL as P, FixtureHost, FixtureStore, digest
    from merchant_agent.config import MerchantAgentConfig
    from merchant_agent.types import MerchantSessionContext, MerchantSessionState
    from commerce_common.skills import SkillRegistry

    async def exercise():
        now = [1000.0]
        store = FixtureStore(clock=lambda: now[0])
        try:
            session = MerchantSessionContext(merchant_id=P.merchant_id, operator=P.operator, session_id=P.session_id)
            state = MerchantSessionState()
            config = MerchantAgentConfig(brand_name="Local fixture", require_host_approval=True, enable_memory=False,
                enable_pricing=False, enable_inventory=False, enable_campaigns=False)
            executor = CommerceFixtureExecutor(backend=CommerceFixtureBackend(store), config=config,
                skills=SkillRegistry.from_dir(root / "merchant-agent/skills"), session=session, state=state)
            held = await executor.execute("stage_listing_update", {"listing_id": "fixture-listing", "fields": {"title": "read required"}})
            assert held.blocked == 'provenance'
            assert not store.pending(P), "upstream provenance gate missing"
            await executor.execute("get_listing", {"listing_id": "fixture-listing"})
            await executor.execute("stage_listing_update", {"listing_id": "fixture-listing", "fields": {"title": "upstream fixture edit"}})
            rows = store.pending(P)
            assert len(rows) == 1, "staging did not reach fixture backend"
            change = rows[0]
            held = await executor.execute("apply_change", {"change_id": change["id"]})
            assert held.blocked == 'approval'
            assert store.change(P, change["id"])["status"] == "staged", "upstream approval gate missing"
            # Upstream approval alone must not bypass the fixture backend gate.
            state.approved_change_ids.add(change["id"])
            held = await executor.execute("apply_change", {"change_id": change["id"]})
            assert held.blocked == 'agoragentic_fixture' and held.result_text == 'approval_required'
            assert store.change(P, change["id"])["status"] == "staged", "backend gate missing"
            FixtureHost(store).approve(change["id"], change["digest"])
            applied = await executor.execute("apply_change", {"change_id": change["id"]})
            assert not applied.refused
            assert any(e.type == 'change_update' and e.data['change']['status'] == 'applied' for e in applied.events)
            assert store.read_listing(P)["title"] == "upstream fixture edit", "approved effect not applied"
            assert store.change(P, change["id"])["status"] == "applied"
            # A stale upstream approval mark must not authorize a revoked backend change.
            await executor.execute("get_listing", {"listing_id": "fixture-listing"})
            await executor.execute("stage_listing_update", {"listing_id": "fixture-listing", "fields": {"title": "must stay blocked"}})
            revoked = store.pending(P)[0]
            state.approved_change_ids.add(revoked["id"])
            host = FixtureHost(store); host.approve(revoked["id"], revoked["digest"]); host.revoke(revoked["id"])
            held = await executor.execute("apply_change", {"change_id": revoked["id"]})
            assert held.blocked == 'agoragentic_fixture' and held.result_text == 'approval_inactive'
            assert store.read_listing(P)["title"] == "upstream fixture edit"
            await executor.execute('discard_change', {'change_id': revoked['id']})

            async def stage(title):
                await executor.execute('get_listing', {'listing_id': 'fixture-listing'})
                result = await executor.execute('stage_listing_update', {
                    'listing_id': 'fixture-listing', 'fields': {'title': title}})
                assert not result.refused
                row, = store.pending(P)
                state.approved_change_ids.add(row['id'])
                host.approve(row['id'], row['digest'])
                return row

            expired = await stage('expired edit')
            now[0] += 60
            held = await executor.execute('apply_change', {'change_id': expired['id']})
            assert held.blocked == 'agoragentic_fixture' and held.result_text == 'approval_expired'
            await executor.execute('discard_change', {'change_id': expired['id']})

            changed = await stage('reviewed edit')
            body = changed['body']; body['after'] = 'changed after review'
            store.db.execute('UPDATE fixture_changes SET body=?, digest=? WHERE id=?',
                             (json.dumps(body), digest(body), changed['id']))
            held = await executor.execute('apply_change', {'change_id': changed['id']})
            assert held.blocked == 'agoragentic_fixture' and held.result_text == 'approval_binding_changed'
            await executor.execute('discard_change', {'change_id': changed['id']})

            guarded = await stage('guardrail edit')
            config.protected_fields = [*config.protected_fields, 'title']
            held = await executor.execute('apply_change', {'change_id': guarded['id']})
            assert held.blocked == 'guardrail', 'current upstream guardrails were bypassed'
            assert store.read_listing(P)['title'] == 'upstream fixture edit'
            assert sum(e['kind'] == 'applied' for e in store.evidence()['events']) == 1
            print(json.dumps({'status': 'passed', 'upstream_commit': PINS['commit'],
                'scope': 'real shared executor and synthetic SQLite backend',
                'cases': ['provenance', 'upstream_approval', 'backend_approval', 'approved_effect',
                          'revocation', 'expiry', 'changed_request', 'current_guardrails'],
                'dependencies': {name: version(name) for name in ['commerce-common', 'merchant-agent-core', 'pydantic', 'anthropic']},
                'module_origins': {'merchant_agent': str(merchant_agent.__file__), 'commerce_common': str(commerce_common.__file__)},
                'fixture_effect_count': 1, 'model_loop_exercised': False,
                'production_authority': False, 'payment_authority': False}, indent=2))
        finally:
            store.close()
    asyncio.run(exercise())


if __name__ == "__main__":
    main()
