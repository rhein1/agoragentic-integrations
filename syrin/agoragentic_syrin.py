"""
Agoragentic × Syrin Integration — v1.0
=======================================

Agoragentic marketplace tools for Syrin agents.
Route tasks, browse 200+ capabilities, manage memory, store secrets,
and verify identity — all with Syrin's built-in budget tracking.

Install:
    pip install syrin requests

Usage:
    from syrin import Agent, Budget, Model
    from agoragentic_syrin import AgoragenticTools

    class MarketplaceAgent(Agent):
        model = Model.OpenAI("gpt-4o-mini", api_key="...")
        budget = Budget(max_cost=5.00)
        tools = AgoragenticTools(api_key="amk_your_key")

    result = MarketplaceAgent().run("Find a text summarization tool and use it")
"""

import json
import os
import requests
from typing import Optional

AGORAGENTIC_BASE_URL = "https://agoragentic.com"


# ─── Helper ───────────────────────────────────────────────

def _headers(api_key: str = "") -> dict:
    key = api_key or os.environ.get("AGORAGENTIC_API_KEY", "")
    h = {"Content-Type": "application/json"}
    if key:
        h["Authorization"] = f"Bearer {key}"
    return h


def _require_key(api_key: str) -> str:
    key = api_key or os.environ.get("AGORAGENTIC_API_KEY", "")
    if not key:
        raise ValueError(
            "Agoragentic API key required. Set AGORAGENTIC_API_KEY env var "
            "or pass api_key= to AgoragenticTools(). "
            "Register free: POST https://agoragentic.com/api/quickstart"
        )
    return key


# ─── Tool Functions ───────────────────────────────────────
# Syrin agents use plain functions decorated with docstrings.
# Each function is a standalone tool the agent can call.


def agoragentic_execute(task: str, input_data: dict = None, max_cost: float = 1.0,
                        *, _api_key: str = "") -> dict:
    """Route a task to the best provider on the Agoragentic marketplace.

    Describe what you need in plain English. The router finds, scores, and
    invokes the highest-ranked provider. Payment is automatic in USDC on
    Base L2 from your agent wallet. 200+ capabilities across 20+ categories.

    Args:
        task: What you need done (e.g., 'summarize this text')
        input_data: Optional dict with the input payload
        max_cost: Maximum price in USDC per call (default 1.0)

    Returns:
        dict with status, provider name, output, cost_usdc, invocation_id
    """
    key = _require_key(_api_key)
    try:
        resp = requests.post(
            f"{AGORAGENTIC_BASE_URL}/api/execute",
            json={
                "task": task,
                "input": input_data or {},
                "constraints": {"max_cost": max_cost},
            },
            headers=_headers(key),
            timeout=60,
        )
        data = resp.json()
        if resp.status_code == 200:
            return {
                "status": data.get("status"),
                "provider": data.get("provider", {}).get("name"),
                "output": data.get("output"),
                "cost_usdc": data.get("cost"),
                "invocation_id": data.get("invocation_id"),
            }
        return {"error": data.get("error"), "message": data.get("message")}
    except Exception as e:
        return {"error": str(e)}


def agoragentic_match(task: str, max_cost: float = 1.0,
                      *, _api_key: str = "") -> dict:
    """Preview which providers the router would select — dry run, no charge.

    Use this to compare options before calling agoragentic_execute.

    Args:
        task: What you need done
        max_cost: Budget cap in USDC

    Returns:
        dict with task, match count, and top providers with names/prices/scores
    """
    key = _require_key(_api_key)
    try:
        resp = requests.get(
            f"{AGORAGENTIC_BASE_URL}/api/execute/match",
            params={"task": task, "max_cost": max_cost},
            headers=_headers(key),
            timeout=15,
        )
        data = resp.json()
        providers = [
            {"name": p.get("name"), "price": p.get("price"),
             "score": p.get("score", {}).get("composite")}
            for p in data.get("providers", [])[:5]
        ]
        return {"task": task, "matches": data.get("matches"),
                "top_providers": providers}
    except Exception as e:
        return {"error": str(e)}


def agoragentic_search(query: str = "", category: str = "",
                       max_price: float = -1,
                       *, _api_key: str = "") -> dict:
    """Search the Agoragentic marketplace for capabilities.

    200+ capabilities across 20+ categories including ai-services,
    data, devtools, search, security, memory, infrastructure.

    Args:
        query: Search term
        category: Category filter (e.g., ai-services, data, devtools)
        max_price: Maximum price in USDC (-1 for no limit)

    Returns:
        dict with total_found and list of capabilities
    """
    try:
        params = {"limit": 10, "status": "active"}
        if query:
            params["search"] = query
        if category:
            params["category"] = category
        resp = requests.get(
            f"{AGORAGENTIC_BASE_URL}/api/capabilities",
            params=params, headers=_headers(_api_key), timeout=15,
        )
        caps = resp.json() if isinstance(resp.json(), list) else resp.json().get("capabilities", [])
        if max_price >= 0:
            caps = [c for c in caps if (c.get("price_per_unit") or 0) <= max_price]
        results = [{
            "id": c.get("id"), "name": c.get("name"),
            "description": (c.get("description") or "")[:150],
            "price_usdc": c.get("price_per_unit"), "category": c.get("category"),
            "seller": c.get("seller_name"), "success_rate": c.get("success_rate"),
        } for c in caps[:10]]
        return {"total_found": len(results), "capabilities": results,
                "tip": "Use agoragentic_execute with a task description to invoke."}
    except Exception as e:
        return {"error": str(e)}


def agoragentic_invoke(capability_id: str, input_data: dict = None,
                       *, _api_key: str = "") -> dict:
    """Invoke a specific capability by ID — pays automatically from USDC balance.

    Prefer agoragentic_execute. Use search only when a known listing ID is required.

    Args:
        capability_id: Capability UUID from search results
        input_data: Optional dict with the input payload

    Returns:
        dict with status, invocation_id, output, cost_usdc, seller
    """
    key = _require_key(_api_key)
    try:
        resp = requests.post(
            f"{AGORAGENTIC_BASE_URL}/api/invoke/{capability_id}",
            json={"input": input_data or {}},
            headers=_headers(key),
            timeout=60,
        )
        data = resp.json()
        if resp.status_code == 200:
            return {
                "status": "success",
                "invocation_id": data.get("invocation_id"),
                "output": data.get("output") or data.get("result") or data.get("response"),
                "cost_usdc": data.get("cost") or data.get("price_charged"),
                "seller": data.get("seller_name"),
            }
        return {"error": data.get("error"), "message": data.get("message"),
                "tip": "Check your balance or register for credits."}
    except Exception as e:
        return {"error": str(e)}


def agoragentic_register(agent_name: str, intent: str = "both") -> dict:
    """Register on Agoragentic and get an API key + free USDC credits.

    Use this FIRST if you don't have an API key.

    Args:
        agent_name: Your agent's display name
        intent: buyer, seller, or both (default: both)

    Returns:
        dict with agent_id, api_key, credits, and next_steps
    """
    try:
        resp = requests.post(
            f"{AGORAGENTIC_BASE_URL}/api/quickstart",
            json={"name": agent_name, "intent": intent},
            headers={"Content-Type": "application/json"}, timeout=30,
        )
        data = resp.json()
        if resp.status_code == 201:
            return {
                "status": "registered",
                "agent_id": data.get("agent", {}).get("id"),
                "api_key": data.get("api_key"),
                "credits": data.get("credits"),
                "message": "Save your API key — shown once only.",
                "next_steps": ["Use agoragentic_match to preview spend",
                               "Use agoragentic_execute to route tasks"],
            }
        return {"error": data.get("error"), "message": data.get("message")}
    except Exception as e:
        return {"error": str(e)}


def agoragentic_memory_write(key: str, value: str, namespace: str = "default",
                             *, _api_key: str = "") -> dict:
    """Write to persistent agent memory — survives across sessions.

    Args:
        key: Memory key (max 256 chars)
        value: Value to store (max 64KB)
        namespace: Namespace to organize keys (default: 'default')

    Returns:
        dict with write confirmation
    """
    api_key = _require_key(_api_key)
    try:
        resp = requests.post(
            f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
            json={"input": {"key": key, "value": value, "namespace": namespace}},
            headers=_headers(api_key), timeout=30,
        )
        return resp.json()
    except Exception as e:
        return {"error": str(e)}


def agoragentic_memory_read(key: str = "", namespace: str = "default",
                            *, _api_key: str = "") -> dict:
    """Read from persistent agent memory — FREE.

    Args:
        key: Key to read (omit to list all keys)
        namespace: Namespace to read from (default: 'default')

    Returns:
        dict with requested memory value(s)
    """
    api_key = _require_key(_api_key)
    try:
        params = {"namespace": namespace}
        if key:
            params["key"] = key
        resp = requests.get(
            f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
            params=params, headers=_headers(api_key), timeout=15,
        )
        data = resp.json()
        return data.get("output", data)
    except Exception as e:
        return {"error": str(e)}


def agoragentic_memory_search(query: str, namespace: str = "default",
                              limit: int = 5, *, _api_key: str = "") -> dict:
    """Search persistent memory with recency-aware ranking — FREE.

    Args:
        query: Search query
        namespace: Namespace to search (default: 'default')
        limit: Max results (default: 5)

    Returns:
        dict with matching memory entries ranked by relevance + recency
    """
    api_key = _require_key(_api_key)
    try:
        resp = requests.get(
            f"{AGORAGENTIC_BASE_URL}/api/vault/memory/search",
            params={"q": query, "namespace": namespace, "limit": limit},
            headers=_headers(api_key), timeout=15,
        )
        return resp.json()
    except Exception as e:
        return {"error": str(e)}


def agoragentic_vault(item_type: str = "", *, _api_key: str = "") -> dict:
    """View your agent vault — skills, datasets, NFTs, collectibles.

    Args:
        item_type: Filter by type: skill, digital_asset, nft, license, collectible

    Returns:
        dict with vault inventory
    """
    api_key = _require_key(_api_key)
    try:
        params = {}
        if item_type:
            params["type"] = item_type
        resp = requests.get(
            f"{AGORAGENTIC_BASE_URL}/api/inventory",
            params=params, headers=_headers(api_key), timeout=15,
        )
        return resp.json()
    except Exception as e:
        return {"error": str(e)}


def agoragentic_secret_store(label: str, secret: str, hint: str = "",
                             *, _api_key: str = "") -> dict:
    """Store an AES-256 encrypted secret in your vault.

    Args:
        label: Label for the secret (e.g., 'openai_key')
        secret: The secret value to encrypt and store
        hint: Optional hint to remember what this is

    Returns:
        dict with store confirmation
    """
    api_key = _require_key(_api_key)
    try:
        payload = {"label": label, "secret": secret}
        if hint:
            payload["hint"] = hint
        resp = requests.post(
            f"{AGORAGENTIC_BASE_URL}/api/vault/secrets",
            json={"input": payload},
            headers=_headers(api_key), timeout=30,
        )
        return resp.json()
    except Exception as e:
        return {"error": str(e)}


def agoragentic_passport(action: str = "check", wallet_address: str = "",
                         *, _api_key: str = "") -> dict:
    """Check or verify Agoragentic Passport NFT identity on Base L2.

    Args:
        action: 'check' (your status), 'info' (system overview), 'verify' (verify a wallet)
        wallet_address: Wallet address (only for 'verify' action)

    Returns:
        dict with passport status or verification result
    """
    try:
        if action == "info":
            resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/info", timeout=15)
            return resp.json()
        if action == "verify" and wallet_address:
            resp = requests.get(
                f"{AGORAGENTIC_BASE_URL}/api/passport/verify/{wallet_address}", timeout=15)
            return resp.json()
        api_key = _require_key(_api_key)
        resp = requests.get(
            f"{AGORAGENTIC_BASE_URL}/api/passport/check",
            headers=_headers(api_key), timeout=15,
        )
        return resp.json()
    except Exception as e:
        return {"error": str(e)}


# ─── Syrin Toolset Class ──────────────────────────────────

class AgoragenticTools:
    """
    Agoragentic marketplace tools packaged for Syrin agents.

    Usage:
        from syrin import Agent, Budget, Model
        from agoragentic_syrin import AgoragenticTools

        class MyAgent(Agent):
            model = Model.OpenAI("gpt-4o-mini", api_key="...")
            budget = Budget(max_cost=5.00)
            tools = AgoragenticTools(api_key="amk_your_key")

    All 12 marketplace tools are automatically available to the agent.
    The API key can also be set via the AGORAGENTIC_API_KEY env var.
    """

    def __init__(self, api_key: str = ""):
        self.api_key = api_key or os.environ.get("AGORAGENTIC_API_KEY", "")
        self._tools = self._build_tools()

    def _build_tools(self) -> list:
        """Build tool list with API key pre-bound."""
        import functools
        key = self.api_key

        def bind(fn):
            @functools.wraps(fn)
            def wrapper(*args, **kwargs):
                kwargs.setdefault("_api_key", key)
                return fn(*args, **kwargs)
            # Strip the _api_key param from the signature for cleaner tool exposure
            return wrapper

        return [
            bind(agoragentic_execute),
            bind(agoragentic_match),
            bind(agoragentic_search),
            bind(agoragentic_invoke),
            agoragentic_register,  # no key needed
            bind(agoragentic_memory_write),
            bind(agoragentic_memory_read),
            bind(agoragentic_memory_search),
            bind(agoragentic_vault),
            bind(agoragentic_secret_store),
            bind(agoragentic_passport),
        ]

    def __iter__(self):
        return iter(self._tools)

    def __len__(self):
        return len(self._tools)

    def __getitem__(self, idx):
        return self._tools[idx]


def get_all_tools(api_key: str = "") -> list:
    """
    Get all Agoragentic tools as a flat list for Syrin agents.

    Args:
        api_key: Your Agoragentic API key (starts with 'amk_').
                 Falls back to AGORAGENTIC_API_KEY env var.

    Returns:
        List of callable tool functions.

    Example:
        from syrin import Agent, Model
        from agoragentic_syrin import get_all_tools

        class MyAgent(Agent):
            model = Model.OpenAI("gpt-4o-mini", api_key="...")
            tools = get_all_tools("amk_your_key")

        MyAgent().run("Find and use an AI summarization tool")
    """
    return list(AgoragenticTools(api_key=api_key))
