"""Adapter to the pinned upstream MerchantBackend. Optional upstream dependency.

Construct this only with FixtureStore. This is deliberately not a proxy accepting
an arbitrary live backend; adding such a proxy needs authenticated host authority
and an atomic/idempotent business backend contract, not just another callback.
"""
from datetime import datetime, timezone
from typing import Any

from merchant_agent.backend import MerchantBackend
from merchant_agent.changes import ChangeNotApplicable
from merchant_agent.executor import MerchantToolExecutor
from merchant_agent.types import (ActorKind, ChangeItem, ListingDetails,
                                  MerchantSessionContext, StagedChange)
from commerce_common.streaming import ToolOutcome
from commerce.fixture import FixtureStore, GateClosed, LISTING_ID, Principal


class CommerceFixtureBackend(MerchantBackend):
    def __init__(self, store: FixtureStore):
        if type(store) is not FixtureStore:
            raise TypeError("fixture_store_required")
        self.store = store

    @staticmethod
    def principal(session: MerchantSessionContext) -> Principal:
        return Principal(session.merchant_id, session.operator, session.session_id)

    @staticmethod
    def record(row: dict[str, Any]) -> StagedChange:
        body = row["body"]
        return StagedChange(
            change_id=row["id"], kind="listing_update", status=row["status"],
            summary="Synthetic local listing-title edit; no publication or payment.",
            items=[ChangeItem(target=body["target"], field="title", before=body["before"], after=body["after"])],
            created_at=datetime.fromtimestamp(body["created_at"], timezone.utc),
            created_by="fixture-owner", created_by_kind=ActorKind.AGENT,
            applied_at=datetime.fromtimestamp(row["applied_at"], timezone.utc) if row["applied_at"] is not None else None,
            applied_by="fixture-owner" if row["status"] == "applied" else None,
        )

    async def get_listing(self, session, listing_id):
        row = self.store.read_listing(self.principal(session), listing_id)
        # The upstream record requires price. Zero is an explicit fixture value,
        # not a fabricated business metric or an executable commerce quote.
        return ListingDetails(listing_id=row["id"], title=row["title"], price=0,
                              currency="USD", stock=0, status="draft")

    async def search_listings(self, session, query, filters=None, limit=8):
        listing = await self.get_listing(session, LISTING_ID)
        return [listing] if query.lower() in listing.title.lower() else []

    async def stage_listing_update(self, session, listing_id, fields, note=None):
        if listing_id != LISTING_ID:
            raise GateClosed("unknown_listing")
        # The upstream executor's provenance/guardrail checks still run first.
        return self.record(self.store.stage(self.principal(session), fields))

    async def get_pending_changes(self, session):
        return [self.record(row) for row in self.store.pending(self.principal(session))]

    async def apply_change(self, session, change_id):
        return self.record(self.store.apply(self.principal(session), change_id))

    async def discard_change(self, session, change_id, actor_kind=ActorKind.OPERATOR):
        row = self.record(self.store.discard(self.principal(session), change_id))
        return row.model_copy(update={"discarded_by": session.operator, "discarded_by_kind": actor_kind})

    async def _unsupported(self, session, *args, **kwargs):
        self.store.principal_key(self.principal(session))
        raise ChangeNotApplicable("Unavailable in the title-only local fixture.")

    get_business_snapshot = _unsupported
    query_metrics = _unsupported
    get_campaign_performance = _unsupported
    get_inventory_alerts = _unsupported
    get_order_issues = _unsupported
    get_pricing_context = _unsupported
    stage_price_update = _unsupported
    stage_inventory_action = _unsupported
    stage_promotion = _unsupported
    stage_campaign = _unsupported
    execute_analysis_query = _unsupported
    get_analysis_schema = _unsupported

    async def get_merchant_context(self, session):
        self.store.principal_key(self.principal(session))
        return {"limitations": [{"source": "local fixture", "note": "Synthetic title edits only; analytics and monetary operations are unavailable."}]}


class CommerceFixtureExecutor(MerchantToolExecutor):
    """Add a typed fixture denial without replacing upstream executor gates."""
    def domain_error(self, error):
        if isinstance(error, GateClosed):
            return ToolOutcome.held("agoragentic_fixture", str(error))
        return super().domain_error(error)
