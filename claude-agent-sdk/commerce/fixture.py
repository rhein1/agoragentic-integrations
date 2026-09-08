"""Local SQLite demonstration, NOT a merchant connector or production authority.

Only a synthetic listing title can change. A host-only FixtureHost simulates the
approval surface; it is never registered as a model tool. No credentials, HTTP,
wallet, subprocess, provider, or payment implementation exists in this module.
Canonical Harness policy/receipts remain external; see harness-evidence.mjs.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from typing import Any, Callable


class GateClosed(Exception):
    """A fixed reason code; never include untrusted content or credentials."""


def digest(value: Any) -> str:
    data = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Principal:
    merchant_id: str
    operator: str
    session_id: str

    def __post_init__(self):
        for value in asdict(self).values():
            if type(value) is not str or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value):
                raise ValueError("invalid_fixture_principal")


FIXTURE_PRINCIPAL = Principal("fixture-merchant", "fixture-owner", "fixture-session")
LISTING_ID = "fixture-listing"


class FixtureStore:
    """Owns synthetic state only. The path must be a trusted local fixture DB.

    Reopening is supported for restart tests, not for untrusted multi-tenant use.
    SQLite commits the title, consumed approval, and evidence together. No
    production/backend operation can be supplied to this constructor.
    """
    def __init__(self, path: str = ":memory:", *, clock: Callable[[], float] = time.time):
        self.clock = clock
        self.db = sqlite3.connect(path, isolation_level=None, timeout=3)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS fixture_listing (
              id TEXT PRIMARY KEY, title TEXT NOT NULL, version INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS fixture_policy (
              id INTEGER PRIMARY KEY CHECK (id=1), revision INTEGER NOT NULL, paused INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS fixture_reads (
              principal TEXT PRIMARY KEY, version INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS fixture_changes (
              id TEXT PRIMARY KEY, principal TEXT NOT NULL, body TEXT NOT NULL,
              digest TEXT NOT NULL, status TEXT NOT NULL, applied_at REAL);
            CREATE TABLE IF NOT EXISTS fixture_approvals (
              change_id TEXT PRIMARY KEY, digest TEXT NOT NULL, revision INTEGER NOT NULL,
              expires REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
              consumed INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS fixture_events (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
              change_id TEXT, evidence_json TEXT NOT NULL);
        """)
        self.db.execute("INSERT OR IGNORE INTO fixture_listing VALUES (?, ?, 1)",
                        (LISTING_ID, "Original fixture title"))
        self.db.execute("INSERT OR IGNORE INTO fixture_policy VALUES (1, 1, 0)")

    def close(self) -> None:
        self.db.close()

    @contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    @staticmethod
    def principal_key(principal: Principal) -> str:
        if type(principal) is not Principal or principal != FIXTURE_PRINCIPAL:
            raise GateClosed("principal_mismatch")
        return digest(asdict(principal))

    def _event(self, kind: str, change_id: str | None, **evidence: Any) -> None:
        self.db.execute("INSERT INTO fixture_events(kind, change_id, evidence_json) VALUES (?, ?, ?)",
                        (kind, change_id, json.dumps(evidence, sort_keys=True, allow_nan=False)))

    def read_listing(self, principal: Principal, listing_id: str = LISTING_ID) -> dict[str, Any]:
        key = self.principal_key(principal)
        if listing_id != LISTING_ID:
            raise GateClosed("unknown_listing")
        with self.transaction():
            row = dict(self.db.execute("SELECT * FROM fixture_listing WHERE id=?", (listing_id,)).fetchone())
            self.db.execute("INSERT OR REPLACE INTO fixture_reads VALUES (?, ?)", (key, row["version"]))
        return row

    def stage(self, principal: Principal, fields: dict[str, Any]) -> dict[str, Any]:
        key = self.principal_key(principal)
        if type(fields) is not dict or set(fields) != {"title"}:
            raise GateClosed("title_only_fixture")
        title = fields["title"]
        if type(title) is not str or not 1 <= len(title) <= 120 or any(ord(c) < 32 or ord(c) == 127 for c in title):
            raise GateClosed("invalid_title")
        with self.transaction():
            listing = dict(self.db.execute("SELECT * FROM fixture_listing WHERE id=?", (LISTING_ID,)).fetchone())
            seen = self.db.execute("SELECT version FROM fixture_reads WHERE principal=?", (key,)).fetchone()
            if seen is None or seen["version"] != listing["version"]:
                raise GateClosed("read_current_listing_first")
            if self.db.execute("SELECT count(*) FROM fixture_changes WHERE status='staged'").fetchone()[0] >= 100:
                raise GateClosed("fixture_queue_full")
            body = {"principal": key, "action": "listing_update", "target": LISTING_ID,
                    "field": "title", "before": listing["title"], "after": title,
                    "version": listing["version"], "effect_scope": "fixture_sqlite", "created_at": self.clock()}
            change_id = "fixture_" + uuid.uuid4().hex
            self.db.execute("INSERT INTO fixture_changes VALUES (?, ?, ?, ?, 'staged', NULL)",
                            (change_id, key, json.dumps(body, sort_keys=True), digest(body)))
            self._event("staged", change_id, change_digest=digest(body), action_executed=False)
        return self.change(principal, change_id)

    def change(self, principal: Principal, change_id: str) -> dict[str, Any]:
        key = self.principal_key(principal)
        if type(change_id) is not str or not re.fullmatch(r"fixture_[0-9a-f]{32}", change_id):
            raise GateClosed("unknown_change")
        row = self.db.execute("SELECT * FROM fixture_changes WHERE id=? AND principal=?", (change_id, key)).fetchone()
        if row is None:
            raise GateClosed("unknown_change")
        result = dict(row)
        result["body"] = json.loads(result["body"])
        if digest(result["body"]) != result["digest"]:
            raise GateClosed("change_integrity_failed")
        return result

    def pending(self, principal: Principal) -> list[dict[str, Any]]:
        key = self.principal_key(principal)
        ids = self.db.execute("SELECT id FROM fixture_changes WHERE principal=? AND status='staged' ORDER BY rowid", (key,)).fetchall()
        return [self.change(principal, row["id"]) for row in ids]

    def apply(self, principal: Principal, change_id: str) -> dict[str, Any]:
        # Binding + policy + expiry + write + consumption are in one transaction.
        try:
            with self.transaction():
                change = self.change(principal, change_id)
                if change["status"] == "applied":
                    return change  # Same caller, same stored result; no repeated effect/event.
                if change["status"] != "staged":
                    raise GateClosed("change_not_staged")
                policy = self.db.execute("SELECT * FROM fixture_policy WHERE id=1").fetchone()
                approval = self.db.execute("SELECT * FROM fixture_approvals WHERE change_id=?", (change_id,)).fetchone()
                if policy["paused"]:
                    raise GateClosed("policy_denied")
                if approval is None:
                    raise GateClosed("approval_required")
                if approval["revoked"] or approval["consumed"]:
                    raise GateClosed("approval_inactive")
                if approval["expires"] <= self.clock():
                    raise GateClosed("approval_expired")
                if approval["revision"] != policy["revision"] or approval["digest"] != change["digest"]:
                    raise GateClosed("approval_binding_changed")
                body = change["body"]
                # Keep this invariant local even if a fixture DB was edited.
                if body["action"] != "listing_update" or body["field"] != "title" or body["target"] != LISTING_ID or body["effect_scope"] != "fixture_sqlite":
                    raise GateClosed("title_only_fixture")
                written = self.db.execute("UPDATE fixture_listing SET title=?, version=version+1 WHERE id=? AND version=? AND title=?",
                                          (body["after"], LISTING_ID, body["version"], body["before"]))
                if written.rowcount != 1:
                    raise GateClosed("stale_listing")
                self.db.execute("UPDATE fixture_approvals SET consumed=1 WHERE change_id=?", (change_id,))
                self.db.execute("UPDATE fixture_changes SET status='applied', applied_at=? WHERE id=?", (self.clock(), change_id))
                self._event("applied", change_id, change_digest=change["digest"],
                            before_hash=digest(body["before"]), after_hash=digest(body["after"]),
                            policy_revision=policy["revision"], action_executed=True, effect_scope="fixture_sqlite")
        except GateClosed as error:
            # A denial is evidence, not an execution receipt. No untrusted IDs/text.
            self._event("denied", None, reason=str(error), action_executed=False)
            raise
        return self.change(principal, change_id)

    def discard(self, principal: Principal, change_id: str) -> dict[str, Any]:
        with self.transaction():
            change = self.change(principal, change_id)
            if change["status"] != "staged":
                raise GateClosed("change_not_staged")
            self.db.execute("UPDATE fixture_changes SET status='discarded' WHERE id=?", (change_id,))
            self.db.execute("UPDATE fixture_approvals SET revoked=1 WHERE change_id=?", (change_id,))
            self._event("discarded", change_id, action_executed=False)
        return self.change(principal, change_id)

    def evidence(self) -> dict[str, Any]:
        events = [{"sequence": row["sequence"], "kind": row["kind"], "change_ref": digest(row["change_id"]) if row["change_id"] else None, **json.loads(row["evidence_json"])}
                  for row in self.db.execute("SELECT * FROM fixture_events ORDER BY sequence")]
        return {"schema": "agoragentic.commerce.fixture-evidence.v1", "fixture_only": True,
                "effect_scope": "fixture_sqlite", "events": events,
                "spend_usdc": "0", "payment_attempted": False,
                "production_authority": False, "settlement_final": False,
                "upstream_runtime_exercised": False, "evidence_hash": digest(events)}


class FixtureHost:
    """Test-host approval surface, NOT authentication or production authorization.

    Never expose these methods as model tools. Replace the entire fixture backend
    for a real host; do not repoint it at a merchant API. Harness review artifacts
    alone must not be treated as a live capability token.
    """
    def __init__(self, store: FixtureStore):
        self.store = store

    def approve(self, change_id: str, expected_digest: str, *, ttl_seconds: int = 60) -> None:
        if type(ttl_seconds) is not int or not 1 <= ttl_seconds <= 300:
            raise ValueError("invalid_approval_ttl")
        with self.store.transaction():
            change = self.store.change(FIXTURE_PRINCIPAL, change_id)
            if change["status"] != "staged" or change["digest"] != expected_digest:
                raise GateClosed("approval_binding_changed")
            policy = self.store.db.execute("SELECT * FROM fixture_policy WHERE id=1").fetchone()
            if policy["paused"]:
                raise GateClosed("policy_denied")
            self.store.db.execute("INSERT OR REPLACE INTO fixture_approvals VALUES (?, ?, ?, ?, 0, 0)",
                                  (change_id, expected_digest, policy["revision"], self.store.clock() + ttl_seconds))
            self.store._event("approved", change_id, change_digest=expected_digest, action_executed=False)

    def revoke(self, change_id: str) -> None:
        with self.store.transaction():
            self.store.change(FIXTURE_PRINCIPAL, change_id)
            self.store.db.execute("UPDATE fixture_approvals SET revoked=1 WHERE change_id=?", (change_id,))
            self.store._event("revoked", change_id, action_executed=False)

    def set_paused(self, paused: bool) -> None:
        if type(paused) is not bool:
            raise ValueError("paused_must_be_boolean")
        self.store.db.execute("UPDATE fixture_policy SET paused=?, revision=revision+1 WHERE id=1", (int(paused),))
