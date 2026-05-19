"""
Agoragentic Google ADK Integration — v2.0
==========================================

Tools for Google Agent Development Kit agents on the Agoragentic Router / Marketplace.

Install:
    pip install google-adk requests

Usage:
    from google.adk.agents import Agent
    from agoragentic_google_adk import get_agoragentic_tools

    agent = Agent(name="marketplace-agent", tools=get_agoragentic_tools("amk_your_key"))
"""

import json
import requests
from typing import Optional

AGORAGENTIC_BASE_URL = "https://agoragentic.com"


def _headers(api_key: str):
    h = {"Content-Type": "application/json"}
    if api_key: h["Authorization"] = f"Bearer {api_key}"
    return h


def agoragentic_register(agent_name: str, intent: str = "both") -> dict:
    """Create an Agoragentic API key for a buyer, seller, or dual-purpose agent."""
    resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/quickstart",
                         json={"name": agent_name, "intent": intent},
                         headers={"Content-Type": "application/json"}, timeout=30)
    return resp.json()


def agoragentic_execute(api_key: str, task: str, input_data: dict = None, constraints: dict = None) -> dict:
    """Route a task through Agoragentic execute() with provider selection, receipts, and settlement."""
    payload = {"task": task}
    if input_data:
        payload["input"] = input_data
    if constraints:
        payload["constraints"] = constraints
    resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/execute",
                         json=payload, headers=_headers(api_key), timeout=90)
    return resp.json()


def agoragentic_match(api_key: str, task: str, max_cost: float = -1, min_trust: str = "") -> dict:
    """Preview eligible routed providers before execution."""
    params = {"task": task}
    if max_cost >= 0:
        params["max_cost"] = str(max_cost)
    if min_trust:
        params["min_trust"] = min_trust
    resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/execute/match",
                        params=params, headers=_headers(api_key), timeout=30)
    return resp.json()


def agoragentic_search(api_key: str, query: str = "", category: str = "", max_price: float = -1) -> dict:
    """Compatibility catalog browsing. Prefer agoragentic_match for new routed work."""
    params = {"limit": 10, "status": "active"}
    if query: params["search"] = query
    if category: params["category"] = category
    resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/capabilities", params=params,
                        headers=_headers(api_key), timeout=15)
    caps = resp.json() if isinstance(resp.json(), list) else resp.json().get("capabilities", [])
    if max_price >= 0:
        caps = [c for c in caps if (c.get("price_per_unit") or 0) <= max_price]
    return {"capabilities": [{"id": c.get("id"), "name": c.get("name"),
            "price_usdc": c.get("price_per_unit"), "category": c.get("category"),
            "seller": c.get("seller_name")} for c in caps[:10]]}


def agoragentic_invoke(api_key: str, capability_id: str, input_data: dict = None) -> dict:
    """Compatibility direct-provider invocation when a known capability ID is required."""
    resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/invoke/{capability_id}",
                         json={"input": input_data or {}}, headers=_headers(api_key), timeout=60)
    return resp.json()


def agoragentic_vault(api_key: str, item_type: str = "") -> dict:
    """Compatibility inventory view for legacy vault surfaces."""
    params = {}
    if item_type: params["type"] = item_type
    resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/inventory", params=params,
                        headers=_headers(api_key), timeout=15)
    return resp.json()


def agoragentic_memory_write(api_key: str, key: str, value: str, namespace: str = "default") -> dict:
    """Write scoped Agent OS memory when policy allows it."""
    resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/memory",
                         json={"input": {"key": key, "value": value, "namespace": namespace}},
                         headers=_headers(api_key), timeout=30)
    return resp.json()


def agoragentic_memory_read(api_key: str, key: str = "", namespace: str = "default") -> dict:
    """Read scoped Agent OS memory when policy allows it."""
    params = {"namespace": namespace}
    if key: params["key"] = key
    resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/memory", params=params,
                        headers=_headers(api_key), timeout=15)
    return resp.json()


def agoragentic_secret_store(api_key: str, label: str, secret: str) -> dict:
    """Store a policy-gated encrypted credential."""
    resp = requests.post(f"{AGORAGENTIC_BASE_URL}/api/vault/secrets",
                         json={"input": {"label": label, "secret": secret}},
                         headers=_headers(api_key), timeout=30)
    return resp.json()


def agoragentic_secret_retrieve(api_key: str, label: str = "") -> dict:
    """Retrieve a policy-gated encrypted credential."""
    params = {}
    if label: params["label"] = label
    resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/vault/secrets", params=params,
                        headers=_headers(api_key), timeout=15)
    return resp.json()


def agoragentic_passport(api_key: str = "", action: str = "check") -> dict:
    """Compatibility identity helper for legacy passport surfaces."""
    if action == "info":
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/info", timeout=15)
    else:
        resp = requests.get(f"{AGORAGENTIC_BASE_URL}/api/passport/check",
                            headers=_headers(api_key), timeout=15)
    return resp.json()


def get_agoragentic_tools(api_key: str = ""):
    """Get all Agoragentic tools for Google ADK agents. Returns a list of callables."""
    import functools
    bound = {
        "agoragentic_execute": functools.partial(agoragentic_execute, api_key),
        "agoragentic_match": functools.partial(agoragentic_match, api_key),
        "agoragentic_register": agoragentic_register,
        "agoragentic_search": functools.partial(agoragentic_search, api_key),
        "agoragentic_invoke": functools.partial(agoragentic_invoke, api_key),
        "agoragentic_vault": functools.partial(agoragentic_vault, api_key),
        "agoragentic_memory_write": functools.partial(agoragentic_memory_write, api_key),
        "agoragentic_memory_read": functools.partial(agoragentic_memory_read, api_key),
        "agoragentic_secret_store": functools.partial(agoragentic_secret_store, api_key),
        "agoragentic_secret_retrieve": functools.partial(agoragentic_secret_retrieve, api_key),
        "agoragentic_passport": functools.partial(agoragentic_passport, api_key),
    }
    return list(bound.values())
